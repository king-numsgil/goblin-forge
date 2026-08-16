/**
 * `enum`, and the underlying type a merged namespace gives it.
 *
 * TypeScript has no syntax for a C enum's underlying type, so it is written as
 * a type alias in a namespace merged into the enum:
 *
 *     enum SDL_EventType { Quit = 0x100 }
 *     declare namespace SDL_EventType { type Underlying = u32 }
 *
 * The two halves are one symbol to tsc, which is what makes the width checked
 * — a typo is an ordinary tsc error — and what keeps it out of value-position
 * completion, since a type is not a value.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

/** A program that prints one expression. */
async function prints(name: string, prelude: string, expression: string): Promise<string> {
  const result = await run(
    name,
    `${prelude}\nexport function main(): i32 {\n  console.log(\`\${${expression}}\`);\n  return 0;\n}\n`,
  );
  return result.stdout;
}

describe("members are constants", () => {
  test("a plain enum member has a value", async () => {
    expect(await prints("enum-plain", "enum Colour { Red, Green, Blue }", "Colour.Green")).toBe(
      "1\n",
    );
  });

  test("explicit, hex and computed initialisers all fold", async () => {
    const prelude = `enum E {
      Zero = 0,
      Hex = 0x100,
      Shifted = 1 << 4,
      Next = Shifted + 1,
    }`;
    expect(await prints("enum-hex", prelude, "E.Hex")).toBe("256\n");
    expect(await prints("enum-shift", prelude, "E.Shifted")).toBe("16\n");
    expect(await prints("enum-next", prelude, "E.Next")).toBe("17\n");
  });

  test("an enum member works in arithmetic and comparison", async () => {
    const prelude = "enum E { A = 3, B = 4 }";
    expect(await prints("enum-arith", prelude, "E.A + E.B")).toBe("7\n");
    expect(await prints("enum-cmp", prelude, "E.A < E.B")).toBe("true\n");
  });
});

describe("the underlying type", () => {
  test("defaults to `i32`, as a C enum does", async () => {
    // `-1` is only representable if the width is signed, which is the
    // observable half of the default.
    expect(await prints("enum-default", "enum E { Minus = -1 }", "E.Minus")).toBe("-1\n");
    expect(
      await prints("enum-default-size", "enum E { A = 1 }", "sizeOf<E>()"),
    ).toBe("4\n");
  });

  test("a declared `Underlying` changes the width", async () => {
    const prelude = `enum E { A = 1 }
      declare namespace E { type Underlying = u8 }`;
    expect(await prints("enum-u8", prelude, "sizeOf<E>()")).toBe("1\n");
    expect(await prints("enum-u8-align", prelude, "alignOf<E>()")).toBe("1\n");
  });

  test("`u64` holds a value no `i32` could", async () => {
    const prelude = `enum Big { Max = 0xFFFFFFFF }
      declare namespace Big { type Underlying = u64 }`;
    expect(await prints("enum-u64", prelude, "Big.Max")).toBe("4294967295\n");
  });

  test("the namespace may be declared **before** the enum", async () => {
    // Symbol merging does not care about order, and neither should this. The
    // width still has to land, which is what the size proves.
    const prelude = `declare namespace E { type Underlying = u8 }
      enum E { A = 200 }`;
    expect(await prints("enum-ns-first", prelude, "sizeOf<E>()")).toBe("1\n");
    expect(await prints("enum-ns-first-value", prelude, "E.A")).toBe("200\n");
  });

  test("the enum type annotates a binding and a parameter", async () => {
    const prelude = `enum Level { Low = 1, High = 2 }
      declare namespace Level { type Underlying = u16 }
      function describe(level: Level): u16 { return level; }`;
    expect(await prints("enum-param", prelude, "describe(Level.High)")).toBe("2\n");
  });

  test("a member is written at the enum's width, not the context's", async () => {
    // The whole point of declaring the width: `E.A` is a `u8`, so widening it
    // into a `u32` is a conversion the compiler can see, and narrowing it
    // would be refused.
    const prelude = `enum E { A = 200 }
      declare namespace E { type Underlying = u8 }`;
    expect(await prints("enum-width-widen", prelude, "cast<u32>(E.A) + 1")).toBe("201\n");
  });
});

describe("the rules", () => {
  test("a member that does not fit the declared width is GF0164", async () => {
    const diagnostic = await expectRejected(
      "enum-too-wide",
      `enum E { Big = 0x100 }
       declare namespace E { type Underlying = u8 }
       export function main(): i32 { return 0; }\n`,
      "GF0164",
    );
    expect(diagnostic.location?.line).toBeGreaterThan(0);
  });

  test("a member out of range is caught even when nothing reads it", async () => {
    // The check is at the declaration, so an unused member is still wrong.
    await expectRejected(
      "enum-unused-bad",
      `enum E { Fine = 1, Bad = 999 }
       declare namespace E { type Underlying = u8 }
       export function main(): i32 { return 0; }\n`,
      "GF0164",
    );
  });

  test("a float `Underlying` is GF0166", async () => {
    await expectRejected(
      "enum-float",
      `enum E { A = 1 }
       declare namespace E { type Underlying = f64 }
       export function main(): i32 { return cast<i32>(E.A); }\n`,
      "GF0166",
    );
  });

  test("a non-width `Underlying` is GF0166", async () => {
    await expectRejected(
      "enum-not-a-width",
      `enum E { A = 1 }
       declare namespace E { type Underlying = boolean }
       export function main(): i32 { return cast<i32>(E.A); }\n`,
      "GF0166",
    );
  });

  test("a string enum is GF0001 — a gap, not a rule", async () => {
    // TypeScript has string enums and there is nothing wrong with one. What is
    // missing is the lowering: the members would be string constants and there
    // would be no width to declare, so it is a different lowering rather than
    // this one with a flag. `GF0001` is the code that says "not yet" rather
    // than "not allowed".
    const diagnostic = await expectRejected(
      "enum-string",
      `enum E { A = "x", B = "y" }
       export function main(): i32 { return cast<i32>(1); }\n`,
      "GF0001",
    );
    expect(diagnostic.location?.line).toBeGreaterThan(0);
  });

  test("a mixed enum is caught by its one string member", async () => {
    await expectRejected(
      "enum-mixed",
      `enum E { A = 1, B = "two" }
       export function main(): i32 { return cast<i32>(1); }\n`,
      "GF0001",
    );
  });

  test("a namespace that is not an enum's width is still GF0001", async () => {
    // Namespaces are not a thing this language has. The one shape that carries
    // an enum's width is the exception, and it is not a door left open.
    await expectRejected(
      "enum-stray-namespace",
      `declare namespace Loose { type Underlying = u8 }
       export function main(): i32 { return 0; }\n`,
      "GF0001",
    );
  });

  test("narrowing from an enum is GF0160, like any other narrowing", async () => {
    await expectRejected(
      "enum-narrow",
      `enum E { A = 1 }
       declare namespace E { type Underlying = u32 }
       export function main(): i32 {
         const small: u8 = E.A;
         return cast<i32>(small);
       }\n`,
      "GF0160",
    );
  });
});
