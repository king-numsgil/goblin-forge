/**
 * The width pass: what an expression's type is *on its own terms*.
 *
 * Bottom-up and memoised, and the only place a width diagnostic is raised. It
 * answers one of three things — a definite type, **polymorphic** (built only
 * from literals, so it takes its width from context), or an error already
 * reported — and `lower/body.ts` then lowers top-down with the expected type in
 * hand. `../lower.ts` says why the two passes are separate; this file is the
 * first of them.
 */

import type { Operand, Place } from "@goblin-forge/backend";
import {
    commonType,
    erase,
    isFloatType,
    isMachineComparable,
    type MachineType,
    type Operator,
    type OperatorInfo,
    OPERATORS,
    renderType,
    sameType,
} from "@goblin-forge/checker";
import ts from "typescript";
import type { ClassInfo, StaticMethod } from "../classes.ts";
import {
    ALLOC,
    ALLOC_ARRAY,
    CONSOLE_METHODS,
    CSTRING,
    CSTRING_FREE,
    FIXED_ARRAY,
    MOVE,
    NATIVE_ALIGN_OF,
    NATIVE_CAST,
    NATIVE_SIZE_OF,
    NATIVE_ZEROED,
    OPERATOR_TOKENS,
    POINTER_ADDRESS,
    POINTER_METHODS,
    STRING_FROM_BYTES,
    STRING_FROM_CSTRING,
    TRY_CAST,
} from "./tables.ts";
import { CSTRING_TYPE, ERROR, POLY, STRING, type Typed, typed, USIZE, VOID, type Width } from "./types.ts";
import { describe, elementTypeOf, isStaticMember } from "./util.ts";
import { Emitter } from "./emit.ts";

export abstract class WidthPass extends Emitter {
    /** Memoised {@link width} results, so each node is judged — and reported — once. */
    protected readonly widths = new Map<ts.Node, Width>();

    /**
     * The width an expression has on its own terms.
     *
     * Memoised, and the only place a width diagnostic is raised — the lowering
     * walk that follows consults this rather than re-deriving anything, so no
     * error is reported twice and no rule is applied in two places.
     */
    width(expression: ts.Expression): Width {
        const cached = this.widths.get(expression);
        if (cached !== undefined) {
            return cached;
        }
        const computed = this.#computeWidth(expression);
        this.widths.set(expression, computed);
        return computed;
    }

    #computeWidth(expression: ts.Expression): Width {
        if (ts.isParenthesizedExpression(expression)) {
            return this.width(expression.expression);
        }

        // A literal has no width of its own; it takes one from wherever it lands.
        if (ts.isNumericLiteral(expression)) {
            return POLY;
        }

        // A string literal does: there is only one string type.
        if (ts.isStringLiteralLike(expression)) {
            return typed(STRING);
        }
        if (ts.isTemplateExpression(expression)) {
            return typed(STRING);
        }

        if (ts.isPropertyAccessExpression(expression)) {
            return this.#propertyWidth(expression);
        }
        if (ts.isElementAccessExpression(expression)) {
            return this.#elementWidth(expression);
        }
        // An object literal has no type of its own, the same way a numeric literal
        // has no width of its own: it is an initialiser for whatever struct is
        // expected. Erasing what tsc infers for it in isolation gives an anonymous
        // shape whose fields are plain `number`, which is both wrong and unhelpful.
        if (ts.isObjectLiteralExpression(expression)) {
            return POLY;
        }

        // `null` has no type of its own either, and for a stronger reason than a
        // numeric literal has no width: there is nothing to erase. It is the null
        // value of whichever handle is expected, and which handles have one is
        // {@link #null}'s rule.
        if (expression.kind === ts.SyntaxKind.NullKeyword) {
            return POLY;
        }

        if (
            expression.kind === ts.SyntaxKind.TrueKeyword ||
            expression.kind === ts.SyntaxKind.FalseKeyword
        ) {
            return typed({kind: "bool"});
        }

        if (ts.isIdentifier(expression)) {
            const binding = this.scopes.lookup(expression.text);
            if (binding === undefined) {
                // A function named rather than called: its address, typed by tsc as a
                // function type, which erasure turns into a `fnptr`.
                if (this.outer.functionValueAt(expression) !== undefined) {
                    return this.#erasedWidth(expression);
                }
                this.outer.unsupported(expression, `the name \`${expression.text}\``);
                return ERROR;
            }
            return typed(binding.type);
        }

        // A ternary has whatever type its arms agree on. Either arm may be built
        // only from literals and take its width from the other — or from context,
        // when both are.
        if (ts.isConditionalExpression(expression)) {
            if (this.width(expression.condition).kind === "error") {
                return ERROR;
            }
            const whenTrue = this.width(expression.whenTrue);
            const whenFalse = this.width(expression.whenFalse);
            if (whenTrue.kind === "error" || whenFalse.kind === "error") {
                return ERROR;
            }
            if (whenTrue.kind === "poly") {
                return whenFalse;
            }
            if (whenFalse.kind === "poly") {
                return whenTrue;
            }
            if (!sameType(whenTrue.type, whenFalse.type)) {
                this.outer.error(
                    expression,
                    "GF0161",
                    `the two arms of this conditional are a \`${renderType(whenTrue.type)}\` and ` +
                    `a \`${renderType(whenFalse.type)}\`. Both arms have to produce the same ` +
                    "type, because the expression has one.",
                );
                return ERROR;
            }
            return whenTrue;
        }

        if (ts.isPrefixUnaryExpression(expression)) {
            if (expression.operator === ts.SyntaxKind.ExclamationToken) {
                return typed({kind: "bool"});
            }
            return this.width(expression.operand);
        }

        if (expression.kind === ts.SyntaxKind.ThisKeyword) {
            const binding = this.scopes.lookup("this");
            if (binding === undefined) {
                this.outer.error(
                    expression,
                    "GF0002",
                    "`this` is only meaningful inside a method or a constructor.",
                );
                return ERROR;
            }
            return typed(binding.type);
        }

        if (ts.isNewExpression(expression)) {
            if (!ts.isIdentifier(expression.expression)) {
                this.outer.unsupported(expression, "an expression after `new`");
                return ERROR;
            }
            const name = expression.expression.text;
            if (this.outer.classInfo(name) === undefined) {
                this.outer.unsupported(expression, `\`new ${name}\``);
                return ERROR;
            }
            return typed({kind: "class", name});
        }

        // `[a, b, c]` — the type comes from tsc, not from the elements, because
        // `[]` has no element to ask and the annotation is what says what it is.
        if (ts.isArrayLiteralExpression(expression)) {
            const type = this.outer.erase(
                expression,
                this.outer.checker.getContextualType(expression) ??
                this.outer.checker.getTypeAtLocation(expression),
            );
            if (type === undefined) {
                return ERROR;
            }
            if (type.kind !== "array") {
                this.outer.unsupported(expression, `an array literal of \`${renderType(type)}\``);
                return ERROR;
            }
            for (const element of expression.elements) {
                if (this.width(element).kind === "error") {
                    return ERROR;
                }
            }
            return typed(type);
        }

        if (ts.isCallExpression(expression)) {
            return this.#callWidth(expression);
        }
        if (ts.isBinaryExpression(expression)) {
            return this.#binaryWidth(expression);
        }

        this.outer.unsupported(expression, describe(expression));
        return ERROR;
    }

    /** `s.length` on a string, or a field of a struct or a class. */
    #propertyWidth(expression: ts.PropertyAccessExpression): Width {
        // An enum member's width is the enum's, which erasure already knows how to
        // find. First, because `E` is a type and the paths below all start by
        // asking what `expression.expression` is worth as a value.
        if (this.outer.enumMemberAt(expression) !== undefined) {
            return this.#erasedWidth(expression);
        }

        // `p.address`, before everything, and for the reason the pointer *methods*
        // come before the class path: `Pointer<C>` is `C & CorePointer<C>`, so a
        // field of that name on the pointee would be found first. There is never
        // such a field — `RESERVED_ON_POINTER` refuses one at the declaration — and
        // this is the half of that rule that makes it worth having.
        if (
            expression.name.text === POINTER_ADDRESS &&
            this.outer.tryErase(expression.expression)?.kind === "pointer"
        ) {
            return typed(USIZE);
        }

        // Before the general path, and asked of tsc rather than of the width pass,
        // so that a field reached through a `Reference<C>` resolves the same way a
        // field of a value does.
        // `C.f` as a value — a static method's address. Before the class-field
        // path, because `C` here is a class *name* rather than an object.
        if (this.staticAt(expression) !== undefined) {
            return this.#erasedWidth(expression);
        }

        // `C.x` where `x` is `static get x()`: a call, and its type is what the
        // accessor returns.
        const staticGet = this.staticAccessorAt(expression, false);
        if (staticGet !== undefined) {
            const returns = this.outer.accessorType(staticGet.accessor);
            return returns === undefined ? ERROR : typed(returns);
        }
        const staticSet = this.staticAccessorAt(expression, true);
        if (staticSet !== undefined) {
            this.outer.error(
                expression,
                "GF0002",
                `\`${staticSet.info.name}.${expression.name.text}\` is a static setter with ` +
                `no getter, so it can be written and not read. Add ` +
                `\`static get ${expression.name.text}()\` if it should be.`,
            );
            return ERROR;
        }

        const className = this.outer.classNameAt(expression.expression);
        if (className !== undefined) {
            const info = this.outer.classInfo(className);
            const field = info?.fields.find((f) => f.name === expression.name.text);
            if (field !== undefined) {
                return typed(field.type);
            }
            // `x.name` where `name` is `get name()`: a call, and its type is what the
            // getter returns.
            const getter = info?.getters.get(expression.name.text);
            if (getter !== undefined) {
                const returns = this.outer.accessorType(getter);
                return returns === undefined ? ERROR : typed(returns);
            }
            // The mirror of assigning to a getter that has no setter. tsc lets a
            // write-only accessor be read — it gives back `undefined`, which is not a
            // type this language has — so this is the compiler's to refuse.
            if (info?.setters.has(expression.name.text) === true) {
                this.outer.error(
                    expression,
                    "GF0002",
                    `\`${className}.${expression.name.text}\` is a setter with no getter, ` +
                    `so it can be written and not read. Add \`get ${expression.name.text}()\` ` +
                    "if it should be.",
                );
                return ERROR;
            }
            if (info?.methods.has(expression.name.text) === true) {
                this.outer.unsupported(expression, "a method used as a value");
                return ERROR;
            }
            this.outer.unsupported(expression, `\`${className}.${expression.name.text}\``);
            return ERROR;
        }

        const subject = this.width(expression.expression);
        if (subject.kind === "error") {
            return ERROR;
        }
        if (subject.kind !== "typed") {
            this.outer.unsupported(expression, "this property access");
            return ERROR;
        }

        if (subject.type.kind === "string" || subject.type.kind === "cstring") {
            if (expression.name.text === "length") {
                return typed(USIZE);
            }
            this.outer.unsupported(
                expression,
                `\`${renderType(subject.type)}.${expression.name.text}\``,
            );
            return ERROR;
        }

        const array =
            subject.type.kind === "reference" ? subject.type.referent : subject.type;
        if (array.kind === "array" || array.kind === "fixedArray") {
            if (expression.name.text === "length") {
                return typed(USIZE);
            }
            this.outer.unsupported(expression, `\`${expression.name.text}\` on an array`);
            return ERROR;
        }

        // A `Pointer<S>` reaches a struct's fields the same way it reaches a
        // class's: one dereference, written by nobody.
        const pointed =
            subject.type.kind === "pointer" && subject.type.pointee.kind === "struct"
                ? subject.type.pointee
                : subject.type;
        if (pointed.kind === "struct") {
            const field = pointed.fields.find((f) => f.name === expression.name.text);
            if (field === undefined) {
                this.outer.unsupported(expression, `the field \`${expression.name.text}\``);
                return ERROR;
            }
            return typed(field.type);
        }

        this.outer.unsupported(expression, "this property access");
        return ERROR;
    }

    /** `xs[i]` — the element type of whatever is being indexed. */
    #elementWidth(expression: ts.ElementAccessExpression): Width {
        const subject = this.width(expression.expression);
        if (subject.kind === "error") {
            return ERROR;
        }
        if (subject.kind !== "typed") {
            this.outer.unsupported(expression, "indexing this");
            return ERROR;
        }
        const through =
            subject.type.kind === "reference" ? subject.type.referent : subject.type;
        const element = elementTypeOf(through);
        if (element === undefined) {
            this.outer.unsupported(
                expression,
                `indexing a \`${renderType(subject.type)}\``,
            );
            return ERROR;
        }
        if (this.width(expression.argumentExpression).kind === "error") {
            return ERROR;
        }
        return typed(element);
    }

    /** The index of a field in its struct, which is its position in the layout. */
    protected fieldIndex(type: Extract<MachineType, { kind: "struct" }>, name: string): number {
        return type.fields.findIndex((field) => field.name === name);
    }

    /**
     * Whether `xs.m(…)` is a call on a `T[]`, and what `T` is.
     *
     * Asked of **tsc**, never of the width pass, for the reason the method-call
     * path already documents about `console`: the width pass *reports*, so
     * running it over a receiver that turns out not to be an array raises a
     * diagnostic about a name before anything has decided this was not an array
     * call at all. `console.log` is a property access too.
     */
    protected arrayElementAt(access: ts.PropertyAccessExpression): MachineType | undefined {
        return this.outer.arrayElementAt(access.expression);
    }

    /**
     * A callee that is a *value* of function-pointer type rather than a name.
     *
     * A local holding a callback, a struct field, an element of an array. Not a
     * function's own name: `f(1)` where `f` is a declaration is a direct call,
     * and turning it into an indirect one would take its address for no reason
     * and force the C convention on it.
     */
    protected callableValue(
        expression: ts.Expression,
    ): { value: Typed; type: Extract<MachineType, { kind: "fnptr" }> } | undefined {
        if (this.outer.namesADeclaredFunction(expression)) {
            return undefined;
        }
        if (this.outer.functionValueAt(expression) !== undefined) {
            return undefined;
        }
        // A **method** is not a function-pointer value, even though tsc gives
        // `c.speak` a function type. It needs a receiver, and a `FnPtr` has nowhere
        // to put one — so `c.speak()` is a virtual call and only a *field* holding
        // a code address is an indirect one. This is the distinction the README
        // draws between a method signature and a function-typed property, arriving
        // where it decides how a call is emitted.
        if (ts.isPropertyAccessExpression(expression) && this.#namesAMethod(expression)) {
            return undefined;
        }
        // Asked of tsc and silently, never of the width pass: this runs over every
        // call's callee, including `console.log`, whose receiver has no machine
        // type and would be reported as an unresolvable name.
        const type = this.outer.tryErase(expression);
        if (type?.kind !== "fnptr") {
            return undefined;
        }
        const value = this.value(expression, type);
        return value === undefined ? undefined : {value, type};
    }

    /**
     * `f` or `C.f` as a value: the function's address.
     *
     * A constant, not a load — the address is a link-time fact, so this is the
     * same kind of thing a string literal is.
     */
    protected functionValue(expression: ts.Expression, natural: MachineType): Typed | undefined {
        const target = this.outer.functionValueAt(expression);
        if (target === undefined) {
            return undefined;
        }
        if (natural.kind !== "fnptr") {
            this.outer.error(
                expression,
                "GF0161",
                `this names a function, so it is a code address; it cannot be a ` +
                `\`${renderType(natural)}\`.`,
            );
            return undefined;
        }
        return {
            operand: {
                kind: "Const",
                value: {
                    kind: "Func",
                    func:
                        target.kind === "defined"
                            ? {kind: "Local", value: target.id}
                            : {kind: "Extern", value: this.outer.externIdOf(target)},
                    ty: this.outer.tyOf(natural, expression),
                },
            },
            type: natural,
        };
    }

    /**
     * Whether `x.name` names a method rather than a data member.
     *
     * Asked of the declaration, not of the type: `speak(): string` and
     * `speak: () => string` have the same type and are different things, which is
     * exactly the shape/contract distinction the language draws at the
     * declaration and has to keep drawing here.
     */
    #namesAMethod(access: ts.PropertyAccessExpression): boolean {
        const symbol = this.outer.checker.getSymbolAtLocation(access.name);
        return (
            symbol?.declarations?.some(
                (declaration) =>
                    (ts.isMethodDeclaration(declaration) && !isStaticMember(declaration)) ||
                    ts.isMethodSignature(declaration),
            ) ?? false
        );
    }

    /** The width of an expression, taken from tsc's type for it. */
    #erasedWidth(expression: ts.Expression): Width {
        const type = this.outer.erase(
            expression,
            this.outer.checker.getTypeAtLocation(expression),
        );
        return type === undefined ? ERROR : typed(type);
    }

    /**
     * `C.f` where `C` names a class and `f` is one of its `static` methods.
     *
     * Resolved from the *name*, never from a value: `C` is a class, not an
     * object, so asking the width pass for its type would report a name that
     * does not resolve — the same trap `console.log` sets for the method-call
     * path.
     */
    protected staticAt(access: ts.PropertyAccessExpression): StaticMethod | undefined {
        if (!ts.isIdentifier(access.expression)) {
            return undefined;
        }
        const info = this.outer.classInfo(access.expression.text);
        return info?.statics.get(access.name.text);
    }

    /**
     * `C.x` where `x` is a `static get`, or `C.x = v` where it is a `static set`.
     *
     * Resolved from the name for the same reason {@link #staticAt} is: `C` is a
     * class rather than an object, so asking the width pass for its type would
     * report a name that does not resolve.
     */
    protected staticAccessorAt(
        access: ts.PropertyAccessExpression,
        writing: boolean,
    ): { accessor: StaticMethod; info: ClassInfo } | undefined {
        if (!ts.isIdentifier(access.expression)) {
            return undefined;
        }
        const info = this.outer.classInfo(access.expression.text);
        if (info === undefined) {
            return undefined;
        }
        const accessor = writing
            ? info.staticSetters.get(access.name.text)
            : info.staticGetters.get(access.name.text);
        return accessor === undefined ? undefined : {accessor, info};
    }

    /** A static accessor, called: a direct call with no receiver at all. */
    protected staticAccessorCall(
        at: ts.PropertyAccessExpression,
        accessor: StaticMethod,
        args: readonly ts.Expression[],
    ): Typed | undefined {
        const record = this.outer.fn(accessor.symbol);
        if (record === undefined || record.kind !== "defined") {
            this.outer.unsupported(at, `a call to \`${accessor.symbol}\``);
            return undefined;
        }
        const marshalled: Operand[] = [];
        for (const [index, argument] of args.entries()) {
            const value = this.expressionTyped(argument, record.signature.params[index]!.type);
            if (value === undefined) {
                return undefined;
            }
            marshalled.push(this.forArgument(argument, value));
        }
        return this.emitCall(
            at,
            {kind: "Direct", value: {kind: "Local", value: record.id}},
            marshalled,
            record.signature.returns,
        );
    }

    /**
     * The array a value denotes, seeing through one `Reference<T[]>`.
     *
     * The same job `#asClass` does for objects, and it exists for the same
     * reason: a reference is the *address of the handle*, so reaching the
     * elements is one `Deref` further down than it is from the array itself.
     * Nothing is ever retyped — the projection says which indirection is which.
     */
    protected asArray(at: ts.Node, subject: Typed): { place: Place; element: MachineType } | undefined {
        const type = subject.type;
        const array =
            type.kind === "array"
                ? type
                : type.kind === "reference" && type.referent.kind === "array"
                    ? type.referent
                    : undefined;
        if (array === undefined) {
            return undefined;
        }

        const place = this.placeOfSubject(at, subject);
        if (place === undefined) {
            return undefined;
        }
        return {
            place:
                type.kind === "reference"
                    ? {local: place.local, projection: [...place.projection, {kind: "Deref"}]}
                    : place,
            element: array.element,
        };
    }

    #callWidth(expression: ts.CallExpression): Width {
        // A constructor returns nothing; `super(…)` is a statement.
        if (expression.expression.kind === ts.SyntaxKind.SuperKeyword) {
            return typed(VOID);
        }

        // A call through a value of function-pointer type. Its return type is the
        // type's, not any declaration's — there may be no declaration in this
        // build. Probed silently, and first, for the reasons `#call` gives.
        const callee = expression.expression;
        const callable = this.outer.tryErase(callee);
        if (
            callable?.kind === "fnptr" &&
            !this.outer.namesADeclaredFunction(callee) &&
            this.outer.functionValueAt(callee) === undefined &&
            !(ts.isPropertyAccessExpression(callee) && this.#namesAMethod(callee))
        ) {
            for (const argument of expression.arguments) {
                if (this.width(argument).kind === "error") {
                    return ERROR;
                }
            }
            return typed(callable.returns);
        }

        if (ts.isPropertyAccessExpression(expression.expression)) {
            const method = this.#methodWidth(expression, expression.expression);
            if (method !== "not-a-method") {
                return method;
            }
            return this.#consoleWidth(expression);
        }
        if (!ts.isIdentifier(expression.expression)) {
            this.outer.unsupported(expression.expression, "this call target");
            return ERROR;
        }
        // `alloc(C, …)`, `sizeOf<T>()`, `alignOf<T>()` — the type is
        // the call's own, which tsc has already worked out.
        // `allocArray<T>(n)` — separately, because its *first* argument is the
        // count rather than a class name to be skipped.
        if (expression.expression.text === ALLOC_ARRAY) {
            for (const argument of expression.arguments) {
                if (this.width(argument).kind === "error") {
                    return ERROR;
                }
            }
            return this.#erasedWidth(expression);
        }

        if (
            expression.expression.text === ALLOC ||
            expression.expression.text === NATIVE_SIZE_OF ||
            expression.expression.text === NATIVE_ALIGN_OF ||
            expression.expression.text === NATIVE_ZEROED
        ) {
            for (const argument of expression.arguments.slice(1)) {
                if (this.width(argument).kind === "error") {
                    return ERROR;
                }
            }
            return this.#erasedWidth(expression);
        }

        if (expression.expression.text === NATIVE_CAST) {
            // The target width is the call's own type, which tsc has already
            // resolved from the type argument. Reading it from there rather than
            // from `typeArguments` means an aliased or inferred `T` still works.
            const target = this.outer.erase(
                expression,
                this.outer.checker.getTypeAtLocation(expression),
            );
            return target === undefined ? ERROR : typed(target);
        }

        if (expression.expression.text === FIXED_ARRAY) {
            // The *contextual* type first. `fixedArray(4, 0)` infers `T` from the
            // literal `0`, which is a plain `number` and has no width — the
            // annotation on the binding is what says `i32`, and it is the answer that
            // matters.
            const type = this.outer.erase(
                expression,
                this.outer.checker.getContextualType(expression) ??
                this.outer.checker.getTypeAtLocation(expression),
            );
            return type === undefined ? ERROR : typed(type);
        }

        // `tryCast<T>(x)` is a `Reference<T>`, nullable. The nullability is tsc's
        // business and never reaches the machine type: the pair is the same
        // sixteen bytes either way, with a zero itab meaning "no".
        if (expression.expression.text === TRY_CAST) {
            const type = this.tryCastTarget(expression);
            return type === undefined ? ERROR : typed(type);
        }

        // `cstring(s)` is a `CString` whatever it was handed.
        if (expression.expression.text === CSTRING) {
            const argument = expression.arguments[0];
            if (argument !== undefined && this.width(argument).kind === "error") {
                return ERROR;
            }
            return typed(CSTRING_TYPE);
        }

        if (expression.expression.text === CSTRING_FREE) {
            const argument = expression.arguments[0];
            if (argument !== undefined && this.width(argument).kind === "error") {
                return ERROR;
            }
            return typed(VOID);
        }

        // `stringFromCString(p)` and `stringFromBytes(p, n)` are a `string`, and an
        // owned one — the copy that turns bytes nobody tracks into bytes a scope
        // releases.
        if (
            expression.expression.text === STRING_FROM_CSTRING ||
            expression.expression.text === STRING_FROM_BYTES
        ) {
            for (const argument of expression.arguments) {
                if (this.width(argument).kind === "error") {
                    return ERROR;
                }
            }
            return typed(STRING);
        }

        // `move(x)` has whatever type `x` has; it changes ownership, not type.
        if (expression.expression.text === MOVE) {
            const argument = expression.arguments[0];
            if (expression.arguments.length !== 1 || argument === undefined) {
                this.outer.error(expression, "GF0235", "`move` takes exactly one value.");
                return ERROR;
            }
            return this.width(argument);
        }

        const target = this.outer.resolveCallee(expression.expression);
        if (target === undefined) {
            // A value of function-pointer type, called. Its return type comes from
            // the type rather than from a declaration, because there may not be one.
            const width = this.width(expression.expression);
            if (width.kind === "typed" && width.type.kind === "fnptr") {
                for (const argument of expression.arguments) {
                    if (this.width(argument).kind === "error") {
                        return ERROR;
                    }
                }
                return typed(width.type.returns);
            }
            this.outer.unsupported(expression, `a call to \`${expression.expression.text}\``);
            return ERROR;
        }
        return typed(target.signature.returns);
    }

    /** The declared return type of `obj.m(…)`, or `"not-a-method"`. */
    #methodWidth(
        expression: ts.CallExpression,
        access: ts.PropertyAccessExpression,
    ): Width | "not-a-method" {
        // `xs.push(v)` and `xs.pop()`. Before the class and contract paths because
        // an array is neither, and its two methods are the compiler's rather than
        // any declaration's.
        const element = this.arrayElementAt(access);
        if (element !== undefined) {
            for (const argument of expression.arguments) {
                if (this.width(argument).kind === "error") {
                    return ERROR;
                }
            }
            switch (access.name.text) {
                case "push":
                    return typed(VOID);
                case "pop":
                    return typed(element);
                default:
                    this.outer.unsupported(
                        expression,
                        `\`${access.name.text}\` on a \`${renderType(element)}[]\``,
                    );
                    return ERROR;
            }
        }

        // `p.free()`, `p.deref()`, `p.offset(n)`. Before the class path, because a
        // `Pointer<C>` auto-dereferences to a `C` and would otherwise look for a
        // method of that name on it.
        if (POINTER_METHODS.has(access.name.text)) {
            const pointer = this.outer.tryErase(access.expression);
            if (pointer?.kind === "pointer") {
                for (const argument of expression.arguments) {
                    if (this.width(argument).kind === "error") {
                        return ERROR;
                    }
                }
                return this.#pointerMethodWidth(expression, access, pointer);
            }
        }

        // `C.f(…)` — a static method. The receiver is a *class name*, not a value,
        // so this is resolved before anything tries to give `C` a type.
        const staticMethod = this.staticAt(access);
        if (staticMethod !== undefined) {
            for (const argument of expression.arguments) {
                if (this.width(argument).kind === "error") {
                    return ERROR;
                }
            }
            const record = this.outer.fn(staticMethod.symbol);
            if (record === undefined) {
                this.outer.unsupported(expression, `a call to \`${staticMethod.symbol}\``);
                return ERROR;
            }
            return typed(record.signature.returns);
        }

        const contract = this.contractAt(access.expression);
        if (contract !== undefined) {
            const method = contract.methods.find((m) => m.name === access.name.text);
            if (method === undefined) {
                this.outer.unsupported(expression, `\`${contract.name}.${access.name.text}()\``);
                return ERROR;
            }
            for (const argument of expression.arguments) {
                if (this.width(argument).kind === "error") {
                    return ERROR;
                }
            }
            return typed(method.returns);
        }

        // `super.m()` resolves against the *base*, statically. Asking tsc for the
        // type of `super` would answer with the base too, but going through the
        // class registry keeps one path for "which body does this name" and it is
        // the same one the lowerer uses.
        const info =
            access.expression.kind === ts.SyntaxKind.SuperKeyword
                ? this.self?.base
                : this.outer.classInfo(this.outer.classNameAt(access.expression) ?? "");
        if (info === undefined) {
            if (access.expression.kind !== ts.SyntaxKind.SuperKeyword) {
                return "not-a-method";
            }
            this.outer.error(
                access,
                "GF0002",
                "`super` is only meaningful inside a method of a class that extends another.",
            );
            return ERROR;
        }
        const className = info.name;
        const method = info.methods.get(access.name.text);
        if (method === undefined) {
            this.outer.unsupported(expression, `\`${className}.${access.name.text}()\``);
            return ERROR;
        }
        const record = this.outer.fn(method.symbol);
        if (record === undefined) {
            return ERROR;
        }
        for (const argument of expression.arguments) {
            if (this.width(argument).kind === "error") {
                return ERROR;
            }
        }
        return typed(record.signature.returns);
    }

    /**
     * What one of {@link POINTER_METHODS} answers with, for a `Pointer<T>`.
     *
     * The three that are lowered give a type; the three that are not say so here,
     * once, rather than in two passes with two different messages.
     */
    #pointerMethodWidth(
        expression: ts.CallExpression,
        access: ts.PropertyAccessExpression,
        pointer: Extract<MachineType, { kind: "pointer" }>,
    ): Width {
        // `erase` and `reify` answer before the guard, because they are the two
        // members that do not read through the pointer — they relabel the address.
        // Refusing them for want of a layout would refuse the only way *back* from
        // not having one.
        if (access.name.text === "erase" || access.name.text === "reify") {
            const result = this.reinterpret(expression, access, pointer);
            return result === undefined ? ERROR : typed(result);
        }
        // Before the per-member answers: every one of them needs the pointee's
        // layout, so an opaque handle gets the reason it is actually being
        // refused rather than advice to use `p[0]`, which is refused too.
        if (!this.outer.requireKnownLayout(pointer.pointee, access, `\`${access.name.text}\``)) {
            return ERROR;
        }
        switch (access.name.text) {
            case "free":
            case "freeArray":
                return typed(VOID);
            case "offset":
                return typed(pointer);
            case "deref": {
                // Only a class, because `Reference<T>` is only *writable* for a class
                // or a contract — so anything else would hand back a value whose type
                // the programmer could not name and the next expression could not use.
                // Everything else already has the spelling it needs: `p.field` reaches
                // a struct's members and `p[0]` is C's `*p`.
                if (pointer.pointee.kind === "class") {
                    return typed({kind: "reference", referent: pointer.pointee});
                }
                this.outer.unsupported(
                    access,
                    `\`deref\` on a \`${renderType(pointer)}\` — a \`Reference<T>\` can only ` +
                    "be written for a class or a contract so far. Read through the " +
                    "pointer instead: `p.field` for a struct's members, `p[0]` for C's `*p`",
                );
                return ERROR;
            }
            default:
                this.outer.unsupported(access, `\`${access.name.text}\` on a \`${renderType(pointer)}\``);
                return ERROR;
        }
    }

    /**
     * What `p.erase()` and `p.reify<U>()` answer with, and which of them may be
     * written on which pointer.
     *
     * The two halves of C's `void *` round trip, and the only reinterpretation
     * the language has. Erasing is always allowed — throwing a type away cannot
     * be wrong — and reifying is allowed only *back* from an erased pointer, so
     * that a reinterpretation between two concrete types has to be spelled
     * `p.erase().reify<U>()` and is visible in the source that depends on it.
     */
    protected reinterpret(
        expression: ts.CallExpression,
        access: ts.PropertyAccessExpression,
        pointer: Extract<MachineType, { kind: "pointer" }>,
    ): Extract<MachineType, { kind: "pointer" }> | undefined {
        const method = access.name.text;
        if (expression.arguments.length !== 0) {
            this.outer.error(expression, "GF0002", `\`${method}\` takes no arguments.`);
            return undefined;
        }

        // The call's own type, instantiated: `Pointer<unknown>` for `erase` and
        // `Pointer<U>` for `reify`. Read from the call rather than from a written
        // type argument, so that `const p: Pointer<Rect> = raw.reify()` takes `U`
        // from the annotation exactly the way tsc does.
        const result = this.outer.erase(
            expression,
            this.outer.checker.getTypeAtLocation(expression),
        );
        if (result === undefined) {
            return undefined;
        }
        if (result.kind !== "pointer") {
            this.outer.unsupported(
                expression,
                `\`${method}\` answering with a \`${renderType(result)}\` rather than a pointer`,
            );
            return undefined;
        }

        if (method === "erase") {
            return result;
        }
        if (pointer.pointee.kind !== "void") {
            this.outer.error(
                expression,
                "GF0306",
                `\`reify\` attaches a pointee type to an erased pointer, and this is a ` +
                `\`${renderType(pointer)}\` — it has one already. Write the round trip ` +
                "out — `p.erase().reify<T>()` — so that reinterpreting one concrete " +
                "type as another is visible here rather than hidden in a method call.",
            );
            return undefined;
        }
        return result;
    }

    #consoleWidth(expression: ts.CallExpression): Width {
        const access = expression.expression as ts.PropertyAccessExpression;
        if (
            ts.isIdentifier(access.expression) &&
            access.expression.text === "console" &&
            CONSOLE_METHODS[access.name.text] !== undefined
        ) {
            const argument = expression.arguments[0];
            if (argument !== undefined && this.width(argument).kind === "error") {
                return ERROR;
            }
            return typed({kind: "void"});
        }
        this.outer.unsupported(expression, "this call target");
        return ERROR;
    }

    #binaryWidth(expression: ts.BinaryExpression): Width {
        if (this.nullTestOf(expression) !== undefined) {
            return typed({kind: "bool"});
        }

        const operator = OPERATOR_TOKENS[expression.operatorToken.kind];
        if (operator === undefined) {
            const kind = expression.operatorToken.kind;
            if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
                return typed({kind: "bool"});
            }
            this.outer.unsupported(
                expression.operatorToken,
                `the operator \`${expression.operatorToken.getText()}\``,
            );
            return ERROR;
        }

        const info = OPERATORS[operator];
        const left = this.width(expression.left);
        const right = this.width(expression.right);
        if (left.kind === "error" || right.kind === "error") {
            return ERROR;
        }

        // A shift does not promote to a common type: the result is the value's
        // type and the count is converted to it (REWRITE-PLAN §7).
        const operandType = info.shift
            ? left
            : this.#combine(expression, operator, left, right);
        if (operandType.kind === "error") {
            return ERROR;
        }

        if (
            info.integerOnly &&
            operandType.kind === "typed" &&
            isFloatType(operandType.type)
        ) {
            this.outer.error(
                expression.operatorToken,
                "GF0162",
                `\`${operator}\` is defined on integers; these operands are ` +
                `\`${renderType(operandType.type)}\`.`,
            );
            return ERROR;
        }

        if (info.comparison) {
            if (operandType.kind === "typed" && !this.#comparable(expression, operator, info, operandType.type)) {
                return ERROR;
            }
            return typed({kind: "bool"});
        }
        return operandType;
    }

    /**
     * Whether two values of this type may be compared with this operator.
     *
     * tsc has nothing to say here: `<` on two strings is what it means in
     * TypeScript, and `===` on two objects is a question TypeScript can answer
     * because objects are references there. Neither survives the trip to a value
     * model on a machine, so the frontend is the only thing that can refuse them
     * — and until it did, both reached Cranelift and panicked, which is exactly
     * the failure REWRITE-PLAN §8 says must not be reachable from source.
     */
    #comparable(
        at: ts.BinaryExpression,
        operator: Operator,
        info: OperatorInfo,
        type: MachineType,
    ): boolean {
        if (isMachineComparable(type)) {
            return true;
        }

        // A `string` knows whether it equals another — the runtime compares the
        // bytes — but not which of two comes first.
        if (type.kind === "string") {
            if (!info.ordered) {
                return true;
            }
            this.outer.unsupported(
                at.operatorToken,
                `\`${operator}\` on two strings, which needs a lexicographic comparison`,
            );
            return false;
        }

        // Everything left is an aggregate, and this is the value model rather than
        // a gap. In TypeScript `a === b` on two objects asks whether they are the
        // *same object*; here they are values, so there is no such question to ask
        // — two values with equal fields are as interchangeable as two `3`s.
        this.outer.error(
            at.operatorToken,
            "GF0002",
            `\`${operator}\` has no meaning on a \`${renderType(type)}\`. In TypeScript ` +
            `this asks whether two names refer to the same object; here objects are ` +
            `values, so the question does not arise — and comparing the bytes would ` +
            `be wrong, because padding between fields holds nothing in particular. ` +
            `Compare the fields you care about.`,
        );
        return false;
    }

    /** The type both operands promote to, or an error naming why there is none. */
    #combine(at: ts.Node, operator: Operator, left: Width, right: Width): Width {
        if (left.kind === "poly") {
            return right;
        }
        if (right.kind === "poly") {
            return left;
        }
        if (left.kind !== "typed" || right.kind !== "typed") {
            return ERROR;
        }

        const common = commonType(left.type, right.type);
        if (common !== null) {
            return typed(common);
        }

        this.outer.error(
            at,
            "GF0161",
            `\`${renderType(left.type)}\` and \`${renderType(right.type)}\` have no ` +
            `common type, so \`${operator}\` has no type to work at. Neither holds ` +
            `every value of the other. Convert one with \`cast\` to say which ` +
            `you meant.`,
        );
        return ERROR;
    }

    protected widthType(expression: ts.Expression): MachineType {
        const width = this.width(expression);
        return width.kind === "typed" ? width.type : VOID;
    }
}
