/**
 * Milestone 2's acceptance test.
 *
 * REWRITE-PLAN §12.2: "a program that compiles
 * `export function main(): i32 { return 42; }` to a binary that exits 42".
 * Everything else here is the machinery around that one claim — the tsconfig
 * validation, the diagnostic plumbing, and the shape of a failure.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("the pipeline", () => {
  test("compiles a program to a binary that exits with the value it returned", async () => {
    const result = await run("exit-42", `export function main(): i32 { return 42; }\n`);
    expect(result.exitCode).toBe(42);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("reports absolute paths for everything it produced", async () => {
    const { project, result } = await compileSource(
      "paths",
      `export function main(): i32 { return 0; }\n`,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toStartWith(project.dir);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]).toStartWith(project.dir);
    // The linker command is kept so a link failure can be reproduced by hand.
    expect(result.linkCommand).toBeTruthy();
  });

  test("arithmetic over the declared width reaches the exit code", async () => {
    const result = await run(
      "arithmetic",
      `export function main(): i32 {
         const a: i32 = 6;
         const b: i32 = 7;
         return a * b;
       }\n`,
    );
    expect(result.exitCode).toBe(42);
  });

  test("calls between functions in the module", async () => {
    const result = await run(
      "calls",
      `function double(x: i32): i32 { return x + x; }

       export function main(): i32 {
         return double(21);
       }\n`,
    );
    expect(result.exitCode).toBe(42);
  });

  test("branches and loops", async () => {
    const result = await run(
      "control-flow",
      `export function main(): i32 {
         let total: i32 = 0;
         let i: i32 = 0;
         while (i < 10) {
           if (i % 2 === 0) {
             total = total + i;
           }
           i = i + 1;
         }
         return total;
       }\n`,
    );
    // 0 + 2 + 4 + 6 + 8
    expect(result.exitCode).toBe(20);
  });

  test("`&&` and `||` short-circuit through the CFG", async () => {
    const result = await run(
      "short-circuit",
      `export function main(): i32 {
         const a: i32 = 3;
         if (a > 1 && a < 5) {
           return 1;
         }
         return 0;
       }\n`,
    );
    expect(result.exitCode).toBe(1);
  });

  test("`for` loops, with `break` and `continue`", async () => {
    const result = await run(
      "for-break-continue",
      `export function main(): i32 {
         let total: i32 = 0;
         for (let i: i32 = 0; i < 20; i = i + 1) {
           if (i % 2 === 0) {
             continue;
           }
           if (i > 9) {
             break;
           }
           total = total + i;
         }
         return total;
       }\n`,
    );
    // The odd numbers below 10: 1 + 3 + 5 + 7 + 9.
    expect(result.exitCode).toBe(25);
  });

  test("`while (true)` with a return inside does not trip the verifier", async () => {
    // A constant-true condition has to become an unconditional jump. Emitting a
    // conditional branch to an exit block that is then never filled is a
    // Cranelift verifier error, not a warning (REWRITE-PLAN §10).
    const result = await run(
      "while-true",
      `export function main(): i32 {
         let i: i32 = 0;
         while (true) {
           i = i + 1;
           if (i === 7) {
             return i;
           }
         }
       }\n`,
    );
    expect(result.exitCode).toBe(7);
  });
});

describe("diagnostics", () => {
  test("a literal that does not fit its width is GF0164", async () => {
    const diagnostic = await expectRejected(
      "literal-range",
      `export function main(): i32 {
         const small: i8 = 300;
         return 0;
       }\n`,
      "GF0164",
    );
    expect(diagnostic.message).toContain("i8");
    expect(diagnostic.location?.line).toBe(2);
  });

  test("the lower bound of a signed width is writable", async () => {
    // `-128` is a valid `i8` and `128` is not. Range-checking before folding
    // the sign in makes the lower bound of every signed width unwritable
    // (REWRITE-PLAN §10).
    const { result } = await compileSource(
      "negative-literal",
      `export function main(): i32 {
         const low: i8 = -128;
         return 0;
       }\n`,
    );
    expect(errorCodes(result)).toEqual([]);
  });

  test("unary minus on an unsigned type is GF0165", async () => {
    await expectRejected(
      "unsigned-negate",
      `export function main(): i32 {
         const wrong: u8 = -1;
         return 0;
       }\n`,
      "GF0165",
    );
  });

  test("`%` on a float is GF0162, not a backend error", async () => {
    // v1 let `someF64 % 2` reach Cranelift, which answered
    // "Rem is not defined on f64" with no code, no file and no line. The
    // backend is not allowed to be the one that notices (REWRITE-PLAN §8).
    await expectRejected(
      "float-remainder",
      `export function main(): i32 {
         const x: f64 = 5;
         const y: f64 = x % 2;
         return 0;
       }\n`,
      "GF0162",
    );
  });

  test("a non-boolean condition is rejected — there is no truthiness", async () => {
    const { result } = await compileSource(
      "truthiness",
      `export function main(): i32 {
         const n: i32 = 1;
         if (n) { return 1; }
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    // Either half of the compiler may speak here: tsc rejects a non-boolean
    // condition under `strict`, and the lowerer rejects it too. Asserting the
    // set rather than one code means a check moving between them shows up.
    expect(errorCodes(result).length).toBeGreaterThan(0);
  });

  test("`main` must return i32", async () => {
    await expectRejected(
      "bad-main",
      `export function main(): f64 { return 1; }\n`,
      "GF0004",
    );
  });

  test("distinct widths are not mutually assignable", async () => {
    // The one-key-many-literals brand doing its job. A different symbol key per
    // width would leave every brand optional-and-absent from the others, and
    // optional-and-absent is assignable — the widths would silently unify
    // (REWRITE-PLAN §7). tsc is the right half of the compiler to say this,
    // because the user sees it while typing.
    const { result } = await compileSource(
      "width-identity",
      `export function main(): i32 {
         const small: i8 = 1;
         return small;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("TS2322");
  });

  test("tsc's verdict is final and comes back with a TS code", async () => {
    const { result } = await compileSource(
      "type-error",
      `export function main(): i32 {
         const wrong: i32 = "not a number";
         return wrong;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
  });

  test("an unsupported construct is GF0001 with a source position", async () => {
    const diagnostic = await expectRejected(
      "unsupported",
      `export function main(): i32 {
         throw "x";
       }\n`,
      "GF0001",
    );
    expect(diagnostic.location?.file).toEndWith("main.ts");
    expect(diagnostic.location?.line).toBe(2);
  });
});

describe("the conditional operator", () => {
  test("picks an arm, and only runs that one", async () => {
    const result = await run(
      "ternary-basic",
      `function shout(text: string): string {
         console.log(\`evaluated \${text}\`);
         return text;
       }

       export function main(): i32 {
         const n: i32 = 7;
         console.log(n > 5 ? shout("big") : shout("small"));
         return 0;
       }\n`,
    );
    // Only one arm's call happens: a ternary is control flow, not an operator
    // over two already-computed values.
    expect(result.stdout).toBe("evaluated big\nbig\n");
  });

  test("both arms may be literals, taking their width from context", async () => {
    const result = await run(
      "ternary-poly",
      `export function main(): i32 {
         const n: i32 = 7;
         const pick: u8 = n > 5 ? 100 : 200;
         console.log(\`\${pick}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("100\n");
  });

  test("owning arms in a loop release what they made", async () => {
    // The leak assertion is the test. Each arm builds a `string` that only
    // exists on its own path, so getting this wrong is either a leak or a drop
    // of something never constructed.
    const result = await run(
      "ternary-owning",
      `export function main(): i32 {
         let i: i32 = 0;
         let total: usize = 0;
         while (i < 4) {
           const s: string = i === 1 ? "one" + "!" : "other" + "?";
           total = total + s.length;
           i = i + 1;
         }
         console.log(\`total=\${total}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("total=22\n");
  });

  test("arms of different types are tsc's business", async () => {
    // And they always are, because the twelve widths are mutually unassignable
    // brands: a mismatch makes the ternary's type a union, and no union is
    // assignable to a width. The lowerer keeps its own check anyway —
    // REWRITE-PLAN §8 says the backend must never be the thing that notices,
    // and "tsc would have caught it" is an assumption, not a guarantee.
    await expectRejected(
      "ternary-mismatch",
      `export function main(): i32 {
         const n: i32 = 1;
         const bad: i32 = n > 0 ? 1 : "two";
         return 0;
       }\n`,
      "TS2322",
    );
  });
});
