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
    ["try/catch", "  try { return 0; } catch (e) { return 1; }"],
    ["throw", '  throw "x";'],
    ["a nested function declaration", "  function g(): i32 { return 1; }\n  return g();"],
    // A `FixedArray` is rejected by tsc itself (TS2495) rather than reaching
    // here, so `for…of` over one has no GF0001 to assert. Over a `T[]` it works
    // — see the `for…of` suite below.
    ["for-in", "  const xs: i32[] = [1];\n  for (const k in xs) { }\n  return 0;"],
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

describe("`do`/`while`", () => {
  test("the body runs before the first test", async () => {
    // The whole difference from `while`, and the only way to see it: a
    // condition false from the start still runs the body once.
    expect(
      await exits("cf-do-once", "  let i: i32 = 0;\n  do { i = i + 1; } while (i < 0);\n  return i;"),
    ).toBe(1);
  });

  test("it iterates like a `while` otherwise", async () => {
    expect(
      await exits("cf-do-many", "  let i: i32 = 0;\n  do { i = i + 1; } while (i < 5);\n  return i;"),
    ).toBe(5);
  });

  test("`continue` goes to the test, not to the body", async () => {
    // Jumping to the body instead skips the test and the loop never ends —
    // the same class of mistake as a `for` whose `continue` skips the update.
    expect(
      await exits(
        "cf-do-continue",
        "  let i: i32 = 0;\n  let seen: i32 = 0;\n" +
          "  do { i = i + 1; if (i === 2) { continue; } seen = seen + 1; } while (i < 4);\n" +
          "  return i * 10 + seen;",
      ),
    ).toBe(43);
  });

  test("`break` leaves it", async () => {
    expect(
      await exits(
        "cf-do-break",
        "  let i: i32 = 0;\n  do { i = i + 1; if (i === 2) { break; } } while (i < 9);\n  return i;",
      ),
    ).toBe(2);
  });
});

describe("`switch`", () => {
  test("it dispatches on an integer, and `default` catches the rest", async () => {
    const body =
      "  let total: i32 = 0;\n  let i: i32 = 0;\n" +
      "  while (i < 4) {\n" +
      "    switch (i) {\n" +
      "      case 0: total = total + 1; break;\n" +
      "      case 1: total = total + 10; break;\n" +
      "      default: total = total + 100; break;\n" +
      "    }\n" +
      "    i = i + 1;\n" +
      "  }\n  return total;";
    expect(await exits("cf-switch-int", body)).toBe(211);
  });

  test("empty clauses fall through, which is what `case 1: case 2:` means", async () => {
    // The clause blocks are chained, so a clause running off its end falls
    // into the next. `noFallthroughCasesInSwitch` is what stops a *non-empty*
    // one doing the same, and it is tsc's rule rather than the compiler's — so
    // the editor underlines it.
    const body =
      "  let total: i32 = 0;\n  let i: i32 = 0;\n" +
      "  while (i < 4) {\n" +
      "    switch (i) {\n" +
      "      case 0:\n      case 1:\n      case 2: total = total + 1; break;\n" +
      "      default: total = total + 100; break;\n" +
      "    }\n" +
      "    i = i + 1;\n" +
      "  }\n  return total;";
    expect(await exits("cf-switch-fallthrough", body)).toBe(103);
  });

  test("`default` need not be written last", async () => {
    // It is reached only when every `case` test failed, wherever it sits, so
    // lowering it as "the last clause" is wrong for this program.
    const body =
      "  let total: i32 = 0;\n  let i: i32 = 0;\n" +
      "  while (i < 3) {\n" +
      "    switch (i) {\n" +
      "      default: total = total + 100; break;\n" +
      "      case 0: total = total + 1; break;\n" +
      "    }\n" +
      "    i = i + 1;\n" +
      "  }\n  return total;";
    expect(await exits("cf-switch-default-first", body)).toBe(201);
  });

  test("a `switch` with no `default` may match nothing", async () => {
    expect(
      await exits(
        "cf-switch-no-default",
        "  let n: i32 = 7;\n  switch (n) { case 1: n = 0; break; }\n  return n;",
      ),
    ).toBe(7);
  });

  test("a `return` inside a clause returns from the function", async () => {
    expect(
      await exits(
        "cf-switch-return",
        "  const a: i32 = 1;\n  switch (a) { case 1: return 11; default: return 22; }",
      ),
    ).toBe(11);
  });

  test("`break` leaves the switch and `continue` leaves the loop around it", async () => {
    // JavaScript's rule, and the reason a switch frame records no continue
    // target: `continue` inside one continues the *loop*.
    const body =
      "  let total: i32 = 0;\n  let i: i32 = 0;\n" +
      "  while (i < 5) {\n" +
      "    i = i + 1;\n" +
      "    switch (i) {\n" +
      "      case 2: continue;\n" +
      "      case 3: break;\n" +
      "      default: total = total + 10; break;\n" +
      "    }\n" +
      "    total = total + 1;\n" +
      "  }\n  return total;";
    // i=1 default (+10, +1), i=2 continue (neither), i=3 break (+1),
    // i=4 and i=5 default (+10, +1 each). Kept under 256 on purpose: an exit
    // code is eight bits, and 304 would observe as 48.
    expect(await exits("cf-switch-continue", body)).toBe(34);
  });

  test("it switches on a string, comparing by value", async () => {
    const result = await run(
      "cf-switch-string",
      `function name(n: i32): string {
         switch (n) {
           case 1: return "one";
           case 2: return "two";
           default: return "many";
         }
       }

       export function main(): i32 {
         const word: string = name(2);
         switch (word) {
           case "one": console.log("1"); break;
           case "two": console.log("2"); break;
           default: console.log("?"); break;
         }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("2\n");
    expect(result.leaked).toBe(0);
  });

  test("an owning subject is released once, on every path", async () => {
    // The subject is evaluated once into a *binding* rather than a temporary,
    // because the dispatch branches away on each test: a temporary would be
    // released only on the path that fell through all of them.
    const result = await run(
      "cf-switch-owning-subject",
      `export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) {
           switch (\`v\${i % 3}\`) {
             case "v0": break;
             case "v1": break;
             default: break;
           }
           i = i + 1;
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("a clause may declare its own bindings", async () => {
    const result = await run(
      "cf-switch-clause-scope",
      `export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) {
           switch (i % 2) {
             case 0: {
               const s: string = \`a\${i}\`;
               console.log(s);
               break;
             }
             default: break;
           }
           i = i + 1;
         }
         return 0;
       }\n`,
    );
    expect(result.stdout.split("\n").length).toBe(11);
    expect(result.leaked).toBe(0);
  });

  test("switching on a struct is refused, as `===` on one is", async () => {
    await expectRejected(
      "cf-switch-struct",
      `interface P { x: i32; }

       export function main(): i32 {
         const p: P = { x: 1 };
         switch (p) { default: return 0; }
       }\n`,
      "GF0002",
    );
  });
});

describe("`for…of`", () => {
  test("it walks a `T[]` in order", async () => {
    expect(
      await exits(
        "cf-forof-sum",
        "  const xs: i32[] = [1, 2, 3, 4];\n  let total: i32 = 0;\n" +
          "  for (const x of xs) { total = total * 10 + x; }\n  return total;",
      ),
    ).toBe(1234 % 256);
  });

  test("an empty array runs the body no times", async () => {
    expect(
      await exits(
        "cf-forof-empty",
        "  const xs: i32[] = [];\n  let n: i32 = 0;\n" +
          "  for (const x of xs) { n = n + x; }\n  return n;",
      ),
    ).toBe(0);
  });

  test("`break` and `continue` work inside it", async () => {
    expect(
      await exits(
        "cf-forof-break",
        "  const xs: i32[] = [1, 2, 3, 4, 5];\n  let total: i32 = 0;\n" +
          "  for (const x of xs) { if (x === 2) { continue; } if (x === 4) { break; } total = total + x; }\n" +
          "  return total;",
      ),
    ).toBe(4);
  });

  test("the bound is re-read, so the array may be read through twice", async () => {
    const result = await run(
      "cf-forof-twice",
      `export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         let total: i32 = 0;
         for (const x of xs) { total = total + x; }
         for (const x of xs) { total = total + x; }
         return total;
       }\n`,
    );
    expect(result.exitCode).toBe(12);
    expect(result.leaked).toBe(0);
  });

  test("an owning element is copied in and released every iteration", async () => {
    const result = await run(
      "cf-forof-strings",
      `export function main(): i32 {
         const xs: string[] = [];
         let i: i32 = 0;
         while (i < 20) { xs.push(\`v\${i}\`); i = i + 1; }
         let n: usize = 0;
         for (const s of xs) { n = n + s.length; }
         console.log(\`\${n}\`);
         return 0;
       }\n`,
    );
    // "v0".."v9" are two bytes and "v10".."v19" are three: 20 + 30 = 50.
    expect(result.stdout).toBe("50\n");
    expect(result.leaked).toBe(0);
  });

  test("`break` out of a `for…of` releases the element binding", async () => {
    const result = await run(
      "cf-forof-break-owning",
      `export function main(): i32 {
         const xs: string[] = [];
         let i: i32 = 0;
         while (i < 20) { xs.push(\`v\${i}\`); i = i + 1; }
         let n: i32 = 0;
         while (n < 20) {
           for (const s of xs) { if (s.length > 0) { break; } }
           n = n + 1;
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });
});

describe("labels", () => {
  test("`break outer` leaves both loops", async () => {
    expect(
      await exits(
        "cf-label-break",
        "  let hits: i32 = 0;\n" +
          "  outer: while (true) {\n" +
          "    let j: i32 = 0;\n" +
          "    while (j < 10) { hits = hits + 1; if (hits === 3) { break outer; } j = j + 1; }\n" +
          "  }\n  return hits;",
      ),
    ).toBe(3);
  });

  test("a bare `break` still leaves only the inner loop", async () => {
    expect(
      await exits(
        "cf-label-break-inner",
        "  let hits: i32 = 0;\n  let i: i32 = 0;\n" +
          "  outer: while (i < 3) {\n" +
          "    i = i + 1;\n" +
          "    let j: i32 = 0;\n" +
          "    while (j < 10) { hits = hits + 1; break; }\n" +
          "  }\n  return hits;",
      ),
    ).toBe(3);
  });

  test("`continue outer` continues the outer loop", async () => {
    expect(
      await exits(
        "cf-label-continue",
        "  let hits: i32 = 0;\n  let i: i32 = 0;\n" +
          "  outer: while (i < 4) {\n" +
          "    i = i + 1;\n" +
          "    let j: i32 = 0;\n" +
          "    while (j < 4) { j = j + 1; if (j === 2) { continue outer; } hits = hits + 1; }\n" +
          "    hits = hits + 100;\n" +
          "  }\n  return hits;",
      ),
    ).toBe(4);
  });

  test("`break label` out of a labelled block jumps forward", async () => {
    expect(
      await exits(
        "cf-label-block",
        "  let n: i32 = 1;\n  done: { n = 2; if (n === 2) { break done; } n = 99; }\n  return n;",
      ),
    ).toBe(2);
  });

  test("a labelled loop releases what it opened when it is left", async () => {
    const result = await run(
      "cf-label-owning",
      `export function main(): i32 {
         let i: i32 = 0;
         outer: while (i < 20) {
           const s: string = \`v\${i}\`;
           i = i + 1;
           let j: i32 = 0;
           while (j < 3) {
             const t: string = \`w\${j}\`;
             if (t.length > 0) { continue outer; }
             j = j + 1;
           }
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("`break outer` from inside a `switch` leaves the loop, not the switch", async () => {
    expect(
      await exits(
        "cf-label-switch",
        "  let hits: i32 = 0;\n  let i: i32 = 0;\n" +
          "  outer: while (i < 5) {\n" +
          "    i = i + 1;\n" +
          "    switch (i) {\n" +
          "      case 3: break outer;\n" +
          "      default: hits = hits + 1; break;\n" +
          "    }\n" +
          "    hits = hits + 10;\n" +
          "  }\n  return hits;",
      ),
    ).toBe(22);
  });
});
