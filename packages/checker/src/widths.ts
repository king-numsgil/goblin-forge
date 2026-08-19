/**
 * The arithmetic semantics of the language, written out as data.
 *
 * REWRITE-PLAN §7: "Put all of these in one table-driven place rather than
 * scattered through lowering." This is that place. Nothing in here knows about
 * MIR, tsc, or code generation — it is the rules, as pure functions over
 * {@link MachineType}, which is what makes them testable the way v1's
 * `types.test.ts` tested them.
 *
 * The rule the whole file turns on:
 *
 * > `T` promotes to `U` exactly when **every** value of `T` is exactly
 * > representable in `U`.
 *
 * That single sentence is why `i32 + u32` has no common type (neither holds the
 * other) and why `i64 + f64` has none either (`f64` is exact only to 2^53). C
 * performs both of those silently, turning negative numbers into very large
 * ones in the first case and rounding in the second. Here you write which one
 * you meant.
 *
 * These rules exist because tsc *cannot* express them. The width brand is
 * optional, so plain `number` is assignable to every width — which is what makes
 * `const x: i32 = 42` read naturally, and is exactly the hole this pass closes.
 */

import type { MachineType, ScalarName } from "./types.ts";

/** What a fixed width is, as data. */
export interface WidthInfo {
    readonly name: ScalarName;
    /**
     * Width in bits, or `null` when it belongs to the target rather than to the
     * language. `isize`/`usize` are the only two.
     */
    readonly bits: number | null;
    readonly signed: boolean;
    readonly float: boolean;
}

/**
 * How many bits of integer a float represents exactly.
 *
 * `f32` keeps 24 (23 stored plus the implicit leading one) and `f64` keeps 53.
 * Past that, consecutive integers stop being distinguishable — which is the
 * reason `i32` does not promote to `f32` and `i64` does not promote to `f64`.
 */
const EXACT_INTEGER_BITS: Readonly<Record<"f32" | "f64", number>> = {
    f32: 24,
    f64: 53,
};

export const WIDTHS: Readonly<Record<ScalarName, WidthInfo>> = {
    i8: {name: "i8", bits: 8, signed: true, float: false},
    i16: {name: "i16", bits: 16, signed: true, float: false},
    i32: {name: "i32", bits: 32, signed: true, float: false},
    i64: {name: "i64", bits: 64, signed: true, float: false},
    u8: {name: "u8", bits: 8, signed: false, float: false},
    u16: {name: "u16", bits: 16, signed: false, float: false},
    u32: {name: "u32", bits: 32, signed: false, float: false},
    u64: {name: "u64", bits: 64, signed: false, float: false},
    f32: {name: "f32", bits: 32, signed: true, float: true},
    f64: {name: "f64", bits: 64, signed: true, float: true},
    isize: {name: "isize", bits: null, signed: true, float: false},
    usize: {name: "usize", bits: null, signed: false, float: false},
};

/**
 * The width assumed for `isize`/`usize` when a literal has to be range-checked
 * before a target is known.
 *
 * Every target this compiler supports is 64-bit. When a 32-bit one arrives this
 * becomes a property of the target rather than a constant, and the fact that it
 * is named here rather than spelled `64` at three call sites is the point.
 */
export const ASSUMED_POINTER_BITS = 64;

function effectiveBits(info: WidthInfo): number {
    return info.bits ?? ASSUMED_POINTER_BITS;
}

/**
 * Whether every value of `from` is exactly representable in `to`.
 *
 * This is the only promotion rule. Everything else in this file is built from
 * it.
 */
export function fits(from: MachineType, to: MachineType): boolean {
    if (from.kind !== "scalar" || to.kind !== "scalar") {
        // `bool` and the pointer-shaped types do not promote to anything but
        // themselves. There is no truthiness and no integer-pointer equivalence.
        return sameType(from, to);
    }
    return fitsScalar(from.name, to.name);
}

export function fitsScalar(from: ScalarName, to: ScalarName): boolean {
    if (from === to) {
        return true;
    }

    const source = WIDTHS[from];
    const target = WIDTHS[to];

    // `isize`/`usize` promote only to themselves. Their width belongs to the
    // target, and the frontend does not know it — so `usize` to `u64` would be a
    // promotion on one machine and a narrowing on another.
    if (source.bits === null || target.bits === null) {
        return false;
    }

    if (source.float) {
        // A float never becomes an integer implicitly, and only widens to a float.
        return target.float && target.bits > source.bits;
    }

    if (target.float) {
        // An integer promotes to a float only while the float is still exact over
        // the integer's whole range.
        const exact = EXACT_INTEGER_BITS[target.name as "f32" | "f64"];
        // A signed `n`-bit integer needs `n - 1` value bits plus a sign; an
        // unsigned one needs `n`. Both must land inside the float's exact range.
        return (source.signed ? source.bits - 1 : source.bits) <= exact;
    }

    if (source.signed === target.signed) {
        return target.bits >= source.bits;
    }

    // Unsigned into signed needs somewhere for the top bit to go, so it takes a
    // strictly wider type: `u8` fits `i16` but not `i8`, which stops at 127.
    if (!source.signed && target.signed) {
        return target.bits > source.bits;
    }

    // Signed never becomes unsigned, however wide the target: there is nowhere
    // for a negative value to go.
    return false;
}

/** Structural identity. Two machine types are the same or they are not. */
export function sameType(a: MachineType, b: MachineType): boolean {
    if (a.kind !== b.kind) {
        return false;
    }
    switch (a.kind) {
        case "scalar":
            return a.name === (b as typeof a).name;
        case "array":
            return sameType(a.element, (b as typeof a).element);
        case "pointer":
            return sameType(a.pointee, (b as typeof a).pointee);
        case "reference":
            return sameType(a.referent, (b as typeof a).referent);
        case "fixedArray": {
            const other = b as typeof a;
            return a.length === other.length && sameType(a.element, other.element);
        }
        case "struct": {
            // Nominal, by the name erasure gave it. Two shapes with the same fields
            // in a different order are different layouts, so structural comparison
            // would be wrong even where it looks right.
            const other = b as typeof a;
            return a.name === other.name;
        }
        // Nominal too, and more sharply so: two classes with identical fields have
        // different vtables and different identities, and one is not the other.
        //
        // Falling into `default` here — which is what happened until classes
        // existed and nothing noticed — makes every class the same type as every
        // other, so a `Wolf` passed to an `Animal` parameter is never converted and
        // therefore never **sliced**. The program keeps the derived vtable and
        // dispatches to overrides a by-value `Animal` cannot have. No crash, just
        // the wrong answer.
        case "class":
        case "interface": {
            const other = b as typeof a;
            return a.name === other.name;
        }
        // Structural, and it has to be: a function pointer's identity is its
        // signature, because that is the only thing a caller and a definition on
        // the far side of a boundary can both know.
        //
        // A `LocalFn` compares the same way and never compares *equal* to a bare
        // function pointer, because the kinds are checked above — which is the
        // answer that matters, since the two have different representations and
        // only one of them may capture.
        case "fnptr":
        case "localfn": {
            const other = b as typeof a;
            return (
                a.params.length === other.params.length &&
                sameType(a.returns, other.returns) &&
                a.params.every((param, index) => sameType(param, other.params[index]!))
            );
        }
        // `void`, `bool` and `string` carry nothing to compare.
        default:
            return true;
    }
}

/**
 * The type both operands promote to, or `null` when there is none.
 *
 * Deliberately restricted to *one of the two operand types*. Widening both to
 * some third type that happens to hold them — `i32` and `u32` would both fit in
 * `i64` — is exactly the silent conversion this language exists to refuse.
 */
export function commonType(a: MachineType, b: MachineType): MachineType | null {
    if (fits(a, b)) {
        return b;
    }
    if (fits(b, a)) {
        return a;
    }
    return null;
}

// ---------------------------------------------------------------------------
// The operator table
// ---------------------------------------------------------------------------

/** The operators the language has, spelled as they are written. */
export type Operator =
    | "+"
    | "-"
    | "*"
    | "/"
    | "%"
    | "&"
    | "|"
    | "^"
    | "<<"
    | ">>"
    | "<"
    | "<="
    | ">"
    | ">="
    | "==="
    | "!==";

export interface OperatorInfo {
    /** `%`, `&`, `|`, `^`, `<<`, `>>` — undefined on floats. */
    readonly integerOnly: boolean;
    /**
     * A shift does **not** promote its operands to a common type. The result is
     * the value's type and the count is *converted* to it — which is what stops
     * `u8 << someI64` from quietly becoming an `i64` shift.
     */
    readonly shift: boolean;
    /** Produces a `bool` rather than a value of the operand type. */
    readonly comparison: boolean;
    /**
     * `<`, `<=`, `>`, `>=` — asks which of two values comes first, where
     * `===` and `!==` only ask whether they are the same.
     *
     * The two questions have different answers about which types may be asked.
     * Every `string` can be compared for equality, because two of them are equal
     * when their bytes are; ordering one against another needs a lexicographic
     * comparison that does not exist yet.
     */
    readonly ordered: boolean;
}

export const OPERATORS: Readonly<Record<Operator, OperatorInfo>> = {
    "+": {integerOnly: false, shift: false, comparison: false, ordered: false},
    "-": {integerOnly: false, shift: false, comparison: false, ordered: false},
    "*": {integerOnly: false, shift: false, comparison: false, ordered: false},
    "/": {integerOnly: false, shift: false, comparison: false, ordered: false},
    "%": {integerOnly: true, shift: false, comparison: false, ordered: false},
    "&": {integerOnly: true, shift: false, comparison: false, ordered: false},
    "|": {integerOnly: true, shift: false, comparison: false, ordered: false},
    "^": {integerOnly: true, shift: false, comparison: false, ordered: false},
    "<<": {integerOnly: true, shift: true, comparison: false, ordered: false},
    ">>": {integerOnly: true, shift: true, comparison: false, ordered: false},
    "<": {integerOnly: false, shift: false, comparison: true, ordered: true},
    "<=": {integerOnly: false, shift: false, comparison: true, ordered: true},
    ">": {integerOnly: false, shift: false, comparison: true, ordered: true},
    ">=": {integerOnly: false, shift: false, comparison: true, ordered: true},
    "===": {integerOnly: false, shift: false, comparison: true, ordered: false},
    "!==": {integerOnly: false, shift: false, comparison: true, ordered: false},
};

/**
 * Whether a value of this type is one machine word the hardware can compare.
 *
 * The twelve widths and `boolean` are the obvious half. The address types are
 * the other: comparing two of them is comparing two addresses, which is what
 * `p !== null` means and what C has always allowed.
 *
 * Everything else — a `string`, a struct, a class, a fixed array — is either
 * more than a word or needs a runtime call, and the operators that apply to it
 * are named one at a time rather than assumed.
 */
export function isMachineComparable(type: MachineType): boolean {
    switch (type.kind) {
        case "scalar":
        case "bool":
        case "pointer":
        case "reference":
        case "cstring":
        // A code address, so two of them compare as addresses — which is how you
        // ask whether a callback is the one you installed.
        case "fnptr":
            return true;
        default:
            return false;
    }
}

export function isFloatType(type: MachineType): boolean {
    return type.kind === "scalar" && WIDTHS[type.name].float;
}

export function isIntegerType(type: MachineType): boolean {
    return type.kind === "scalar" && !WIDTHS[type.name].float;
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

export interface Range {
    readonly min: bigint;
    readonly max: bigint;
}

/** The inclusive range of an integer width. `null` for the two floats. */
export function rangeOf(name: ScalarName): Range | null {
    const info = WIDTHS[name];
    if (info.float) {
        return null;
    }
    const span = 1n << BigInt(effectiveBits(info));
    return info.signed
        ? {min: -(span >> 1n), max: (span >> 1n) - 1n}
        : {min: 0n, max: span - 1n};
}

export interface LiteralCheck {
    readonly ok: boolean;
    /** The two's-complement bit pattern, when the literal is in range. */
    readonly bits?: bigint;
    readonly range?: Range;
}

/**
 * Range-check an integer literal and produce its bit pattern.
 *
 * Two rules are folded in here, both of which cost real time when they are
 * absent (REWRITE-PLAN §10):
 *
 * * The value passed in must already have any leading minus **folded into it**.
 *   `-128` is a valid `i8` and `128` is not, so checking the magnitude before
 *   folding makes the lower bound of every signed width unwritable.
 * * A literal written in hex, octal or binary may fill the *unsigned* range of
 *   a signed width and is reinterpreted — `0xff` is a valid `i8` meaning `-1` —
 *   because that is how anybody writes a bit pattern.
 */
export function checkLiteral(
    name: ScalarName,
    value: bigint,
    explicitRadix: boolean,
): LiteralCheck {
    const range = rangeOf(name);
    if (range === null) {
        return {ok: true};
    }

    const info = WIDTHS[name];
    const span = 1n << BigInt(effectiveBits(info));

    if (value >= range.min && value <= range.max) {
        return {ok: true, bits: value < 0n ? value + span : value, range};
    }
    if (info.signed && explicitRadix && value >= 0n && value < span) {
        return {ok: true, bits: value, range};
    }
    return {ok: false, range};
}

/** Whether a numeric literal's text was written in an explicit radix. */
export function hasExplicitRadix(text: string): boolean {
    return /^[+-]?0[xob]/i.test(text);
}

/**
 * A numeric literal's text, with JavaScript's digit separators removed.
 *
 * `1_000_000` is ordinary TypeScript and means a million. Neither `BigInt` nor
 * `Number` accepts the underscores, so the text has to be cleaned before either
 * is asked — and the two failures look nothing alike, which is what made this
 * worth a named function rather than a `.replace` at each site: `BigInt` throws
 * a `SyntaxError` that escapes the compiler entirely, and `Number` quietly
 * answers `NaN` and emits it.
 */
export function literalDigits(text: string): string {
    return text.replace(/_/g, "");
}

/**
 * Whether a literal's text denotes a whole number.
 *
 * An integer width can only be given a literal written as an integer. `1.5` is
 * the obvious case; `1e3` is the one worth stating, because it *is* a thousand
 * and is still rejected — a literal with a fraction or an exponent is a
 * floating-point literal, and letting one become an `i32` is the silent
 * float-to-integer conversion the language refuses everywhere else.
 *
 * A literal in an explicit radix is always an integer: there is no `0x1.8p3`
 * here, and TypeScript has no hexadecimal float literal to inherit.
 */
export function isIntegerLiteral(text: string): boolean {
    const digits = literalDigits(text);
    if (hasExplicitRadix(digits)) {
        return true;
    }
    return /^[+-]?\d+$/.test(digits);
}
