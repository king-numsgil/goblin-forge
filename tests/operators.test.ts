/**
 * Every operator the language has, at the edges where the answer is decided by
 * a machine instruction rather than by arithmetic.
 *
 * `tests/types.test.ts` covers the *rules* — which operands promote, which pair
 * has no common type, which literal fits. This file covers what the code
 * actually computes once those rules have been satisfied: the sign of a
 * truncating division, whether a right shift is arithmetic or logical, whether
 * an unsigned compare was emitted as unsigned. Every one of those is a place
 * where the wrong choice produces a plausible number rather than a crash, which
 * is exactly the kind of mistake a test has to be written for.
 *
 * The exit code is deliberately not the assertion mechanism here: it is eight
 * bits (see {@link RunResult.exitCode}), and most of these values are wider.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

/** A program that prints one expression, so the value is compared as text. */
async function prints(name: string, prelude: string, expression: string): Promise<string> {
  const result = await run(
    name,
    `export function main(): i32 {\n${prelude}\n  console.log(\`\${${expression}}\`);\n  return 0;\n}\n`,
  );
  return result.stdout;
}

describe("integer arithmetic", () => {
  test("signed division truncates towards zero, in both directions", async () => {
    // Not "rounds down". `-7 / 2` is -3 and not -4, which is C's answer and
    // the one the hardware gives; a compiler that reached for a floor division
    // would differ only on negative operands.
    expect(await prints("op-div-pos", "  const a: i32 = 7;\n  const b: i32 = 2;", "a / b")).toBe(
      "3\n",
    );
    expect(await prints("op-div-neg", "  const a: i32 = -7;\n  const b: i32 = 2;", "a / b")).toBe(
      "-3\n",
    );
  });

  test("the remainder takes the sign of the dividend", async () => {
    expect(await prints("op-rem-neg", "  const a: i32 = -7;\n  const b: i32 = 2;", "a % b")).toBe(
      "-1\n",
    );
    expect(await prints("op-rem-pos", "  const a: i32 = 7;\n  const b: i32 = -2;", "a % b")).toBe(
      "1\n",
    );
  });

  test("an unsigned division is emitted unsigned", async () => {
    // The one that catches a signed instruction being used for an unsigned
    // type: as a signed value `4294967295` is -1, and `-1 / 2` is 0.
    expect(
      await prints("op-udiv", "  const a: u32 = 4294967295;\n  const b: u32 = 2;", "a / b"),
    ).toBe("2147483647\n");
  });

  test("an unsigned comparison is emitted unsigned", async () => {
    const result = await run(
      "op-ucmp",
      `export function main(): i32 {
         const big: u32 = 4294967295;
         const one: u32 = 1;
         if (big > one) { return 0; }
         return 1;
       }\n`,
    );
    expect(result.exitCode).toBe(0);
  });

  test("`i64` arithmetic is exact past the range a double can hold", async () => {
    // 2^53 + 1. Doing this in a float — which is what a compiler that reached
    // for JavaScript's own number type would do — gives 9007199254740992.
    expect(
      await prints("op-i64", "  const a: i64 = 9007199254740993;\n  const b: i64 = 1;", "a - b"),
    ).toBe("9007199254740992\n");
  });

  test("`u64` holds and prints its whole range", async () => {
    expect(await prints("op-u64-max", "  const a: u64 = 18446744073709551615;", "a")).toBe(
      "18446744073709551615\n",
    );
    expect(
      await prints("op-u64-near", "  const a: u64 = 18446744073709551615;\n  const b: u64 = 1;", "a - b"),
    ).toBe("18446744073709551614\n");
  });

  test("the extremes of the signed widths are writable and print back", async () => {
    expect(await prints("op-i32-min", "  const a: i32 = -2147483648;", "a")).toBe(
      "-2147483648\n",
    );
    expect(await prints("op-i64-min", "  const a: i64 = -9223372036854775808;", "a")).toBe(
      "-9223372036854775808\n",
    );
  });

  test("arithmetic wraps within its width rather than promoting", async () => {
    expect(await prints("op-u8-wrap", "  const a: u8 = 200;\n  const b: u8 = 100;", "a + b")).toBe(
      "44\n",
    );
  });
});

describe("bitwise operators", () => {
  test("`&`, `|` and `^`", async () => {
    const prelude = "  const a: u8 = 0b1100;\n  const b: u8 = 0b1010;";
    expect(await prints("op-and", prelude, "a & b")).toBe("8\n");
    expect(await prints("op-or", prelude, "a | b")).toBe("14\n");
    expect(await prints("op-xor", prelude, "a ^ b")).toBe("6\n");
  });

  test("`~` complements within the width", async () => {
    expect(await prints("op-not-i32", "  const a: i32 = 0;", "~a")).toBe("-1\n");
    expect(await prints("op-not-u8", "  const a: u8 = 0;", "~a")).toBe("255\n");
  });

  test("a shift keeps the value's width, so it wraps rather than widening", async () => {
    // REWRITE-PLAN §7: the count converts to the value's type, it does not
    // promote the value to the count's. `1 << 9` in a `u8` is 2, not 512.
    expect(await prints("op-shl-wrap", "  const a: u8 = 1;\n  const b: u8 = 9;", "a << b")).toBe(
      "2\n",
    );
  });

  test("a right shift is arithmetic on a signed type and logical on an unsigned one", async () => {
    // The single most consequential one-bit decision in this file: both
    // spellings are `>>`, and only the operand's signedness says which
    // instruction to emit.
    expect(await prints("op-sar", "  const a: i8 = -8;", "a >> 1")).toBe("-4\n");
    expect(await prints("op-shr", "  const a: u8 = 200;", "a >> 1")).toBe("100\n");
  });

  test("a shift count wider than the value is still taken in the value's type", async () => {
    expect(await prints("op-shl-count", "  const a: u8 = 3;\n  const n: u8 = 1;", "a << n")).toBe(
      "6\n",
    );
  });
});

describe("floating point", () => {
  test("`f32` arithmetic is done at `f32` precision", async () => {
    expect(await prints("op-f32", "  const a: f32 = 1.5;\n  const b: f32 = 2.25;", "a * b")).toBe(
      "3.375\n",
    );
  });

  test("an `f32` printed shows that it is an `f32`", async () => {
    // 0.1 is not representable in either width; the point is that the `f32`
    // answer differs from the `f64` one, so the value really was narrowed.
    expect(await prints("op-f32-tenth", "  const a: f32 = 0.1;", "a")).toBe(
      "0.10000000149011612\n",
    );
    expect(await prints("op-f64-tenth", "  const a: f64 = 0.1;", "a")).toBe("0.1\n");
  });

  test("`f64` addition is binary floating point, not decimal", async () => {
    expect(
      await prints("op-f64-add", "  const a: f64 = 0.1;\n  const b: f64 = 0.2;", "a + b"),
    ).toBe("0.30000000000000004\n");
  });

  test("division by zero is an infinity, not a trap", async () => {
    expect(await prints("op-inf", "  const a: f64 = 1;\n  const b: f64 = 0;", "a / b")).toBe(
      "Infinity\n",
    );
    expect(await prints("op-neg-inf", "  const a: f64 = -1;\n  const b: f64 = 0;", "a / b")).toBe(
      "-Infinity\n",
    );
  });

  test("zero over zero is NaN, and NaN is not equal to itself", async () => {
    expect(await prints("op-nan", "  const a: f64 = 0;", "a / a")).toBe("NaN\n");
    const result = await run(
      "op-nan-cmp",
      `export function main(): i32 {
         const zero: f64 = 0;
         const nan: f64 = zero / zero;
         if (nan === nan) { return 1; }
         if (nan !== nan) { return 0; }
         return 2;
       }\n`,
    );
    expect(result.exitCode).toBe(0);
  });

  test("a whole float prints without a fractional part, as in TypeScript", async () => {
    expect(await prints("op-whole", "  const a: f64 = 3;", "a")).toBe("3\n");
  });

  test("negative zero prints as `0` — a stated divergence from C++", async () => {
    // C++'s `std::cout` and printf both give `-0`. This prints the way
    // JavaScript's `String(-0)` does, which is what interpolation is modelled
    // on everywhere else in the language, so the two rules would conflict.
    expect(await prints("op-neg-zero", "  const a: f64 = -0.0;", "a")).toBe("0\n");
  });

  test("float comparisons work at the common type", async () => {
    const result = await run(
      "op-float-cmp",
      `export function main(): i32 {
         const a: f64 = 1.5;
         const b: i32 = 1;
         if (a > b) { return 0; }
         return 1;
       }\n`,
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("conversions", () => {
  test("a float truncates towards zero in both directions", async () => {
    expect(await prints("op-cast-trunc-neg", "  const a: f64 = -2.9;", "cast<i32>(a)")).toBe(
      "-2\n",
    );
    expect(await prints("op-cast-trunc-pos", "  const a: f64 = 2.9;", "cast<i32>(a)")).toBe(
      "2\n",
    );
  });

  test("a negative value cast to an unsigned width reinterprets its bits", async () => {
    expect(await prints("op-cast-neg-u8", "  const a: i32 = -1;", "cast<u8>(a)")).toBe(
      "255\n",
    );
    expect(await prints("op-cast-neg-u32", "  const a: i32 = -1;", "cast<u32>(a)")).toBe(
      "4294967295\n",
    );
  });

  test("a narrowing cast keeps the low bits", async () => {
    expect(await prints("op-cast-narrow", "  const a: i32 = 0x1234;", "cast<u8>(a)")).toBe(
      "52\n",
    );
  });
});

describe("boolean operators", () => {
  test("`!` inverts, and a bool is the only condition", async () => {
    const result = await run(
      "op-not-bool",
      `export function main(): i32 {
         const a: boolean = false;
         if (!a) { return 0; }
         return 1;
       }\n`,
    );
    expect(result.exitCode).toBe(0);
  });

  test("`&&` and `||` produce values, not just control flow", async () => {
    const result = await run(
      "op-logical-value",
      `export function main(): i32 {
         const a: boolean = true;
         const b: boolean = a && false;
         const c: boolean = b || true;
         if (c && !b) { return 0; }
         return 1;
       }\n`,
    );
    expect(result.exitCode).toBe(0);
  });

  test("the right operand of `&&` is not evaluated when the left is false", async () => {
    const result = await run(
      "op-shortcircuit-effect",
      `function loud(): boolean {
         console.log("evaluated");
         return true;
       }

       export function main(): i32 {
         const a: boolean = false;
         if (a && loud()) { return 1; }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("the right operand of `||` is not evaluated when the left is true", async () => {
    const result = await run(
      "op-shortcircuit-or",
      `function loud(): boolean {
         console.log("evaluated");
         return false;
       }

       export function main(): i32 {
         const a: boolean = true;
         if (a || loud()) { return 0; }
         return 1;
       }\n`,
    );
    expect(result.stdout).toBe("");
  });
});

describe("updating in place", () => {
  test("`++` and `--` on a local", async () => {
    expect(await prints("upd-inc", "  let a: i32 = 1;\n  a++;", "a")).toBe("2\n");
    expect(await prints("upd-dec", "  let a: i32 = 1;\n  a--;", "a")).toBe("0\n");
    expect(await prints("upd-pre-inc", "  let a: i32 = 1;\n  ++a;", "a")).toBe("2\n");
    expect(await prints("upd-pre-dec", "  let a: i32 = 1;\n  --a;", "a")).toBe("0\n");
  });

  test("every compound assignment applies its operator", async () => {
    const cases: [string, string, string][] = [
      ["add", "a += 2", "9"],
      ["sub", "a -= 2", "5"],
      ["mul", "a *= 2", "14"],
      ["div", "a /= 2", "3"],
      ["rem", "a %= 2", "1"],
      ["and", "a &= 3", "3"],
      ["or", "a |= 8", "15"],
      ["xor", "a ^= 1", "6"],
      ["shl", "a <<= 2", "28"],
      ["shr", "a >>= 1", "3"],
    ];
    for (const [name, statement, expected] of cases) {
      expect(await prints(`upd-${name}`, `  let a: i32 = 7;\n  ${statement};`, "a")).toBe(
        `${expected}\n`,
      );
    }
  });

  test("the update happens at the target's width, not at a promoted one", async () => {
    // A `u8` addition, because the place it lands in is eight bits wide and
    // the compound spelling widens nothing: 200 + 100 is 300, and 300 mod 256
    // is 44.
    expect(await prints("upd-width", "  let a: u8 = 200;\n  a += 100;", "a")).toBe("44\n");
  });

  test("the right-hand side is range-checked against the target, not the value", async () => {
    // `a += 300` is refused for the same reason `const a: u8 = 300` is: the
    // literal is read at the width it is being applied to. Folding first and
    // wrapping later would make the check unwritable.
    await expectRejected(
      "upd-width-reject",
      "export function main(): i32 {\n  let a: u8 = 7;\n  a += 300;\n  return 0;\n}\n",
      "GF0164",
    );
  });

  test("a right-shift update is arithmetic on a signed target", async () => {
    expect(await prints("upd-sar", "  let a: i8 = -8;\n  a >>= 1;", "a")).toBe("-4\n");
    expect(await prints("upd-shr", "  let a: u8 = 200;\n  a >>= 1;", "a")).toBe("100\n");
  });

  test("`++` on a float adds one", async () => {
    expect(await prints("upd-float", "  let a: f64 = 1.5;\n  a++;", "a")).toBe("2.5\n");
  });

  test("`++` updates a field, an element and a `this` field", async () => {
    expect(
      await prints(
        "upd-element",
        "  const xs: i32[] = [1, 2, 3];\n  xs[1]++;\n  xs[2] += 10;",
        "`${xs[1]} ${xs[2]}`",
      ),
    ).toBe("3 13\n");

    const result = await run(
      "upd-field",
      `class Counter {
         n: i32 = 0;
         bump(): void { this.n++; }
       }
       interface Point { x: i32; y: i32 }
       export function main(): i32 {
         const c = new Counter();
         c.bump();
         c.bump();
         c.n += 10;
         const p: Point = { x: 1, y: 2 };
         p.x++;
         p.y *= 5;
         console.log(\`\${c.n} \${p.x} \${p.y}\`);
         return 0;
       }
`,
    );
    expect(result.stdout).toBe("12 2 10\n");
  });

  test("the target of an update is evaluated exactly once", async () => {
    // The whole reason this is a read-modify-write on one resolved place
    // rather than a desugaring to `xs[next()] = xs[next()] + 1`. If the
    // subscript were evaluated twice, `calls` would be 2 and the wrong
    // element would be written.
    const result = await run(
      "upd-once",
      `class Subscript {
         calls: i32 = 0;
         next(): usize { this.calls++; return 1; }
       }
       export function main(): i32 {
         const s = new Subscript();
         const xs: i32[] = [10, 20, 30];
         xs[s.next()] += 5;
         console.log(\`\${xs[0]} \${xs[1]} \${xs[2]} \${s.calls}\`);
         return 0;
       }
`,
    );
    expect(result.stdout).toBe("10 25 30 1\n");
  });

  test("`i++` is a for-loop incrementor", async () => {
    expect(
      await prints(
        "upd-for",
        "  let total: i32 = 0;\n  for (let i: i32 = 0; i < 5; i++) { total += i; }",
        "total",
      ),
    ).toBe("10\n");
  });

  test("`%=` on a float is GF0162, exactly as `%` is", async () => {
    // The check has to be on the compound form too: without it this is the
    // `Rem is not defined on f64` panic that GF0162 exists to prevent.
    const diagnostic = await expectRejected(
      "upd-float-rem",
      "export function main(): i32 {\n  let a: f64 = 5.0;\n  a %= 2.0;\n  return 0;\n}\n",
      "GF0162",
    );
    expect(diagnostic.location?.line).toBeGreaterThan(0);
  });

  test("`+=` on a string is refused rather than reaching the backend", async () => {
    // `Add` on a string is a real MIR node — concatenation lowers to one — so
    // this would not panic, it would silently do the wrong thing with
    // ownership. Refusing it keeps the one spelling that allocates explicit.
    await expectRejected(
      "upd-string",
      'export function main(): i32 {\n  let s: string = "a";\n  s += "b";\n  return 0;\n}\n',
      "GF0002",
    );
  });
});

describe("operators the language does not have yet", () => {
  // Each of these is valid TypeScript, so tsc says nothing, and the whole
  // question is whether the *frontend* says something with a file and a line.
  const cases: [string, string][] = [
    ["`>>>`", "  const a: i32 = -8;\n  const b: i32 = a >>> 1;\n  return b;"],
    ["the comma operator", "  let a: i32 = 1;\n  const b: i32 = (a = 2, a);\n  return b;"],
    ["`&&=`", "  let a: boolean = true;\n  a &&= false;\n  return 0;"],
    ["`??`", "  const a: i32 = 1;\n  const b: i32 = a ?? 2;\n  return b;"],
    // `a++` *updates* as a statement; what is missing is its **value**, which
    // is the half where prefix and postfix stop being the same thing.
    ["`++` as a value", "  let a: i32 = 1;\n  const b: i32 = a++;\n  return b;"],
    ["a prefix `++` as a value", "  let a: i32 = 1;\n  const b: i32 = ++a;\n  return b;"],
    ["`+=` as a value", "  let a: i32 = 1;\n  const b: i32 = (a += 2);\n  return b;"],
  ];

  for (const [what, body] of cases) {
    test(`${what} is GF0001, with a position`, async () => {
      const diagnostic = await expectRejected(
        `op-missing-${what.replace(/[^a-z]+/gi, "")}`,
        `export function main(): i32 {\n${body}\n}\n`,
        "GF0001",
      );
      expect(diagnostic.location?.line).toBeGreaterThan(0);
    });
  }
});

describe("literal forms", () => {
  test("exponent notation, in both directions", async () => {
    expect(await prints("lit-exp", "  const a: f64 = 1e3;", "a")).toBe("1000\n");
    expect(await prints("lit-exp-neg", "  const a: f64 = 1e-3;", "a")).toBe("0.001\n");
  });

  test("hex, octal and binary all reach the same value", async () => {
    expect(await prints("lit-hex", "  const a: u8 = 0xff;", "a")).toBe("255\n");
    expect(await prints("lit-oct", "  const a: u8 = 0o377;", "a")).toBe("255\n");
    expect(await prints("lit-bin", "  const a: u8 = 0b11111111;", "a")).toBe("255\n");
  });

  test("a hex literal may fill the unsigned range of the widest type", async () => {
    expect(await prints("lit-hex-u64", "  const a: u64 = 0xFFFFFFFFFFFFFFFF;", "a")).toBe(
      "18446744073709551615\n",
    );
  });

  test("a `bigint` literal is not one of the twelve widths", async () => {
    const { result } = await compileSource(
      "lit-bigint",
      `export function main(): i32 {
         const a: i64 = 1n;
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).length).toBeGreaterThan(0);
  });

  test("a digit separator is removed before the text is parsed", async () => {
    // Valid TypeScript, and tsc accepts it. The two ways of getting this wrong
    // look nothing alike, which is why both are pinned: the integer path hands
    // the text to `BigInt`, which throws a `SyntaxError` out of `compile()`
    // with no code and no line; the float path hands it to `Number`, which
    // answers `NaN` and emits it.
    expect(await prints("lit-sep-dec", "  const a: i32 = 1_000;", "a")).toBe("1000\n");
    expect(await prints("lit-sep-hex", "  const a: u32 = 0xFF_FF;", "a")).toBe("65535\n");
    expect(await prints("lit-sep-bin", "  const a: u8 = 0b1010_0000;", "a")).toBe("160\n");
    expect(await prints("lit-sep-float", "  const a: f64 = 1_000.5;", "a")).toBe("1000.5\n");
    expect(await prints("lit-sep-long", "  const a: u64 = 1_000_000_000_000;", "a")).toBe(
      "1000000000000\n",
    );
  });

  test("a fractional literal given an integer width is GF0164", async () => {
    const diagnostic = await expectRejected(
      "lit-frac-int",
      `export function main(): i32 {
         const a: i32 = 1.5;
         return a;
       }\n`,
      "GF0164",
    );
    expect(diagnostic.message).toContain("floating-point literal");
    expect(diagnostic.location?.line).toBe(2);
  });

  test("an exponent literal given an integer width is GF0164 too", async () => {
    // `1e3` is exactly a thousand, and it is still refused: it is written as a
    // floating-point literal, and letting one silently become an `i32` is the
    // conversion the language makes you write everywhere else.
    await expectRejected(
      "lit-exp-int",
      `export function main(): i32 {
         const a: i32 = 1e3;
         return a;
       }\n`,
      "GF0164",
    );
  });

  test("the conversion the diagnostic suggests actually works", async () => {
    expect(await prints("lit-frac-cast", "", "cast<i32>(1.5)")).toBe("1\n");
  });
});
