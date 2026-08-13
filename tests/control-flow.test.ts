/**
 * Statements, and the shapes of CFG they build.
 *
 * `tests/pipeline.test.ts` proves the common ones work. This file is about the
 * corners: a `for` with pieces missing, a `continue` that has to run the update
 * anyway, a `break` that must leave exactly one loop, and the statements the
 * language does not have — each of which has to be a `GF0001` with a line
 * rather than something the backend discovers.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

/** Compile and run a `main` body, and return its exit code. */
async function exits(name: string, body: string, prelude = ""): Promise<number> {
  const result = await run(name, `${prelude}export function main(): i32 {\n${body}\n}\n`);
  return result.exitCode;
}

describe("`for`", () => {
  test("every clause may be omitted", async () => {
    expect(await exits("cf-for-no-init", "  let i: i32 = 0;\n  for (; i < 3; i = i + 1) { }\n  return i;")).toBe(3);
    expect(
      await exits(
        "cf-for-no-update",
        "  let i: i32 = 0;\n  for (; i < 3; ) { i = i + 1; }\n  return i;",
      ),
    ).toBe(3);
    expect(
      await exits(
        "cf-for-empty",
        "  let i: i32 = 0;\n  for (;;) { i = i + 1; if (i > 2) { break; } }\n  return i;",
      ),
    ).toBe(3);
  });

  test("`continue` runs the update clause, so the loop still terminates", async () => {
    // The classic way to write an infinite loop by accident: lowering
    // `continue` as a jump to the *condition* rather than to the update.
    expect(
      await exits(
        "cf-continue-update",
        "  let n: i32 = 0;\n" +
          "  for (let i: i32 = 0; i < 5; i = i + 1) {\n" +
          "    if (i === 2) { continue; }\n" +
          "    n = n + 1;\n" +
          "  }\n" +
          "  return n;",
      ),
    ).toBe(4);
  });

  test("the loop variable is scoped to the loop", async () => {
    await expectRejected(
      "cf-for-scope",
      `export function main(): i32 {
         for (let i: i32 = 0; i < 3; i = i + 1) { }
         return i;
       }\n`,
      "TS2304",
    );
  });

  test("a body declaring an owning value releases it every iteration", async () => {
    const result = await run(
      "cf-for-owning",
      `export function main(): i32 {
         for (let i: i32 = 0; i < 20; i = i + 1) {
           const s: string = \`v\${i}\`;
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });
});

describe("`while`", () => {
  test("a condition that is false at entry runs the body no times", async () => {
    expect(
      await exits("cf-while-false", "  let n: i32 = 0;\n  while (false) { n = 1; }\n  return n;"),
    ).toBe(0);
  });

  test("`break` leaves the innermost loop only", async () => {
    expect(
      await exits(
        "cf-break-inner",
        "  let n: i32 = 0;\n" +
          "  let i: i32 = 0;\n" +
          "  while (i < 3) {\n" +
          "    let j: i32 = 0;\n" +
          "    while (j < 3) {\n" +
          "      if (j === 1) { break; }\n" +
          "      n = n + 1;\n" +
          "      j = j + 1;\n" +
          "    }\n" +
          "    i = i + 1;\n" +
          "  }\n" +
          "  return n;",
      ),
    ).toBe(3);
  });

  test("`continue` in the outer loop skips the inner one", async () => {
    expect(
      await exits(
        "cf-continue-outer",
        "  let n: i32 = 0;\n" +
          "  let i: i32 = 0;\n" +
          "  while (i < 4) {\n" +
          "    i = i + 1;\n" +
          "    if (i === 2) { continue; }\n" +
          "    let j: i32 = 0;\n" +
          "    while (j < 2) { n = n + 1; j = j + 1; }\n" +
          "  }\n" +
          "  return n;",
      ),
    ).toBe(6);
  });

  test("`break` and `continue` outside a loop are rejected rather than lowered", async () => {
    await expectRejected(
      "cf-break-outside",
      `export function main(): i32 {
         break;
       }\n`,
      "TS1107",
    );
  });
});

describe("branches", () => {
  test("an `else if` chain picks exactly one arm", async () => {
    const source = (n: number) =>
      `export function main(): i32 {
         const n: i32 = ${n};
         if (n === 1) { return 11; }
         else if (n === 2) { return 22; }
         else { return 33; }
       }\n`;
    expect((await run("cf-chain-1", source(1))).exitCode).toBe(11);
    expect((await run("cf-chain-2", source(2))).exitCode).toBe(22);
    expect((await run("cf-chain-3", source(9))).exitCode).toBe(33);
  });

  test("branches nest as deep as they are written", async () => {
    expect(
      await exits(
        "cf-deep",
        "  let n: i32 = 0;\n" +
          "  const t: boolean = true;\n" +
          "  if (t) { if (t) { if (t) { if (t) { if (t) { n = 5; } } } } }\n" +
          "  return n;",
      ),
    ).toBe(5);
  });

  test("an `if` with no `else` falls through", async () => {
    expect(
      await exits("cf-if-fallthrough", "  const f: boolean = false;\n  if (f) { return 1; }\n  return 0;"),
    ).toBe(0);
  });
});

describe("blocks and empty statements", () => {
  test("a bare block is a scope", async () => {
    expect(
      await exits(
        "cf-bare-block",
        "  let n: i32 = 1;\n  { const n2: i32 = 2;\n    n = n2; }\n  return n;",
      ),
    ).toBe(2);
  });

  test("an empty statement is allowed and does nothing", async () => {
    expect(await exits("cf-empty-stmt", "  ;\n  return 0;")).toBe(0);
  });

  test("an empty block is allowed", async () => {
    expect(await exits("cf-empty-block", "  { }\n  return 0;")).toBe(0);
  });

  test("code after a `return` is dropped rather than lowered", async () => {
    // The block ends at the terminator, so an unsupported construct sitting
    // behind one is never reached and never reported. That is deliberate — the
    // point of the test is that it does not crash on the dead code either.
    const result = await run(
      "cf-after-return",
      `export function main(): i32 {
         return 0;
         console.log("never");
       }\n`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("statements the language does not have yet", () => {
  const cases: [string, string][] = [
    ["do/while", "  let i: i32 = 0;\n  do { i = i + 1; } while (i < 3);\n  return i;"],
    ["switch", "  const a: i32 = 1;\n  switch (a) { case 1: return 1; default: return 0; }"],
    // Over a `T[]`, which tsc *does* accept as iterable — a `FixedArray` it
    // rejects itself (TS2495), so it would not reach the compiler at all.
    ["for-of", "  const xs: i32[] = [1, 2];\n  for (const x of xs) { }\n  return 0;"],
    ["a labelled statement", "  outer: while (true) { break outer; }\n  return 0;"],
    ["try/catch", "  try { return 0; } catch (e) { return 1; }"],
    ["throw", '  throw "x";'],
    ["a nested function declaration", "  function g(): i32 { return 1; }\n  return g();"],
  ];

  for (const [what, body] of cases) {
    test(`${what} is GF0001, with a position`, async () => {
      const diagnostic = await expectRejected(
        `cf-missing-${what.replace(/[^a-z]+/gi, "")}`,
        `export function main(): i32 {\n${body}\n}\n`,
        "GF0001",
      );
      expect(diagnostic.location?.line).toBeGreaterThan(0);
      expect(diagnostic.location?.file).toContain("main.ts");
    });
  }
});

describe("declarations the language does not have yet", () => {
  const cases: [string, string][] = [
    ["a top-level `const`", "const N: i32 = 5;\n"],
    ["a top-level `let`", "let N: i32 = 5;\n"],
    ["a top-level statement", 'console.log("x");\n'],
    ["an `enum`", "enum E { A, B }\n"],
    ["a `namespace`", "namespace N { export function f(): i32 { return 1; } }\n"],
    ["a generic function", "function id<T>(x: T): T { return x; }\n"],
    ["an arrow function", "const f = (a: i32): i32 => a;\n"],
    ["a function expression", "const f = function (a: i32): i32 { return a; };\n"],
    ["a class expression", "const C = class { };\n"],
    ["a defaulted parameter", "function f(a: i32 = 1): i32 { return a; }\n"],
    ["an optional parameter", "function f(a?: i32): i32 { return 0; }\n"],
    ["a rest parameter", "function f(...a: i32[]): i32 { return 0; }\n"],
    ["a destructured parameter", "interface S { a: i32; }\nfunction f({ a }: S): i32 { return a; }\n"],
  ];

  for (const [what, prelude] of cases) {
    test(`${what} is GF0001`, async () => {
      await expectRejected(
        `cf-decl-${what.replace(/[^a-z]+/gi, "")}`,
        `${prelude}export function main(): i32 {\n  return 0;\n}\n`,
        "GF0001",
      );
    });
  }

  test("a `type` alias is erased, not rejected", async () => {
    expect(
      await exits("cf-type-alias", "  const a: T = 1;\n  return a;", "type T = i32;\n"),
    ).toBe(1);
  });

  test("a destructuring binding is GF0001", async () => {
    await expectRejected(
      "cf-destructure-binding",
      `interface S { a: i32; }
       export function main(): i32 {
         const s: S = { a: 1 };
         const { a } = s;
         return a;
       }\n`,
      "GF0001",
    );
  });

  test("a binding with no initialiser is GF0001", async () => {
    await expectRejected(
      "cf-no-initialiser",
      `export function main(): i32 {
         let a: i32;
         a = 1;
         return a;
       }\n`,
      "GF0001",
    );
  });
});

describe("functions", () => {
  test("recursion", async () => {
    expect(
      await exits(
        "cf-recursion",
        "  return fib(10);",
        "function fib(n: i32): i32 { if (n < 2) { return n; } return fib(n - 1) + fib(n - 2); }\n",
      ),
    ).toBe(55);
  });

  test("mutual recursion, where the callee is declared after the caller", async () => {
    expect(
      await exits(
        "cf-mutual",
        "  if (even(10)) { return 0; }\n  return 1;",
        "function even(n: i32): boolean { if (n === 0) { return true; } return odd(n - 1); }\n" +
          "function odd(n: i32): boolean { if (n === 0) { return false; } return even(n - 1); }\n",
      ),
    ).toBe(0);
  });

  test("a bare `return` in a `void` function", async () => {
    expect(
      await exits("cf-void-return", "  f();\n  return 0;", "function f(): void { return; }\n"),
    ).toBe(0);
  });

  test("falling off the end of a `void` function is a return", async () => {
    expect(
      await exits(
        "cf-void-falloff",
        "  f();\n  return 0;",
        'function f(): void { console.log("ran"); }\n',
      ),
    ).toBe(0);
  });

  test("more arguments than there are argument registers", async () => {
    expect(
      await exits(
        "cf-many-args",
        "  return f(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);",
        "function f(a: i32, b: i32, c: i32, d: i32, e: i32, f2: i32, g: i32, h: i32, i: i32, j: i32): i32 {\n" +
          "  return a + b + c + d + e + f2 + g + h + i + j;\n}\n",
      ),
    ).toBe(55);
  });

  test("`while (true)` with a return inside does not leave the block unsealed", async () => {
    expect(
      await exits(
        "cf-while-true-return",
        "  let i: i32 = 0;\n  while (true) { i = i + 1; if (i === 3) { return i; } }",
      ),
    ).toBe(3);
  });
});
