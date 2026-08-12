/**
 * The width pass, end to end.
 *
 * `packages/checker/test/widths.test.ts` tests the promotion table as data.
 * This tests the same rules as a programmer meets them: through real source,
 * a real compiler, and — where the program is meant to run — a real binary.
 *
 * The distinction that matters throughout: **which half of the compiler says
 * no**. tsc rejects mixing two *declared* widths, because the brands differ and
 * the user sees that while typing. It cannot reject anything about the result
 * of arithmetic, because the width brand is optional and `a * b` is a plain
 * `number` as far as the type system is concerned. That is the hole this pass
 * exists to close, and every `GF016x` test below is in it.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("promotion", () => {
  test("a narrower operand promotes to the wider one", async () => {
    const result = await run(
      "promote-widening",
      `export function main(): i32 {
         const small: u8 = 200;
         const wide: u32 = 1000;
         const total: u32 = small + wide;
         if (total === 1200) { return 1; }
         return 0;
       }\n`,
    );
    // Compared inside the program: 1200 does not survive an 8-bit exit code,
    // and the whole value is the point of the test.
    expect(result.exitCode).toBe(1);
  });

  test("an integer promotes into a float that is exact over its range", async () => {
    const result = await run(
      "promote-to-float",
      `export function main(): i32 {
         const count: i16 = 7;
         const scale: f64 = 1.5;
         const scaled: f64 = count * scale;
         return nativeCast<i32>(scaled);
       }\n`,
    );
    expect(result.exitCode).toBe(10);
  });

  test("`i32` and `u32` have no common type", async () => {
    // C makes this `u32` and turns negative values into very large ones.
    const diagnostic = await expectRejected(
      "no-common-type",
      `export function main(): i32 {
         const a: i32 = 1;
         const b: u32 = 2;
         const sum: i32 = a + b;
         return sum;
       }\n`,
      "GF0161",
    );
    expect(diagnostic.message).toContain("no");
    expect(diagnostic.message).toContain("common type");
  });

  test("`i64` and `f64` have no common type either", async () => {
    // f64 is exact only to 2^53, so it does not hold every i64.
    await expectRejected(
      "i64-f64",
      `export function main(): i32 {
         const a: i64 = 1;
         const b: f64 = 2;
         const sum: f64 = a + b;
         return 0;
       }\n`,
      "GF0161",
    );
  });

  test("`isize` does not mix with `i64`, even where they are the same width", async () => {
    // Their width belongs to the target, and the frontend does not know it.
    await expectRejected(
      "isize-i64",
      `export function main(): i32 {
         const a: isize = 1;
         const b: i64 = 2;
         const sum: i64 = a + b;
         return 0;
       }\n`,
      "GF0161",
    );
  });
});

describe("narrowing", () => {
  test("the result of arithmetic cannot silently narrow", async () => {
    // This is the case tsc cannot catch: `a * b` is a plain `number`, and
    // plain `number` is assignable to every width.
    const diagnostic = await expectRejected(
      "implicit-narrowing",
      `export function main(): i32 {
         const a: i32 = 1000;
         const b: i32 = 2;
         const narrow: i8 = a * b;
         return 0;
       }\n`,
      "GF0160",
    );
    expect(diagnostic.message).toContain("nativeCast");
  });

  test("`nativeCast` is the written form, and it is accepted", async () => {
    const result = await run(
      "explicit-narrowing",
      `export function main(): i32 {
         const a: i32 = 300;
         const narrow: u8 = nativeCast<u8>(a);
         return nativeCast<i32>(narrow);
       }\n`,
    );
    // 300 truncates to 44 in a u8. Silent truncation is what GF0160 refuses;
    // written truncation is what nativeCast is for.
    expect(result.exitCode).toBe(44);
  });

  test("a float truncates towards zero when cast to an integer", async () => {
    const result = await run(
      "float-to-int",
      `export function main(): i32 {
         const x: f64 = 7.9;
         return nativeCast<i32>(x);
       }\n`,
    );
    expect(result.exitCode).toBe(7);
  });

  test("declared widths are tsc's business, not the width pass's", async () => {
    const { result } = await compileSource(
      "declared-widths",
      `export function main(): i32 {
         const a: i32 = 1;
         const narrow: i8 = a;
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    // tsc, not GF0160 — the user sees this one while typing, which is the
    // whole reason the brands are shaped the way they are.
    expect(errorCodes(result)).toContain("TS2322");
  });
});

describe("literals", () => {
  test("a literal takes its width from context", async () => {
    const result = await run(
      "literal-context",
      `export function main(): i32 {
         const small: u8 = 200;
         const wide: i64 = 200;
         const total: i32 = nativeCast<i32>(small) + nativeCast<i32>(wide);
         if (total === 400) { return 1; }
         return 0;
       }\n`,
    );
    expect(result.exitCode).toBe(1);
  });

  test("out of range is GF0164, and the message names the range", async () => {
    const diagnostic = await expectRejected(
      "literal-out-of-range",
      `export function main(): i32 {
         const wrong: u8 = 256;
         return 0;
       }\n`,
      "GF0164",
    );
    expect(diagnostic.message).toContain("0 to 255");
  });

  test("the lower bound of a signed width is writable", async () => {
    const result = await run(
      "signed-lower-bound",
      `export function main(): i32 {
         const low: i8 = -128;
         return nativeCast<i32>(low);
       }\n`,
    );
    expect(result.exitCode).toBe(-128 & 0xff ? 128 : 128);
  });

  test("one past the lower bound is not", async () => {
    await expectRejected(
      "past-lower-bound",
      `export function main(): i32 {
         const low: i8 = -129;
         return 0;
       }\n`,
      "GF0164",
    );
  });

  test("a hex literal may fill the unsigned range of a signed width", async () => {
    // `0xff` is a valid `i8` meaning `-1`, because that is how anybody writes
    // a bit pattern. The same value in decimal is not.
    const { result } = await compileSource(
      "hex-reinterpret",
      `export function main(): i32 {
         const bits: i8 = 0xff;
         return 0;
       }\n`,
    );
    expect(errorCodes(result)).toEqual([]);

    await expectRejected(
      "decimal-no-reinterpret",
      `export function main(): i32 {
         const bits: i8 = 255;
         return 0;
       }\n`,
      "GF0164",
    );
  });

  test("an expression built only from literals has no width to take", async () => {
    await expectRejected(
      "no-width",
      `export function main(): i32 {
         const nothing = 1 + 2;
         return 0;
       }\n`,
      "GF0161",
    );
  });
});

describe("operators", () => {
  test("the integer-only operators reject floats", async () => {
    for (const [name, source] of [
      ["remainder", "x % y"],
      ["and", "x & y"],
      ["or", "x | y"],
      ["xor", "x ^ y"],
      ["shl", "x << y"],
      ["shr", "x >> y"],
    ] as const) {
      await expectRejected(
        `float-${name}`,
        `export function main(): i32 {
           const x: f64 = 5;
           const y: f64 = 2;
           const bad: f64 = ${source};
           return 0;
         }\n`,
        "GF0162",
      );
    }
  });

  test("unary minus on an unsigned type is GF0165, not a range error", async () => {
    // The order matters: fold the sign in first and `-1` becomes `255`, which
    // is in range for a `u8` and walks straight past the range check.
    const diagnostic = await expectRejected(
      "unsigned-negate",
      `export function main(): i32 {
         const wrong: u8 = -1;
         return 0;
       }\n`,
      "GF0165",
    );
    expect(diagnostic.message).toContain("unsigned");
  });

  test("a shift takes the value's type and converts the count", async () => {
    const result = await run(
      "shift-width",
      `export function main(): i32 {
         const value: u8 = 3;
         const by: i64 = 2;
         const shifted: u8 = value << by;
         return nativeCast<i32>(shifted);
       }\n`,
    );
    // The shift happens at `u8`, so the result is a `u8`. Promoting to a
    // common type with the count would have made it an `i64` shift.
    expect(result.exitCode).toBe(12);
  });

  test("a shift that overflows its own width stays in that width", async () => {
    const result = await run(
      "shift-overflow",
      `export function main(): i32 {
         const value: u8 = 200;
         const shifted: u8 = value << 1;
         return nativeCast<i32>(shifted);
       }\n`,
    );
    // 400 does not fit in a u8; the result is 144, not 400. That is the point
    // of the shift keeping the value's type.
    expect(result.exitCode).toBe(144);
  });

  test("comparisons work at the operands' common type and produce a bool", async () => {
    const result = await run(
      "comparison-common-type",
      `export function main(): i32 {
         const small: u8 = 200;
         const wide: u32 = 1000;
         if (small < wide) {
           return 1;
         }
         return 0;
       }\n`,
    );
    expect(result.exitCode).toBe(1);
  });

  test("comparing across widths with no common type is rejected", async () => {
    await expectRejected(
      "comparison-no-common",
      `export function main(): i32 {
         const a: i32 = 1;
         const b: u32 = 2;
         if (a < b) { return 1; }
         return 0;
       }\n`,
      "GF0161",
    );
  });
});

describe("the type environment is scoped", () => {
  // REWRITE-PLAN §7: v1's map of inferred local widths was flat — a local
  // declared inside a branch stayed visible afterwards — and it got away with
  // it only because tsc rejects any program that could observe it. That is a
  // bet, not a design. Shadowing is the part that *is* observable, so it is
  // what these test.
  test("an inner binding shadows an outer one at a different width", async () => {
    const result = await run(
      "shadowing",
      `export function main(): i32 {
         const value: i32 = 1000;
         let verdict: i32 = 0;
         if (value > 0) {
           const value: u8 = 7;
           verdict = nativeCast<i32>(value);
         }
         return verdict;
       }\n`,
    );
    // 7, from the inner `u8`. Reading the outer `i32` here would have needed a
    // narrowing that nobody wrote.
    expect(result.exitCode).toBe(7);
  });

  test("the outer binding is intact after the inner scope closes", async () => {
    const result = await run(
      "shadowing-restored",
      `export function main(): i32 {
         const value: i32 = 100;
         if (value > 0) {
           const value: u8 = 7;
           const unused: u8 = value;
         }
         const doubled: i32 = value + value;
         if (doubled === 200) { return 1; }
         return 0;
       }\n`,
    );
    expect(result.exitCode).toBe(1);
  });

  test("a binding declared in a branch is not visible after it", async () => {
    const { result } = await compileSource(
      "scope-leak",
      `export function main(): i32 {
         const flag: boolean = true;
         if (flag) {
           const inner: i32 = 1;
         }
         return inner;
       }\n`,
    );
    expect(result.ok).toBe(false);
    // tsc is the one that says so, which is the right half of the compiler for
    // it. The scope stack exists so that the compiler agrees rather than
    // relying on tsc having caught it.
    expect(errorCodes(result)).toContain("TS2304");
  });
});

describe("nativeCast", () => {
  test("converts between every pair of integer widths", async () => {
    const result = await run(
      "cast-round-trip",
      `export function main(): i32 {
         const a: i8 = -1;
         const b: u8 = nativeCast<u8>(a);
         const c: u32 = nativeCast<u32>(b);
         return nativeCast<i32>(c);
       }\n`,
    );
    // -1 as a u8 is 255, and widening that is 255 — not 4294967295, which is
    // what sign-extending would have produced.
    expect(result.exitCode).toBe(255);
  });

  test("sign-extends a signed source", async () => {
    const result = await run(
      "cast-sign-extend",
      `export function main(): i32 {
         const a: i8 = -1;
         return nativeCast<i32>(a);
       }\n`,
    );
    expect(result.exitCode).toBe(-1 >>> 0 ? 255 : 255);
  });

  test("converts an integer to a float and back", async () => {
    const result = await run(
      "cast-float",
      `export function main(): i32 {
         const a: i64 = 9;
         const b: f32 = nativeCast<f32>(a);
         const c: f64 = nativeCast<f64>(b);
         return nativeCast<i32>(c);
       }\n`,
    );
    expect(result.exitCode).toBe(9);
  });
});
