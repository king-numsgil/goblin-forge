/**
 * Monomorphisation: the parts that are a function of their arguments.
 *
 * GENERICS-PLAN is the design and the reasoning; this is the arithmetic. The
 * registry, the worklist and the diagnostics live on {@link Lowerer}, because
 * they are state; what is here is naming and binding, which are not.
 *
 * The one thing worth knowing before reading either: a generic is **compiled
 * once per set of type arguments it is used with**, and the copies share
 * nothing but a source declaration. By the time the MIR exists there are no
 * type parameters in the program, which is what lets the backend, the drop
 * pass and the C boundary stay exactly as they were.
 */

import {
    layoutKey,
    type MachineType,
    type Substitution,
    typeParameterSymbolOf,
} from "@goblin-forge/checker";
import ts from "typescript";

import { moduleTag } from "./util.ts";

/**
 * The type parameters a declaration introduces, as symbols.
 *
 * Symbols rather than names, because a {@link Substitution} is keyed by them:
 * two generics may each call their parameter `T`, and inside a nested one both
 * are in scope at once.
 */
export function typeParameterSymbolsOf(
    checker: ts.TypeChecker,
    node: ts.FunctionDeclaration,
): readonly ts.Symbol[] | undefined {
    const declared = node.typeParameters;
    if (declared === undefined) {
        return undefined;
    }
    const symbols: ts.Symbol[] = [];
    for (const parameter of declared) {
        const symbol = checker.getSymbolAtLocation(parameter.name);
        if (symbol === undefined) {
            return undefined;
        }
        symbols.push(symbol);
    }
    return symbols;
}

/**
 * What tsc inferred a call's type arguments to be, or `undefined`.
 *
 * tsc has already done the inference — `getResolvedSignature` hands back a
 * signature whose parameters are the *instantiated* types — and what it does
 * not hand back is the mapping from each type parameter to what it became.
 * That is recovered by **unification**: walk the declaration's parameter types,
 * which still mention `T`, alongside the resolved ones, which do not, and read
 * `T` off wherever the two line up.
 *
 * Only the shapes this language has are walked, and that is not a shortcut so
 * much as the whole set: a bare `T`, a `T[]`, and a type reference's arguments
 * pairwise. There is nothing else a Goblin signature can be built from.
 *
 * The return type is unified too, and last. It is what determines `T` for a
 * signature that mentions it only there, and going last means a parameter's
 * answer wins where both say something — parameters are where the call's own
 * values are, so their answer is the one the programmer can see.
 *
 * `undefined` when any parameter is left undetermined, which is the caller's
 * cue to ask for the arguments in writing.
 */
export function inferBindings(
    checker: ts.TypeChecker,
    parameters: readonly ts.Symbol[],
    declared: ts.Signature,
    resolved: ts.Signature,
): Map<ts.Symbol, ts.Type> | undefined {
    const wanted = new Set(parameters);
    const found = new Map<ts.Symbol, ts.Type>();

    const declaredParams = declared.getParameters();
    const resolvedParams = resolved.getParameters();
    for (const [index, parameter] of declaredParams.entries()) {
        const actual = resolvedParams[index];
        if (actual === undefined) {
            break;
        }
        const from = typeOfParameter(checker, parameter);
        const to = typeOfParameter(checker, actual);
        if (from !== undefined && to !== undefined) {
            unify(checker, from, to, wanted, found);
        }
    }
    unify(
        checker,
        checker.getReturnTypeOfSignature(declared),
        checker.getReturnTypeOfSignature(resolved),
        wanted,
        found,
    );

    return parameters.every((parameter) => found.has(parameter)) ? found : undefined;
}

/** A parameter symbol's type, read at its own declaration. */
function typeOfParameter(checker: ts.TypeChecker, parameter: ts.Symbol): ts.Type | undefined {
    const declaration = parameter.valueDeclaration;
    return declaration === undefined
        ? undefined
        : checker.getTypeOfSymbolAtLocation(parameter, declaration);
}

/**
 * Read type parameters off a declared type by matching it against a concrete
 * one, position by position.
 *
 * **First answer wins.** A call that would bind one parameter two ways —
 * `pair<T>(a: T, b: T)` called with an `i32` and an `f64` — is one tsc has
 * already rejected, so reaching here with a conflict is not a program this
 * needs an opinion about.
 */
function unify(
    checker: ts.TypeChecker,
    declared: ts.Type,
    actual: ts.Type,
    wanted: ReadonlySet<ts.Symbol>,
    into: Map<ts.Symbol, ts.Type>,
): void {
    const parameter = typeParameterSymbolOf(declared);
    if (parameter !== undefined) {
        if (wanted.has(parameter) && !into.has(parameter)) {
            into.set(parameter, actual);
        }
        return;
    }

    if (checker.isArrayType(declared) && checker.isArrayType(actual)) {
        const element = checker.getIndexTypeOfType(declared, ts.IndexKind.Number);
        const concrete = checker.getIndexTypeOfType(actual, ts.IndexKind.Number);
        if (element !== undefined && concrete !== undefined) {
            unify(checker, element, concrete, wanted, into);
        }
        return;
    }

    // `Wrap<T>` against `Wrap<i32>`, and every other generic type reference —
    // which is also how `Pointer<T>` and `FixedArray<T, N>` are reached, since
    // both are ordinary references once the alias is resolved.
    const from = typeArgumentsOf(checker, declared);
    const to = typeArgumentsOf(checker, actual);
    if (from === undefined || to === undefined) {
        return;
    }
    for (const [index, argument] of from.entries()) {
        const concrete = to[index];
        if (concrete !== undefined) {
            unify(checker, argument, concrete, wanted, into);
        }
    }
}

/** A type reference's arguments, or `undefined` when it is not one. */
function typeArgumentsOf(
    checker: ts.TypeChecker,
    type: ts.Type,
): readonly ts.Type[] | undefined {
    if ((type.getFlags() & ts.TypeFlags.Object) === 0) {
        // An intersection is how the prelude spells a wrapper — `Pointer<T>` is
        // `T & CorePointer<T>` — so its members are walked rather than the type
        // itself, which has no arguments of its own.
        return type.isIntersection() ? type.types : undefined;
    }
    if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) {
        return undefined;
    }
    return checker.getTypeArguments(type as ts.TypeReference);
}

/** Pair each of a generic's type parameters with what this use bound it to. */
export function bindingsOf(
    parameters: readonly ts.Symbol[],
    args: readonly MachineType[],
): Substitution {
    const bindings = new Map<ts.Symbol, MachineType>();
    parameters.forEach((parameter, index) => {
        const bound = args[index];
        if (bound !== undefined) {
            bindings.set(parameter, bound);
        }
    });
    return bindings;
}

/**
 * What makes two uses of a generic *the same instantiation*.
 *
 * Over the **erased** type arguments rather than the written ones, so that a
 * type alias and what it aliases are one instantiation rather than two: the
 * copies differ only in machine types, and two spellings of `i32` produce the
 * same code. {@link layoutKey} is what says two machine types are one.
 */
export function instantiationKey(
    declaration: string,
    args: readonly MachineType[],
): string {
    return `${declaration}<${args.map(layoutKey).join(",")}>`;
}

/**
 * The symbol an instantiation is emitted under.
 *
 * Three parts, and each is doing something:
 *
 * * the name as written, so a `.ll` and a stack trace are readable;
 * * a **sanitised** rendering of the type arguments, for the same reason —
 *   `first$i32` rather than `first$3f2a1b9c` when it can be had;
 * * a hash of the full instantiation key, which is what actually makes it
 *   unique. The sanitised part cannot: `renderType` produces `i32[]` and
 *   `Pointer<i32>`, and flattening either to an assembler-legal identifier
 *   loses exactly the characters that told them apart.
 *
 * So the readable part is a *label* and the tag is the identity, which is the
 * same division `#symbolOf` already makes between a name and a module tag.
 */
export function instantiationSymbol(
    name: string,
    module: string,
    key: string,
    args: readonly MachineType[],
): string {
    const label = args
        .map((arg) => renderForSymbol(arg))
        .join("_")
        .slice(0, 32);
    return `${name}$${label}$${moduleTag(module)}$${moduleTag(key)}`;
}

/** An assembler-legal fragment of a type's spelling, for a symbol's label. */
function renderForSymbol(type: MachineType): string {
    switch (type.kind) {
        case "scalar":
            return type.name;
        case "struct":
        case "class":
        case "interface":
        case "opaque":
            return type.name.replace(/[^A-Za-z0-9_]/g, "");
        case "array":
            return `${renderForSymbol(type.element)}arr`;
        case "fixedArray":
            return `${renderForSymbol(type.element)}arr${type.length}`;
        case "pointer":
            return `ptr${renderForSymbol(type.pointee)}`;
        case "reference":
            return `ref${renderForSymbol(type.referent)}`;
        default:
            return type.kind;
    }
}
