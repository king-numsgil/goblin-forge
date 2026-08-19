/**
 * Small answers about a type or a node that lowering asks in several places.
 *
 * The bar for living here is being a *function of its arguments*: nothing below
 * reads the module, the builder, or any lowering state.
 */

import { LocalId, type Place } from "@goblin-forge/backend";
import { isIntegerLiteral, type MachineType } from "@goblin-forge/checker";
import ts from "typescript";

/**
 * A short, stable tag for a module, from its path.
 *
 * FNV-1a over the file name. Used to qualify the symbols of *internal*
 * functions, which nothing outside this compilation may name — so the tag needs
 * to be unique and an assembler-legal identifier, and needs to be nothing else.
 */
export function moduleTag(fileName: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < fileName.length; index += 1) {
        hash ^= fileName.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * Whether a value of this type has anything to release.
 *
 * A *lookup on the type*, which is the whole point — v1's `ownsAllocation`
 * asked the same question of an expression's *node kind* and got it wrong at
 * one site out of every six (REWRITE-PLAN §4.1).
 */

export function needsDrop(type: MachineType): boolean {
    switch (type.kind) {
        case "string":
        case "array":
        case "class":
            return true;
        case "fixedArray":
            return needsDrop(type.element);
        case "struct":
            return type.fields.some((field) => needsDrop(field.type));
        default:
            return false;
    }
}

export function placeOf(local: LocalId): Place {
    return {local, projection: []};
}

/** The element type of anything that can be indexed. */
export function elementTypeOf(type: MachineType): MachineType | undefined {
    switch (type.kind) {
        case "fixedArray":
        case "array":
            return type.element;
        // `p[i]` is `*(p + i)`, as in C.
        case "pointer":
            return type.pointee;
        default:
            return undefined;
    }
}

/**
 * Whether `null` is a value this type can hold.
 *
 * The three borrowed handles, and no more. Each is one machine word that
 * nothing here owns, so a zero is a value the type already has to survive — a
 * C function returns one, and the `=== null` check reads it back.
 *
 * `string` and `T[]` are one word too and are deliberately not here: they own
 * their buffer, so a null one would reach the drop pass and be released like
 * any other. `Reference<T>` is left out for a different reason — it is bound
 * once and dereferenced without asking, and the only null one comes from
 * `tryCast`, which produces it rather than accepting it written.
 */
export function hasNullValue(type: MachineType): boolean {
    return type.kind === "pointer" || type.kind === "cstring" || type.kind === "fnptr";
}

/** What to do instead, for the types that have no null. */
export function nullAdvice(type: MachineType): string {
    switch (type.kind) {
        case "string":
        case "array":
            return (
                "It owns its buffer, so a null one would be released at the end of its " +
                "scope like any other. An empty one is the value that means nothing " +
                "here, or a `Pointer<T>` where the absence has to be distinguishable."
            );
        case "reference":
        case "interface":
            return (
                "A reference is bound once and read through without asking. `tryCast` " +
                "is what produces the nullable one, and its result is checked before " +
                "it is used."
            );
        default:
            return (
                "Only the borrowed handles have one: `Pointer<T>`, `CString`, and a " +
                "function pointer. It is a machine word of zero, and nothing else here " +
                "has a spare bit pattern to spend on absence."
            );
    }
}

/** Whether a class member carries `static`. */
export function isStaticMember(member: ts.ClassElement): boolean {
    return (
        ts.canHaveModifiers(member) &&
        (ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
    );
}

export function describe(node: ts.Node): string {
    const name = ts.SyntaxKind[node.kind];
    return `a ${name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`;
}

/**
 * Whether an expression built only from literals contains a fractional one.
 *
 * Such an expression has no width of its own and takes one from its context,
 * so a single `1.5` anywhere inside it makes `f64` the only context that can
 * hold the written value — which is what `cast` needs to know before it
 * range-checks the thing at an integer width.
 */
export function fractionalLiteralIn(expression: ts.Node): boolean {
    if (ts.isNumericLiteral(expression)) {
        return !isIntegerLiteral(expression.getText());
    }
    return expression.getChildren().some((child) => fractionalLiteralIn(child));
}
