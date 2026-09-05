/**
 * Which names a closure body reads from the function around it.
 *
 * DECISIONS §18. A `LocalFn`'s environment holds one reference per captured
 * local, so the first thing lowering a closure needs is the list — and getting
 * it wrong is not a diagnostic, it is a closure that reads a field that is not
 * there.
 *
 * **Asked of tsc, not of a name walk.** The tempting version collects every
 * name declared anywhere inside the closure and treats the rest as captures.
 * That is wrong in one specific shape, and silently:
 *
 *     (x) => { total += x; { const total = 0; } }
 *
 * `total` is both captured *and* declared inside — in a nested block, so the
 * outer read is a real capture that a flat name set would drop. tsc has already
 * resolved every identifier here against the real lexical scoping, so asking it
 * which declaration a name refers to is both shorter and correct.
 */

import ts from "typescript";

/**
 * The names a closure reads from an enclosing scope, in source order and
 * without repeats.
 *
 * Includes names that are not locals at all — a top-level function, an enum
 * member — because this cannot tell the difference and does not need to: the
 * caller keeps the ones its scope stack knows and lets the ordinary paths
 * handle the rest.
 */
export function capturedNames(
    fn: ts.ArrowFunction | ts.FunctionExpression,
    checker: ts.TypeChecker,
): string[] {
    const found = new Set<string>();

    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && namesAValue(node)) {
            const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
            if (declaration !== undefined && !within(declaration, fn)) {
                found.add(node.text);
            }
        }
        ts.forEachChild(node, visit);
    };

    // The body only. A parameter's *name* is a declaration rather than a read,
    // and a parameter's default value cannot exist — the lowerer refuses one.
    visit(fn.body);
    return [...found];
}

/**
 * Whether an identifier is a name being read, rather than one being written
 * down.
 *
 * The property accesses are the ones that matter. `p.x` gives `x` a symbol
 * whose declaration is the field, which is outside the closure and outside the
 * enclosing function too — so counting it would capture a name that is not a
 * local and does not exist in any scope.
 */
function namesAValue(node: ts.Identifier): boolean {
    const parent = node.parent as ts.Node | undefined;
    if (parent === undefined) {
        return false;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
        return false;
    }
    if (ts.isQualifiedName(parent) && parent.right === node) {
        return false;
    }
    if (ts.isPropertyAssignment(parent) && parent.name === node) {
        return false;
    }
    if (ts.isBindingElement(parent) && parent.propertyName === node) {
        return false;
    }
    return !(ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent));
}

/**
 * Whether a closure body reads the enclosing method's `this`.
 *
 * Separate from {@link capturedNames} because `this` is a keyword rather than an
 * identifier, so no symbol lookup answers it — but it is otherwise an ordinary
 * capture. It is already a `Reference<Self>` local (REWRITE-PLAN §4.6), which is
 * what lets it travel through the environment with no second mechanism: the
 * closure captures the local holding the reference, exactly as it captures any
 * other local.
 *
 * This reports what the body *reads*, and says nothing about whether reading it
 * is allowed — a `function` expression binds its own `this` and so may not
 * capture the enclosing one, but that is a rule for {@link liftClosure} to
 * state, with a message about the form. Answering `false` here instead would
 * hide the question and leave the reader with a complaint about scope.
 */
export function usesThis(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
    let found = false;
    const visit = (node: ts.Node): void => {
        if (found) {
            return;
        }
        if (node.kind === ts.SyntaxKind.ThisKeyword) {
            found = true;
            return;
        }
        // Do not descend into anything that binds a `this` of its own: a `this`
        // down there is a different one, and capturing on its behalf would put
        // the wrong object in the environment.
        if (rebindsThis(node)) {
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return found;
}

/**
 * The declared `this` parameter — `function (this: Box) { … }`, or a method's
 * `area(this: Reference<Circle>): f64` — or `undefined`.
 *
 * TypeScript models a declared `this` as `parameters[0]` rather than as a field
 * of its own, so anything reading `node.parameters` as the written parameters is
 * off by one the moment somebody writes it. tsc's *signature* excludes it, which
 * is where the two disagree: the arity check compared a signature without it
 * against an AST with it and reported the disagreement as a compiler gap.
 *
 * A method's parameters are worse than off by one, because they are also
 * *numbered*: the receiver is local 1 and the written parameters start at 2, so
 * a `this` left in the list would both shadow the receiver's binding and shift
 * every argument by one slot. Every collector has to drop it, which is why this
 * takes any signature rather than only the two closure forms it was written for.
 *
 * `this` is a reserved word, so a parameter cannot be named it by accident and
 * the name is a sound test.
 */
export function thisParameterOf(
    fn: ts.SignatureDeclaration,
): ts.ParameterDeclaration | undefined {
    const first = fn.parameters[0];
    if (first !== undefined && ts.isIdentifier(first.name) && first.name.text === "this") {
        return first;
    }
    return undefined;
}

function rebindsThis(node: ts.Node): boolean {
    return (
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
    );
}

/**
 * Whether a lambda is being written as an argument to a call.
 *
 * The one position where a `LocalFn`'s environment — a temporary of the
 * enclosing full-expression — is guaranteed to outlive every use of it, because
 * the call happens inside that full-expression.
 *
 * Parentheses are walked through: `f(((x) => x))` is the same argument as
 * `f((x) => x)`, and lowering has already unwrapped them by the time the lambda
 * is reached.
 */
export function isCallArgument(node: ts.Expression): boolean {
    let current: ts.Expression = node;
    while (ts.isParenthesizedExpression(current.parent)) {
        current = current.parent;
    }
    const parent = current.parent as ts.Node | undefined;
    return (
        parent !== undefined &&
        (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        (parent.arguments?.some((argument) => argument === current) ?? false)
    );
}

/** Whether `node` is lexically inside `ancestor`. By parent links, not by position. */
function within(node: ts.Node, ancestor: ts.Node): boolean {
    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
        if (current === ancestor) {
            return true;
        }
    }
    return false;
}
