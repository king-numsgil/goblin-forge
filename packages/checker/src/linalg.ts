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

/** Every prefix that has vectors, in declaration order. */
export const VEC_PREFIXES: readonly LinalgPrefix[] = ["d", "f", "i", "u", "l", "ul", "b"];

/** The integer prefixes whose element is signed, and so can be negated. */
export const SIGNED_PREFIXES: readonly LinalgPrefix[] = ["d", "f", "i", "l"];

/** Whether a prefix's element is an integer — no `sqrt`, no `lerp`, no NaN. */
export function isIntegerPrefix(prefix: LinalgPrefix): boolean {
    return prefix === "i" || prefix === "u" || prefix === "l" || prefix === "ul";
}

export interface LinalgType {
    /** `aligned_dvec3` — the name written in source. */
    readonly name: string;

    /**
     * A vector, or a matrix of them.
     *
     * A matrix is **columns of a vector type**, not a flat block of scalars,
     * and that is the whole of why matrices needed almost no new machinery:
     * `dmat3` is a struct of three `dvec3`, so its layout comes from the
     * existing rule that nested aggregates are inline, its columns are ordinary
     * field projections, and every column operation is a vector operation that
     * already worked.
     *
     * A quaternion is four lanes like a `vec4` and shares most of its
     * arithmetic — `add`, `dot`, `length`, `normalize` are the same operations
     * on the same four lanes. It is a family of its own because its `mul` is
     * the Hamilton product rather than elementwise, and because a `dvec4` that
     * happened to have a `slerp` would let any four numbers be treated as a
     * rotation.
     */
    readonly family: "vec" | "mat" | "quat";

    readonly prefix: LinalgPrefix;

    /** What one component is. `bool` for a `bvec`. */
    readonly element: ScalarName | "bool";

    /**
     * The components a user can name, in order.
     *
     * `x`, `y`, `z` for a vector; `c0`, `c1`, `c2` — the *columns* — for a
     * matrix.
     */
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

    /**
     * A matrix's column type, by name: `dmat3`'s is `dvec3`.
     *
     * Absent for a vector. Held as a name rather than as a {@link LinalgType}
     * because the table is built one entry at a time and a direct reference
     * would need it built twice.
     */
    readonly columnType?: string;

    /**
     * A matrix's order — 3 for a `dmat3`, which is both its column count and
     * each column's component count. Square only, so one number says both.
     */
    readonly order?: number;
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
 * A square matrix: `order` columns of the matching vector type.
 *
 * **Column-major, and column vectors.** `m.c0` is the first *column*, `M * v`
 * is the transform, and `A.mul(B)` applies `B` first — GLM's convention, and
 * therefore what every shader and every piece of reference code assumes
 * (DECISIONS §22).
 *
 * The padded form pads each *column*, so an `aligned_dmat3` is three
 * `aligned_dvec3`: 96 bytes against `dmat3`'s 72, and every column operation is
 * one instruction rather than two.
 */
function matrix(prefix: LinalgPrefix, order: number, padded: boolean): LinalgType {
    const columnType = `${padded ? "aligned_" : ""}${prefix}vec${order}`;
    const columns = Array.from({length: order}, (_, index) => `c${index}`);
    return {
        name: `${padded ? "aligned_" : ""}${prefix}mat${order}`,
        family: "mat",
        prefix,
        element: LINALG_ELEMENTS[prefix],
        components: columns,
        fields: columns,
        // A matrix is not one register, so it has no lane count. Its columns do,
        // and that is where every operation on it does its work.
        lanes: null,
        padded,
        columnType,
        order,
    };
}

/**
 * A quaternion: `x`, `y`, `z`, `w`, with `w` the scalar part.
 *
 * Four lanes, always — there is no packed form to want, because four `f64` is
 * already exactly one AVX register and four `f32` exactly one SSE register.
 * `w` last is GLM's memory order and the one every serialised format uses; the
 * *constructor* takes it last too, so what you write is what is stored.
 */
function quaternion(prefix: LinalgPrefix): LinalgType {
    const components = [...COMPONENTS];
    return {
        name: `${prefix}quat`,
        family: "quat",
        prefix,
        element: LINALG_ELEMENTS[prefix],
        components,
        fields: components,
        lanes: 4,
        padded: false,
    };
}

/**
 * Every type `std/linalg` declares, by name.
 *
 * Vectors for all seven elements, square matrices and quaternions for the two
 * float ones. Matrices and quaternions are float-only because neither has a
 * meaning at integer precision: an integer rotation is not a rotation, and an
 * integer inverse is not an inverse.
 */
export const LINALG_TYPES: ReadonlyMap<string, LinalgType> = new Map(
    [
        ...VEC_PREFIXES.flatMap((prefix) => [
            ...[2, 3, 4].map((size) => vector(prefix, size, false)),
            // Only `vec3` has a padded form, and only where there is a vector
            // unit to pad *for*: a `vec2` and a `vec4` already fill their
            // register exactly, and an integer vector never reaches one.
            ...(SIMD_PREFIXES.includes(prefix) ? [vector(prefix, 3, true)] : []),
        ]),
        ...SIMD_PREFIXES.flatMap((prefix) => [
            ...[2, 3, 4].map((order) => matrix(prefix, order, false)),
            matrix(prefix, 3, true),
            quaternion(prefix),
        ]),
    ].map((type): [string, LinalgType] => [type.name, type]),
);

/** The boolean vector of the same width — what a comparison produces. */
export function boolVectorOf(type: LinalgType): LinalgType | undefined {
    return LINALG_TYPES.get(`bvec${type.components.length}`);
}

/** The unpadded three-component vector of the same element. */
export function axisVectorOf(type: LinalgType): LinalgType | undefined {
    return LINALG_TYPES.get(`${type.prefix}vec3`);
}

/** The square matrix of a given order with the same element. */
export function matrixOf(type: LinalgType, order: number): LinalgType | undefined {
    return LINALG_TYPES.get(`${type.prefix}mat${order}`);
}

/**
 * The type a parameter or a result names, relative to the receiver's.
 *
 * One function so that the width pass, the lowerer and the generator cannot
 * disagree about what `axis` means on a `dquat`. `undefined` is the honest
 * answer for `scalar` and `bool`, which name no linear-algebra type at all.
 */
export function relatedType(
    type: LinalgType,
    kind: LinalgReturn | LinalgParam,
): LinalgType | undefined {
    switch (kind) {
        case "vector":
            return type;
        case "column":
            return columnTypeOf(type);
        case "axis":
            return axisVectorOf(type);
        case "boolVector":
            return boolVectorOf(type);
        case "matrix3":
            return matrixOf(type, 3);
        case "matrix4":
            return matrixOf(type, 4);
        default:
            return undefined;
    }
}

/** A matrix's column type, resolved. */
export function columnTypeOf(type: LinalgType): LinalgType | undefined {
    return type.columnType === undefined ? undefined : LINALG_TYPES.get(type.columnType);
}

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
    | "addScaled"
    // -- matrices -------------------------------------------------------------
    //
    // `add`, `sub`, `scale`, `negate` and `equals` are **not** here: a matrix is
    // columns of a vector type, so each of those is the vector operation of the
    // same name applied per column, and they reuse the kinds above unchanged.
    // That reuse is the payoff for making a matrix a struct of vectors rather
    // than a flat block of scalars.
    /** `A * B`, column-major: `B` is applied first. */
    | "matMul"
    /** `M * v`. */
    | "matMulVec"
    | "transpose"
    | "determinant"
    | "inverse"
    // -- comparisons ----------------------------------------------------------
    /** Component-wise, producing a `bvec`. */
    | "compare"
    /** `any`, `all` and `not`, on a `bvec`. */
    | "anyOf"
    | "allOf"
    // -- quaternions ----------------------------------------------------------
    /** The Hamilton product — **not** elementwise, which is why quats differ. */
    | "quatMul"
    /** Negate the vector part, keep the scalar part. */
    | "conjugate"
    /** The conjugate over the squared length. */
    | "quatInverse"
    /** `q * v * q⁻¹`, as the two-cross-product form. */
    | "rotateVec"
    /** Spherical and normalised-linear interpolation. */
    | "slerp"
    | "nlerp"
    | "toMatrix";

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

/**
 * The comparisons, by the MIR's *scalar* `BinOp` names.
 *
 * Scalar rather than SIMD because a comparison produces a `bvec` — a struct of
 * `bool` — and never a mask: DECISIONS §22 keeps masks out of the MIR
 * altogether, so a comparison is one scalar compare per component whatever the
 * element type is.
 */
export type LinalgCmpOp = "Eq" | "Ne" | "Lt" | "Le" | "Gt" | "Ge";

/**
 * The integer-only elementwise operations, by the MIR's scalar `BinOp` names.
 *
 * These have no SIMD spelling in this compiler and need none: they exist on
 * integer and boolean vectors, which are scalar-lowered anyway.
 */
export type LinalgBitOp = "Rem" | "BitAnd" | "BitOr" | "BitXor" | "Shl" | "Shr";

/**
 * What one parameter of an operation is.
 *
 * `vector` means *the receiver's own type* — a `dvec3` for a `dvec3` operation,
 * a `dmat4` for a `dmat4` one. The rest name a *related* type: `column` is a
 * matrix's column vector, `axis` the three-component vector of the same
 * element, which is what a quaternion rotates.
 */
export type LinalgParam = "vector" | "scalar" | "column" | "axis";

/**
 * What an operation hands back, in the same vocabulary.
 *
 * `boolVector` is the `bvec` of the receiver's width, which is what a
 * component-wise comparison produces; `matrix3` and `matrix4` are what a
 * quaternion converts to.
 */
export type LinalgReturn =
    | "vector"
    | "scalar"
    | "bool"
    | "column"
    | "axis"
    | "boolVector"
    | "matrix3"
    | "matrix4";

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

    /**
     * Declared only where the element is signed.
     *
     * `negate` on a `uvec3` would produce a value the width rules make
     * unwritable as a literal, so the type simply does not have it.
     */
    readonly signedOnly?: boolean;
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
          readonly kind: "compare";
          readonly op: LinalgCmpOp;
      })
    | (LinalgOpBase & {
          /** Elementwise, by a scalar `BinOp` with no vector spelling. */
          readonly kind: "bitwise";
          readonly op: LinalgBitOp;
      })
    | (LinalgOpBase & {
          /** Everything the lowerer composes, which needs no single machine op. */
          readonly kind: Exclude<
              LinalgOpKind,
              "elementwise" | "scaled" | "unary" | "compare" | "bitwise"
          >;
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
/**
 * The component-wise comparisons, shared by the float and integer tables.
 *
 * **`equalTo` is not `equals`.** `equals` asks one question about the whole
 * vector and answers `boolean`; `equalTo` asks it per component and answers a
 * `bvec`, which `any` and `all` then reduce. GLM calls the second one `equal`,
 * one letter from the first — near enough to be a typo that compiles, so the
 * name here is deliberately further away.
 */
const COMPARISONS: readonly LinalgOp[] = [
    {name: "lessThan", kind: "compare", op: "Lt", params: ["vector"], returns: "boolVector"},
    {name: "lessThanEqual", kind: "compare", op: "Le", params: ["vector"], returns: "boolVector"},
    {name: "greaterThan", kind: "compare", op: "Gt", params: ["vector"], returns: "boolVector"},
    {
        name: "greaterThanEqual",
        kind: "compare",
        op: "Ge",
        params: ["vector"],
        returns: "boolVector",
    },
    {name: "equalTo", kind: "compare", op: "Eq", params: ["vector"], returns: "boolVector"},
    {name: "notEqualTo", kind: "compare", op: "Ne", params: ["vector"], returns: "boolVector"},
];

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
    ...COMPARISONS,
];

/**
 * The integer vector operations.
 *
 * No `length`, `normalize` or `distance`: each needs a square root, and an
 * integer square root is either a lie or a different type. No `lerp`, `floor`
 * or `round` for the same reason — they are all questions about a fractional
 * part that does not exist. `lengthSq` and `dot` *are* here, because both are
 * exact in integers and both are what an integer vector is usually for.
 *
 * `min` and `max` are here and are the one place integers cost more than
 * floats: there is no `llvm.minnum` for them, so each is a compare and a
 * `Select` per component.
 */
export const LINALG_INT_OPS: readonly LinalgOp[] = [
    {name: "add", kind: "elementwise", op: "Add", params: ["vector"], returns: "vector"},
    {name: "sub", kind: "elementwise", op: "Sub", params: ["vector"], returns: "vector"},
    {name: "mul", kind: "elementwise", op: "Mul", params: ["vector"], returns: "vector"},
    {name: "div", kind: "elementwise", op: "Div", params: ["vector"], returns: "vector"},
    {name: "min", kind: "elementwise", op: "Min", params: ["vector"], returns: "vector"},
    {name: "max", kind: "elementwise", op: "Max", params: ["vector"], returns: "vector"},
    {name: "rem", kind: "bitwise", op: "Rem", params: ["vector"], returns: "vector"},

    {name: "bitAnd", kind: "bitwise", op: "BitAnd", params: ["vector"], returns: "vector"},
    {name: "bitOr", kind: "bitwise", op: "BitOr", params: ["vector"], returns: "vector"},
    {name: "bitXor", kind: "bitwise", op: "BitXor", params: ["vector"], returns: "vector"},
    {name: "shl", kind: "bitwise", op: "Shl", params: ["vector"], returns: "vector"},
    {name: "shr", kind: "bitwise", op: "Shr", params: ["vector"], returns: "vector"},

    {name: "scale", kind: "scaled", op: "Mul", params: ["scalar"], returns: "vector"},
    // Signed only: negating a `u32` walks straight past the range check that
    // makes `-1` unwritable in the first place (REWRITE-PLAN §10).
    {name: "negate", kind: "unary", op: "Neg", params: [], returns: "vector", signedOnly: true},
    {name: "abs", kind: "unary", op: "Abs", params: [], returns: "vector", signedOnly: true},

    {name: "clamp", kind: "clamp", params: ["vector", "vector"], returns: "vector"},
    {name: "dot", kind: "dot", params: ["vector"], returns: "scalar"},
    {name: "lengthSq", kind: "lengthSq", params: [], returns: "scalar"},
    {name: "equals", kind: "equals", params: ["vector"], returns: "bool"},
    ...COMPARISONS,
];

/**
 * The boolean vector operations.
 *
 * `any` and `all` are what a comparison is *for*: `a.lessThan(b).any()` is the
 * question, and the `bvec` in the middle is how it gets asked. `and`, `or` and
 * `not` are bitwise on one-byte booleans, which is the same thing for values
 * that only ever hold 0 or 1 — and unlike `&&` they do not short-circuit, which
 * is correct here because every component has already been computed.
 */
export const LINALG_BOOL_OPS: readonly LinalgOp[] = [
    {name: "and", kind: "bitwise", op: "BitAnd", params: ["vector"], returns: "vector"},
    {name: "or", kind: "bitwise", op: "BitOr", params: ["vector"], returns: "vector"},
    {name: "xor", kind: "bitwise", op: "BitXor", params: ["vector"], returns: "vector"},
    {name: "not", kind: "unary", op: "Neg", params: [], returns: "vector"},

    {name: "any", kind: "anyOf", params: [], returns: "bool"},
    {name: "all", kind: "allOf", params: [], returns: "bool"},
    {name: "equals", kind: "equals", params: ["vector"], returns: "bool"},
];

/**
 * The quaternion operations.
 *
 * Most of these are the *vector* operations on the same four lanes and reach
 * the same arms: `add`, `sub`, `scale`, `negate`, `dot`, `length`, `lengthSq`,
 * `normalize` and `equals` treat a quaternion as four numbers, which is what it
 * is. Only `mul` differs, and it differs completely — the Hamilton product, not
 * an elementwise one — which is the entire reason a quaternion is not a `vec4`
 * with extra methods.
 */
export const LINALG_QUAT_OPS: readonly LinalgOp[] = [
    {name: "add", kind: "elementwise", op: "Add", params: ["vector"], returns: "vector"},
    {name: "sub", kind: "elementwise", op: "Sub", params: ["vector"], returns: "vector"},
    {name: "scale", kind: "scaled", op: "Mul", params: ["scalar"], returns: "vector"},
    {name: "negate", kind: "unary", op: "Neg", params: [], returns: "vector"},

    {name: "mul", kind: "quatMul", params: ["vector"], returns: "vector"},
    {name: "conjugate", kind: "conjugate", params: [], returns: "vector"},
    {name: "inverse", kind: "quatInverse", params: [], returns: "vector"},
    {name: "normalize", kind: "normalize", params: [], returns: "vector"},

    {name: "slerp", kind: "slerp", params: ["vector", "scalar"], returns: "vector"},
    {name: "nlerp", kind: "nlerp", params: ["vector", "scalar"], returns: "vector"},
    {name: "rotateVec", kind: "rotateVec", params: ["axis"], returns: "axis"},

    {name: "toMat3", kind: "toMatrix", params: [], returns: "matrix3"},
    {name: "toMat4", kind: "toMatrix", params: [], returns: "matrix4"},

    {name: "dot", kind: "dot", params: ["vector"], returns: "scalar"},
    {name: "length", kind: "length", params: [], returns: "scalar"},
    {name: "lengthSq", kind: "lengthSq", params: [], returns: "scalar"},
    {name: "equals", kind: "equals", params: ["vector"], returns: "bool"},
];

/**
 * The matrix operations.
 *
 * The first five are the *vector* kinds applied per column — `add` on a `dmat3`
 * is `add` on each of its three `dvec3` — so they carry the same `kind` and the
 * lowerer's existing arms do the work. Only the five below them are genuinely
 * new, and every one of those is composed from vector operations too.
 */
export const LINALG_MAT_OPS: readonly LinalgOp[] = [
    {name: "add", kind: "elementwise", op: "Add", params: ["vector"], returns: "vector"},
    {name: "sub", kind: "elementwise", op: "Sub", params: ["vector"], returns: "vector"},
    {name: "scale", kind: "scaled", op: "Mul", params: ["scalar"], returns: "vector"},
    {name: "negate", kind: "unary", op: "Neg", params: [], returns: "vector"},

    /**
     * `A.mul(B)` is `A * B`, so **`B` is applied first**: the receiver is the
     * outer transform. Column-major with column vectors, which is GLM's
     * convention and therefore every shader's.
     */
    {name: "mul", kind: "matMul", params: ["vector"], returns: "vector"},
    {name: "mulVec", kind: "matMulVec", params: ["column"], returns: "column"},
    {name: "transpose", kind: "transpose", params: [], returns: "vector"},
    {name: "inverse", kind: "inverse", params: [], returns: "vector"},
    {name: "determinant", kind: "determinant", params: [], returns: "scalar"},

    {name: "equals", kind: "equals", params: ["vector"], returns: "bool"},
];

/** The operations a type has, by family. */
export function opsFor(type: LinalgType): readonly LinalgOp[] {
    if (type.family === "mat") {
        return LINALG_MAT_OPS;
    }
    if (type.family === "quat") {
        return LINALG_QUAT_OPS;
    }
    if (type.element === "bool") {
        return LINALG_BOOL_OPS;
    }
    return isIntegerPrefix(type.prefix) ? LINALG_INT_OPS : LINALG_OPS;
}

// -- constructors --------------------------------------------------------------

/**
 * What one parameter of a constructor is.
 *
 * `axis` is the *unpadded three-component* vector of the same element — a
 * `dvec3` for a `dmat4`. Named separately from `column` because a `dmat4`'s
 * column is a `dvec4` and a translation is not four numbers.
 */
export type LinalgCtorParam = "scalar" | "axis" | "column" | "self" | "matrix3";

export type LinalgCtorKind =
    | "zero"
    | "one"
    | "splat"
    | "unit"
    | "from"
    | "columns"
    | "identity"
    | "translation"
    | "scaling"
    | "rotationX"
    | "rotationY"
    | "rotationZ"
    | "rotation2D"
    | "axisAngle"
    | "lookAt"
    | "perspective"
    | "ortho"
    | "euler"
    | "fromMatrix";

export interface LinalgCtor {
    readonly name: string;

    readonly kind: LinalgCtorKind;

    readonly params: readonly LinalgCtorParam[];

    /**
     * What each parameter is called, for the generated declaration.
     *
     * Spelled out because `perspective(fovY, aspect, near, far)` is four `f64`
     * and the order is the entire content of the signature — `p0, p1, p2, p3`
     * would be a declaration you have to read this file to use.
     */
    readonly names?: readonly string[];

    /** Which family declares it. */
    readonly family: "vec" | "mat" | "quat";

    /** Declared only where the element is a float. */
    readonly floatOnly?: boolean;

    /** Restricted to a matrix of exactly this order, or absent for all of them. */
    readonly order?: number;

    /**
     * Restricted to matrices of order 3 *or* 4 — the two that carry a rotation
     * basis. Spelled as a list because `order` alone cannot say "either".
     */
    readonly orders?: readonly number[];

    /** A per-component doc line, for the generator. */
    readonly doc?: string;
}

/**
 * Every static that *builds* a value rather than operating on one.
 *
 * Kept apart from {@link LINALG_OPS} because these have no receiver and no
 * uniform signature: `perspective` takes four scalars and `lookAt` takes three
 * vectors, where every operation takes the receiver's own type or its
 * component. Folding them into one table would mean an `params` field that
 * meant something different depending on a sibling field.
 *
 * The projection builders are **Vulkan-through-SDL3**: depth in `[0, 1]` with
 * near at 0, and `+Y` up in NDC as in world space, so no Y flip is baked in.
 * DECISIONS §22 records why that is written down rather than defaulted — a
 * projection that disagrees with its consumer produces a black screen and no
 * diagnostic at all.
 */
export const LINALG_CTORS: readonly LinalgCtor[] = [
    // -- vectors --------------------------------------------------------------
    {name: "zero", kind: "zero", params: [], family: "vec", doc: "Every component zero."},
    {name: "one", kind: "one", params: [], family: "vec", doc: "Every component one."},
    {
        name: "splat",
        kind: "splat",
        params: ["scalar"],
        names: ["value"],
        family: "vec",
        doc: "Every component the same value.",
    },
    {name: "unit", kind: "unit", params: [], family: "vec"},
    {name: "from", kind: "from", params: ["self"], family: "vec"},

    // -- matrices -------------------------------------------------------------
    {name: "zero", kind: "zero", params: [], family: "mat", doc: "Every entry zero."},
    {
        name: "identity",
        kind: "identity",
        params: [],
        family: "mat",
        doc: "Ones on the diagonal, zero elsewhere.",
    },
    {name: "from", kind: "from", params: ["self"], family: "mat"},
    {
        name: "fromColumns",
        kind: "columns",
        params: ["column"],
        family: "mat",
        doc: "Built from its columns, left to right.",
    },

    {
        name: "fromRotation",
        kind: "rotation2D",
        params: ["scalar"],
        names: ["angle"],
        family: "mat",
        order: 2,
        doc: "A counter-clockwise rotation by `angle` radians.",
    },

    {
        name: "fromScale",
        kind: "scaling",
        params: ["axis"],
        names: ["scale"],
        family: "mat",
        orders: [3, 4],
        doc: "A scale along each axis.",
    },
    {
        name: "fromRotationX",
        kind: "rotationX",
        params: ["scalar"],
        names: ["angle"],
        family: "mat",
        orders: [3, 4],
        doc: "A right-handed rotation about the x-axis, in radians.",
    },
    {
        name: "fromRotationY",
        kind: "rotationY",
        params: ["scalar"],
        names: ["angle"],
        family: "mat",
        orders: [3, 4],
        doc: "A right-handed rotation about the y-axis, in radians.",
    },
    {
        name: "fromRotationZ",
        kind: "rotationZ",
        params: ["scalar"],
        names: ["angle"],
        family: "mat",
        orders: [3, 4],
        doc: "A right-handed rotation about the z-axis, in radians.",
    },
    {
        name: "fromAxisAngle",
        kind: "axisAngle",
        params: ["axis", "scalar"],
        names: ["axis", "angle"],
        family: "mat",
        orders: [3, 4],
        doc: "A right-handed rotation about an arbitrary axis. The axis is normalised first.",
    },

    {
        name: "fromTranslation",
        kind: "translation",
        params: ["axis"],
        names: ["offset"],
        family: "mat",
        order: 4,
        doc: "An affine translation.",
    },
    {
        name: "lookAt",
        kind: "lookAt",
        params: ["axis", "axis", "axis"],
        names: ["eye", "center", "up"],
        family: "mat",
        order: 4,
        doc: "A right-handed view matrix looking from `eye` towards `center`.",
    },
    {
        name: "perspective",
        kind: "perspective",
        params: ["scalar", "scalar", "scalar", "scalar"],
        names: ["fovY", "aspect", "near", "far"],
        family: "mat",
        order: 4,
        doc:
            "A right-handed perspective projection: vertical field of view in radians, " +
            "aspect ratio, near and far. Depth maps to `[0, 1]` and `+Y` stays up.",
    },
    {
        name: "ortho",
        kind: "ortho",
        params: ["scalar", "scalar", "scalar", "scalar", "scalar", "scalar"],
        names: ["left", "right", "bottom", "top", "near", "far"],
        family: "mat",
        order: 4,
        doc:
            "A right-handed orthographic projection from `left`, `right`, `bottom`, " +
            "`top`, `near`, `far`. Depth maps to `[0, 1]` and `+Y` stays up.",
    },

    // -- quaternions ----------------------------------------------------------
    {
        name: "identity",
        kind: "identity",
        params: [],
        family: "quat",
        doc: "The rotation that does nothing: `(0, 0, 0, 1)`.",
    },
    {name: "from", kind: "from", params: ["self"], family: "quat"},
    {
        name: "fromAxisAngle",
        kind: "axisAngle",
        params: ["axis", "scalar"],
        names: ["axis", "angle"],
        family: "quat",
        doc: "A right-handed rotation about an axis. The axis is normalised first.",
    },
    {
        name: "fromEuler",
        kind: "euler",
        params: ["scalar", "scalar", "scalar"],
        names: ["pitch", "yaw", "roll"],
        family: "quat",
        doc:
            "Intrinsic Tait-Bryan angles in radians, applied **yaw, then pitch, then " +
            "roll** — rotations about y, then x, then z.",
    },
    {
        name: "fromRotation",
        kind: "fromMatrix",
        params: ["matrix3"],
        names: ["basis"],
        family: "quat",
        doc: "The rotation a matrix represents. The matrix is assumed orthonormal.",
    },
];

/** The constructors a type declares. */
export function ctorsFor(type: LinalgType): readonly LinalgCtor[] {
    return LINALG_CTORS.filter((ctor) => {
        if (ctor.family !== type.family) {
            return false;
        }
        const order = type.order ?? type.components.length;
        if (ctor.order !== undefined && ctor.order !== order) {
            return false;
        }
        return ctor.orders === undefined || ctor.orders.includes(order);
    });
}

/**
 * The constructor a static name refers to, if any.
 *
 * `unit` is the one whose *name* is per-component — `unitX`, `unitY` — so it is
 * expanded here rather than being four table rows that would have to agree.
 */
export function linalgCtorOf(
    name: string,
    type: LinalgType,
): { ctor: LinalgCtor; axis?: number } | undefined {
    for (const ctor of ctorsFor(type)) {
        if (ctor.kind === "unit") {
            const axis = type.components.findIndex(
                (component) => name === `unit${component.toUpperCase()}`,
            );
            if (axis !== -1) {
                return {ctor, axis};
            }
            continue;
        }
        if (ctor.name === name) {
            return {ctor};
        }
    }
    return undefined;
}

/** Whether an operation applies to a given type. */
export function appliesTo(op: LinalgOp, type: LinalgType): boolean {
    if (op.components !== undefined && op.components !== type.components.length) {
        return false;
    }
    return op.signedOnly !== true || SIGNED_PREFIXES.includes(type.prefix);
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

/** Whether a static name builds a value rather than operating on one. */
export function isLinalgConstructor(name: string, type: LinalgType): boolean {
    return linalgCtorOf(name, type) !== undefined;
}

/**
 * The operation a method name names on a given type, if it names one.
 *
 * Searched through {@link opsFor} rather than through a prebuilt map per
 * family. The map version cached two families and silently answered from the
 * *vector* table for the other three — which worked for `add` and `dot`,
 * because those names are in every table, and failed for `any` and `slerp`.
 * A cache keyed by a subset of what it is asked about is worse than no cache,
 * and twenty-five entries do not need one.
 *
 * {@link appliesTo} is applied here so that `negate` on a `uvec3` and `cross`
 * on a `dvec2` do not resolve at all, rather than resolving and being refused
 * further in.
 */
export function linalgMethodOf(
    name: string,
    type: LinalgType,
): { op: LinalgOp; mutating: boolean } | undefined {
    for (const op of opsFor(type)) {
        if (!appliesTo(op, type)) {
            continue;
        }
        if (op.name === name) {
            return {op, mutating: false};
        }
        if (hasMutatingForm(op) && mutatingName(op) === name) {
            return {op, mutating: true};
        }
    }
    return undefined;
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
