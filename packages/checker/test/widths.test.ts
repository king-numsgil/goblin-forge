/**
 * The promotion table.
 *
 * Ported from v1's `types.test.ts`, which REWRITE-PLAN §12.3 calls "the honest
 * record of what the rules are". It is the language's arithmetic semantics in
 * one place, written out as data rather than reasoned about.
 *
 * The rule under test, and the only one:
 *
 * > `T` promotes to `U` exactly when every value of `T` is exactly
 * > representable in `U`.
 */

import { describe, expect, test } from "bun:test";

import {
  checkLiteral,
  commonType,
  fits,
  hasExplicitRadix,
  type MachineType,
  OPERATORS,
  rangeOf,
  sameType,
  SCALARS,
  type ScalarName,
} from "../src/index.ts";

const s = (name: ScalarName): MachineType => ({ kind: "scalar", name });
const bool: MachineType = { kind: "bool" };

describe("promotion", () => {
  test("every type contains itself", () => {
    for (const name of SCALARS) {
      expect(fits(s(name), s(name))).toBe(true);
    }
  });

  test("widening within one signedness promotes, narrowing does not", () => {
    expect(fits(s("u8"), s("u32"))).toBe(true);
    expect(fits(s("i16"), s("i64"))).toBe(true);

    expect(fits(s("u32"), s("u8"))).toBe(false);
    expect(fits(s("i64"), s("i16"))).toBe(false);
  });

  test("unsigned promotes into a strictly wider signed type", () => {
    // 255 fits in i16 but not in i8, which stops at 127.
    expect(fits(s("u8"), s("i16"))).toBe(true);
    expect(fits(s("u32"), s("i64"))).toBe(true);

    expect(fits(s("u8"), s("i8"))).toBe(false);
    expect(fits(s("u32"), s("i32"))).toBe(false);
  });

  test("signed never promotes into unsigned, however wide", () => {
    expect(fits(s("i8"), s("u8"))).toBe(false);
    expect(fits(s("i8"), s("u64"))).toBe(false);
    expect(fits(s("i32"), s("u64"))).toBe(false);
  });

  test("integers promote into a float only when the float is exact", () => {
    // f64 keeps 53 bits of integer, so everything up to 32 bits is safe.
    expect(fits(s("i32"), s("f64"))).toBe(true);
    expect(fits(s("u32"), s("f64"))).toBe(true);
    expect(fits(s("i64"), s("f64"))).toBe(false);
    expect(fits(s("u64"), s("f64"))).toBe(false);

    // f32 keeps only 24, so it takes 16-bit integers and no more.
    expect(fits(s("i16"), s("f32"))).toBe(true);
    expect(fits(s("u16"), s("f32"))).toBe(true);
    expect(fits(s("i32"), s("f32"))).toBe(false);
    expect(fits(s("u32"), s("f32"))).toBe(false);
  });

  test("f32 promotes to f64, and floats never become integers", () => {
    expect(fits(s("f32"), s("f64"))).toBe(true);
    expect(fits(s("f64"), s("f32"))).toBe(false);
    expect(fits(s("f64"), s("i64"))).toBe(false);
    expect(fits(s("f32"), s("i32"))).toBe(false);
  });

  test("pointer-width types promote only to themselves", () => {
    // Their width belongs to the target, and the frontend does not know it —
    // so `usize` to `u64` would be a promotion on one machine and a narrowing
    // on another.
    expect(fits(s("usize"), s("u64"))).toBe(false);
    expect(fits(s("u32"), s("usize"))).toBe(false);
    expect(fits(s("isize"), s("i64"))).toBe(false);
    expect(fits(s("usize"), s("f64"))).toBe(false);
    expect(fits(s("usize"), s("usize"))).toBe(true);
  });

  test("bool does not promote", () => {
    expect(fits(bool, s("i32"))).toBe(false);
    expect(fits(s("i32"), bool)).toBe(false);
    expect(fits(bool, bool)).toBe(true);
  });
});

describe("common type", () => {
  test("is the one that contains both", () => {
    expect(commonType(s("u8"), s("u32"))).toEqual(s("u32"));
    expect(commonType(s("u32"), s("u8"))).toEqual(s("u32"));
    expect(commonType(s("u8"), s("i32"))).toEqual(s("i32"));
    expect(commonType(s("i32"), s("f64"))).toEqual(s("f64"));
    expect(commonType(s("f32"), s("f64"))).toEqual(s("f64"));
    expect(commonType(s("i32"), s("i32"))).toEqual(s("i32"));
  });

  test("is null where C would silently pick one", () => {
    // C makes this u32 and turns negative values into very large ones.
    expect(commonType(s("i32"), s("u32"))).toBeNull();
    // C converts i64 to f64 and rounds above 2^53.
    expect(commonType(s("i64"), s("f64"))).toBeNull();
    expect(commonType(s("u8"), s("i8"))).toBeNull();
    expect(commonType(s("usize"), s("u32"))).toBeNull();
  });

  test("is never some third type that merely holds both", () => {
    // `i64` holds every `i32` and every `u32`. Widening both to reach it is
    // exactly the silent conversion this language refuses: the common type has
    // to be one of the two operand types or there is none.
    expect(fits(s("i32"), s("i64"))).toBe(true);
    expect(fits(s("u32"), s("i64"))).toBe(true);
    expect(commonType(s("i32"), s("u32"))).toBeNull();
  });
});

describe("literal ranges", () => {
  test("the bounds of every signed width are writable", () => {
    // `-128` is a valid `i8` and `128` is not. The sign has to be folded in
    // before the check, or the lower bound of every signed width is unwritable
    // (REWRITE-PLAN §10).
    expect(checkLiteral("i8", -128n, false).ok).toBe(true);
    expect(checkLiteral("i8", 127n, false).ok).toBe(true);
    expect(checkLiteral("i8", 128n, false).ok).toBe(false);
    expect(checkLiteral("i8", -129n, false).ok).toBe(false);

    expect(checkLiteral("i32", -2147483648n, false).ok).toBe(true);
    expect(checkLiteral("i32", 2147483648n, false).ok).toBe(false);
  });

  test("unsigned widths start at zero", () => {
    expect(checkLiteral("u8", 0n, false).ok).toBe(true);
    expect(checkLiteral("u8", 255n, false).ok).toBe(true);
    expect(checkLiteral("u8", 256n, false).ok).toBe(false);
    expect(checkLiteral("u8", -1n, false).ok).toBe(false);
  });

  test("a signed literal is stored as its two's-complement pattern", () => {
    expect(checkLiteral("i8", -1n, false).bits).toBe(255n);
    expect(checkLiteral("i8", -128n, false).bits).toBe(128n);
    expect(checkLiteral("i32", -1n, false).bits).toBe(0xffffffffn);
  });

  test("an explicit radix may fill the unsigned range and reinterpret", () => {
    // `0xff` is a valid `i8` meaning `-1`, because that is how anybody writes
    // a bit pattern. `255` written in decimal is not.
    expect(checkLiteral("i8", 0xffn, true).ok).toBe(true);
    expect(checkLiteral("i8", 0xffn, true).bits).toBe(255n);
    expect(checkLiteral("i8", 255n, false).ok).toBe(false);
    // It still has to fit the width.
    expect(checkLiteral("i8", 0x1ffn, true).ok).toBe(false);
  });

  test("the radix is read off the literal's text", () => {
    expect(hasExplicitRadix("0xff")).toBe(true);
    expect(hasExplicitRadix("0o17")).toBe(true);
    expect(hasExplicitRadix("0b1010")).toBe(true);
    expect(hasExplicitRadix("255")).toBe(false);
    expect(hasExplicitRadix("0")).toBe(false);
  });

  test("floats have no integer range to check against", () => {
    expect(rangeOf("f32")).toBeNull();
    expect(rangeOf("f64")).toBeNull();
    expect(checkLiteral("f64", 10n ** 30n, false).ok).toBe(true);
  });

  test("the pointer widths are checked at the assumed target width", () => {
    expect(rangeOf("usize")).toEqual({ min: 0n, max: (1n << 64n) - 1n });
    expect(rangeOf("isize")).toEqual({ min: -(1n << 63n), max: (1n << 63n) - 1n });
  });
});

describe("the operator table", () => {
  test("only the integer operators reject floats", () => {
    for (const op of ["%", "&", "|", "^", "<<", ">>"] as const) {
      expect(OPERATORS[op].integerOnly).toBe(true);
    }
    for (const op of ["+", "-", "*", "/"] as const) {
      expect(OPERATORS[op].integerOnly).toBe(false);
    }
  });

  test("shifts are marked, because they do not promote to a common type", () => {
    expect(OPERATORS["<<"].shift).toBe(true);
    expect(OPERATORS[">>"].shift).toBe(true);
    expect(OPERATORS["+"].shift).toBe(false);
  });

  test("the comparisons are exactly the six that produce a bool", () => {
    const comparisons = Object.entries(OPERATORS)
      .filter(([, info]) => info.comparison)
      .map(([op]) => op)
      .sort();
    expect(comparisons).toEqual(["!==", "<", "<=", "===", ">", ">="]);
  });
});

describe("structural identity", () => {
  test("distinguishes the widths from each other", () => {
    expect(sameType(s("i32"), s("i32"))).toBe(true);
    expect(sameType(s("i32"), s("u32"))).toBe(false);
    expect(sameType(s("i32"), bool)).toBe(false);
  });

  test("reaches inside the pointer-shaped types", () => {
    const toI32: MachineType = { kind: "pointer", pointee: s("i32") };
    const toU32: MachineType = { kind: "pointer", pointee: s("u32") };
    expect(sameType(toI32, toI32)).toBe(true);
    expect(sameType(toI32, toU32)).toBe(false);
    expect(sameType(toI32, { kind: "reference", referent: s("i32") })).toBe(false);
  });
});
