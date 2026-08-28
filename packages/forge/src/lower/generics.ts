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
    type TypeBinding,
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

/** Pair each of a generic's type parameters with what this use bound it to. */
export function bindingsOf(
    parameters: readonly ts.Symbol[],
    args: readonly TypeBinding[],
): Substitution {
    const bindings = new Map<ts.Symbol, TypeBinding>();
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
