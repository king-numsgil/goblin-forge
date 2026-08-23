/**
 * `std/linalg`: the types, and the operations on them.
 *
 * DECISIONS §22. **This file is the single source of truth**, and three things
 * read it: `erase()` turns a `dvec3` into the struct it is, the lowerer turns
 * `a.add(b)` into vector arithmetic, and a generator turns the whole table into
 * the `declare module "std/linalg"` block of `global.d.ts`.
 *
 * Written once because the alternative is writing it three times. A type
 * declared in `global.d.ts` and missing from here is `GF0001` under a name the
 * user can see in their editor's completion list; one present here and missing
 * from `global.d.ts` is a `TS2339` about a method the compiler implements. Both
 * are the drift the generated `mir.generated.ts` exists to prevent on the other
 * boundary, and the answer is the same answer.
 *
 * The rule the whole module rests on: **a linear-algebra type's storage is an
 * ordinary struct, and its arithmetic is a vector that exists only between a
 * load and a store.** So `fields` below is a layout — what `sizeOf` reports,
 * what a vertex buffer holds, what crosses the C boundary — and `lanes` is a
 * fact about registers. For `dvec3` they are three and three; for
 * `aligned_dvec3` they are four and four, and the fourth field is padding the
 * user cannot name.
 */

import ts from "typescript";

import type {MachineType, ScalarName} from "./types.ts";

/** The module these names are only ever recognised from. */
export const LINALG_MODULE = "std/linalg";

/**
 * The element prefix, and the width it means.
 *
 * `l` is `i64` and `ul` is `u64` — for the C intuition of `long` rather than
 * for any exact type, which is a naming choice recorded here so that nobody
 * later "fixes" it into `i64vec3`.
 */
export const LINALG_ELEMENTS = {
    d: "f64",
    f: "f32",
    i: "i32",
    u: "u32",
    l: "i64",
    ul: "u64",
    b: "bool",
} as const satisfies Record<string, ScalarName | "bool">;

export type LinalgPrefix = keyof typeof LINALG_ELEMENTS;

/** The prefixes whose arithmetic goes through the vector unit. */
export const SIMD_PREFIXES: readonly LinalgPrefix[] = ["d", "f"];

export interface LinalgType {
    /** `aligned_dvec3` — the name written in source. */
    readonly name: string;

    readonly family: "vec";

    readonly prefix: LinalgPrefix;

    /** What one component is. `bool` for a `bvec`. */
    readonly element: ScalarName | "bool";

    /** The components a user can name, in order: `x`, `y`, `z`. */
    readonly components: readonly string[];

    /**
     * The struct's fields, in layout order — the components, plus the padding
     * a `aligned_` type carries.
     *
     * Padding is a **real field** rather than a gap, because a struct is the
     * only thing this compiler lays out and trailing space that is not a field
     * is space `layout.rs` would not reserve.
     */
    readonly fields: readonly string[];

    /**
     * How many lanes one vector register holds for this type, or `null` when
     * its arithmetic is ordinary scalar code.
     *
     * Always equal to `fields.length` when it is a number: the lane count is
     * the *true* one, so a packed `dvec3` is `<3 x double>` rather than four
     * lanes with one ignored.
     */
    readonly lanes: number | null;

    /** Whether this type carries a lane of padding (`aligned_`). */
    readonly padded: boolean;
}

/**
 * The name the MIR struct carries: `linalg.dvec3`.
 *
 * **Qualified because structs are interned by name**, and by name alone
 * (`module.ts`, `#structTy`) — two structs called `dvec3` would be one struct,
 * and the loser would be laid out with the winner's fields. A user is entitled
 * to declare their own `dvec3`, and `.` is not a character a TypeScript
 * identifier can hold, so this key is one they cannot collide with however hard
 * they try.
 *
 * It is also the more honest name. `STD_MODULES` is keyed by specifier for the
 * same reason: `mi_malloc` is only *this* `mi_malloc` when it came from
 * `std/alloc`, and this `dvec3` is only this one when it came from
 * `std/linalg`.
 */
export function linalgStructName(type: LinalgType): string {
    return `linalg.${type.name}`;
}

const COMPONENTS = ["x", "y", "z", "w"] as const;

/** The name of the padding field on an `aligned_` type. */
export const PAD_FIELD = "_pad";

function vector(prefix: LinalgPrefix, size: number, padded: boolean): LinalgType {
    const components = COMPONENTS.slice(0, size);
    const fields = padded ? [...components, PAD_FIELD] : [...components];
    return {
        name: `${padded ? "aligned_" : ""}${prefix}vec${size}`,
        family: "vec",
        prefix,
        element: LINALG_ELEMENTS[prefix],
        components,
        fields,
        // Integers and booleans get no vector unit: AVX2 has no 64-bit multiply
        // and no integer division, so a vectorised `lvec` would carry a
        // performance cliff nothing in the type admits to.
        lanes: SIMD_PREFIXES.includes(prefix) ? fields.length : null,
        padded,
    };
}

/**
 * Every type `std/linalg` declares, by name.
 *
 * Only the vector families so far. Matrices and quaternions are entries in this
 * same table when they land, which is the property the table exists for —
 * `mat3` is three `vec3` columns, so it needs no machinery this does not
 * already have.
 */
export const LINALG_TYPES: ReadonlyMap<string, LinalgType> = new Map(
    SIMD_PREFIXES.flatMap((prefix) => [
        ...[2, 3, 4].map((size) => vector(prefix, size, false)),
        // Only `vec3` has a padded form to want: a `vec2` and a `vec4` already
        // fill their register exactly, and padding either would cost space for
        // no instruction saved.
        vector(prefix, 3, true),
    ]).map((type): [string, LinalgType] => [type.name, type]),
);

// -- the operations -----------------------------------------------------------

/**
 * How an operation is lowered.
 *
 * Every one of these is composed from the MIR's SIMD *primitives* by the
 * lowerer — there is no `Dot` node in the backend and there should never be
 * one. Adding an operation is an entry here and a case in the lowering switch;
 * it is never a change to the backend.
 */
export type LinalgOpKind =
    /** Elementwise, against another vector of the same type. */
    | "elementwise"
    /** Elementwise, against a splatted scalar. */
    | "scaled"
    /** Elementwise, against nothing. */
    | "unary"
    /** `a·b`, summed over the components — never over the padding lane. */
    | "dot"
    | "lengthSq"
    | "length"
    | "normalize"
    | "distance"
    | "distanceSq"
    | "cross"
    | "lerp"
    | "clamp"
    | "equals"
    /** `a + b * s`, one rounding. */
    | "addScaled";

/**
 * The MIR's elementwise binary operations, by their own names.
 *
 * Kept apart from {@link LinalgUnOp} rather than unioned with it, because an
 * `op` that could be either is an `op` the lowerer has to re-check at the point
 * of use — and the first version of this file did union them, which turned a
 * table typo into a cast rather than into a type error. The two sets are the
 * MIR's `SimdBinOp` and `SimdUnOp`; this package cannot import those, and
 * restating them is the nearest thing to the check that would give.
 */
export type LinalgBinOp = "Add" | "Sub" | "Mul" | "Div" | "Min" | "Max";

/** The MIR's elementwise unary operations. */
export type LinalgUnOp = "Neg" | "Abs" | "Sqrt" | "Floor" | "Ceil" | "Round" | "Trunc";

/** What one parameter of an operation is. */
export type LinalgParam = "vector" | "scalar";

/** What an operation hands back. */
export type LinalgReturn = "vector" | "scalar" | "bool";

interface LinalgOpBase {
    readonly name: string;

    /** The parameters *after* the receiver. */
    readonly params: readonly LinalgParam[];

    readonly returns: LinalgReturn;

    /**
     * Restricted to types with exactly this many components, or absent when it
     * applies to all of them. `cross` is the only one so far, and it is why
     * this exists rather than being asserted at the call site.
     */
    readonly components?: number;
}

/**
 * One operation, with its machine operation tied to its kind.
 *
 * A **discriminated union** rather than a flat interface with an optional `op`,
 * so that `kind: "unary"` carries a `SimdUnOp` and `kind: "elementwise"` a
 * `SimdBinOp`, and the lowerer's switch narrows to the right one without
 * asking. The flat version needed a cast at three sites to get from "some
 * machine op" to "the kind of machine op this arm can use", and a cast at a
 * site the table is supposed to have already settled is the table failing to
 * do its job.
 */
export type LinalgOp =
    | (LinalgOpBase & {
          /** Against another vector, or against a splatted scalar. */
          readonly kind: "elementwise" | "scaled";
          readonly op: LinalgBinOp;
      })
    | (LinalgOpBase & {
          readonly kind: "unary";
          readonly op: LinalgUnOp;
      })
    | (LinalgOpBase & {
          /** Everything the lowerer composes, which needs no single machine op. */
          readonly kind: Exclude<LinalgOpKind, "elementwise" | "scaled" | "unary">;
      });

/**
 * The operation set, in the order it is declared.
 *
 * Every operation gets a **static** form, because every one of them has a
 * vector receiver and `dvec3.length(v)` is as meaningful as `v.length()`. Only
 * the ones returning a vector get a **mutating** form — there is no `dotMut` to
 * want, and `lengthMut` would have to invent a meaning.
 *
 * Both rules are applied by the generator rather than spelled out per entry,
 * because a table that repeats a rule is a table with somewhere for the rule to
 * be broken.
 */
export const LINALG_OPS: readonly LinalgOp[] = [
    {name: "add", kind: "elementwise", op: "Add", params: ["vector"], returns: "vector"},
    {name: "sub", kind: "elementwise", op: "Sub", params: ["vector"], returns: "vector"},
    {name: "mul", kind: "elementwise", op: "Mul", params: ["vector"], returns: "vector"},
    {name: "div", kind: "elementwise", op: "Div", params: ["vector"], returns: "vector"},
    {name: "min", kind: "elementwise", op: "Min", params: ["vector"], returns: "vector"},
    {name: "max", kind: "elementwise", op: "Max", params: ["vector"], returns: "vector"},

    {name: "scale", kind: "scaled", op: "Mul", params: ["scalar"], returns: "vector"},
    {name: "addScaled", kind: "addScaled", params: ["vector", "scalar"], returns: "vector"},

    {name: "negate", kind: "unary", op: "Neg", params: [], returns: "vector"},
    {name: "abs", kind: "unary", op: "Abs", params: [], returns: "vector"},
    {name: "sqrt", kind: "unary", op: "Sqrt", params: [], returns: "vector"},
    {name: "floor", kind: "unary", op: "Floor", params: [], returns: "vector"},
    {name: "ceil", kind: "unary", op: "Ceil", params: [], returns: "vector"},
    {name: "round", kind: "unary", op: "Round", params: [], returns: "vector"},
    {name: "trunc", kind: "unary", op: "Trunc", params: [], returns: "vector"},

    {name: "normalize", kind: "normalize", params: [], returns: "vector"},
    {name: "lerp", kind: "lerp", params: ["vector", "scalar"], returns: "vector"},
    {name: "clamp", kind: "clamp", params: ["vector", "vector"], returns: "vector"},
    {name: "cross", kind: "cross", params: ["vector"], returns: "vector", components: 3},

    {name: "dot", kind: "dot", params: ["vector"], returns: "scalar"},
    {name: "lengthSq", kind: "lengthSq", params: [], returns: "scalar"},
    {name: "length", kind: "length", params: [], returns: "scalar"},
    {name: "distance", kind: "distance", params: ["vector"], returns: "scalar"},
    {name: "distanceSq", kind: "distanceSq", params: ["vector"], returns: "scalar"},

    {name: "equals", kind: "equals", params: ["vector"], returns: "bool"},
];

/** Whether an operation applies to a given type. */
export function appliesTo(op: LinalgOp, type: LinalgType): boolean {
    return op.components === undefined || op.components === type.components.length;
}

/** Whether an operation has an in-place `…Mut` form. */
export function hasMutatingForm(op: LinalgOp): boolean {
    return op.returns === "vector";
}

/** The name of the mutating form: `add` becomes `addMut`. */
export function mutatingName(op: LinalgOp): string {
    return `${op.name}Mut`;
}

// -- recognition ---------------------------------------------------------------
//
// Free functions rather than methods, because both halves of the frontend ask
// these questions and they sit at different points in one class hierarchy: the
// width pass is the *base* of the lowerer, so anything the lowerer defines is
// out of its reach. A shared question deserves one answer, not a protected
// method and a copy of it.

/** Every method name a linear-algebra type answers to, and what it means. */
const METHODS: ReadonlyMap<string, { op: LinalgOp; mutating: boolean }> = new Map(
    LINALG_OPS.flatMap((op) => {
        const forms: [string, { op: LinalgOp; mutating: boolean }][] = [
            [op.name, {op, mutating: false}],
        ];
        if (hasMutatingForm(op)) {
            forms.push([mutatingName(op), {op, mutating: true}]);
        }
        return forms;
    }),
);

/** The names that build a value rather than operating on one. */
export function isLinalgConstructor(name: string, type: LinalgType): boolean {
    return (
        name === "zero" ||
        name === "one" ||
        name === "splat" ||
        name === "from" ||
        type.components.some((component) => name === `unit${component.toUpperCase()}`)
    );
}

/** The operation a method name names on a given type, if it names one. */
export function linalgMethodOf(
    name: string,
    type: LinalgType,
): { op: LinalgOp; mutating: boolean } | undefined {
    const found = METHODS.get(name);
    if (found === undefined) {
        return undefined;
    }
    // `cross` exists on three-component vectors and nowhere else.
    if (found.op.components !== undefined && found.op.components !== type.components.length) {
        return undefined;
    }
    return found;
}

/**
 * The linear-algebra type a machine type is, through a reference if need be.
 *
 * The reference case is what a `…Mut` returns, so `a.addMut(b).scaleMut(2)`
 * finds a receiver here on its second hop.
 *
 * Recognised by the struct's **qualified** name, which is a name no user can
 * write: `.` is not a character a TypeScript identifier holds, so a user's own
 * `dvec3` cannot arrive here pretending to be this one.
 */
export function linalgFromMachine(type: MachineType | undefined): LinalgType | undefined {
    if (type === undefined) {
        return undefined;
    }
    if (type.kind === "reference") {
        return linalgFromMachine(type.referent);
    }
    if (type.kind !== "struct") {
        return undefined;
    }
    const prefix = "linalg.";
    return type.name.startsWith(prefix)
        ? LINALG_TYPES.get(type.name.slice(prefix.length))
        : undefined;
}

/**
 * The linear-algebra type an expression *names*, as opposed to holds.
 *
 * `dvec3.add(a, b)` — the receiver is the class itself, so there is no value to
 * erase and the question is which declaration the name resolved to. Asked of
 * tsc rather than matched on the text, so that a local called `dvec3` shadowing
 * the import is that local and not this.
 */
export function linalgNamedBy(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): LinalgType | undefined {
    if (!ts.isIdentifier(expression)) {
        return undefined;
    }
    const found = LINALG_TYPES.get(expression.text);
    if (found === undefined) {
        return undefined;
    }
    const symbol = checker.getSymbolAtLocation(expression);
    if (symbol === undefined) {
        return undefined;
    }
    // **Through the import alias.** `import { dvec3 } from "std/linalg"` makes
    // the name at the use site an alias whose only declaration is the import
    // specifier, so asking it for a class declaration finds none — and every
    // call would quietly fall through to the class path and be reported as an
    // unsupported name. The aliased symbol is the class.
    const resolved =
        (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    const declaration = resolved.declarations?.find(ts.isClassDeclaration);
    return declaration !== undefined && inLinalgModule(declaration) ? found : undefined;
}

/**
 * Whether a declaration sits inside `declare module "std/linalg"`.
 *
 * The module, not the name — the same rule `STD_MODULES` applies to
 * `mi_malloc`, and the reason a user's own `dvec3` stays their own.
 */
export function inLinalgModule(node: ts.Node): boolean {
    for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
        if (ts.isModuleDeclaration(at) && ts.isStringLiteral(at.name)) {
            return at.name.text === LINALG_MODULE;
        }
    }
    return false;
}
