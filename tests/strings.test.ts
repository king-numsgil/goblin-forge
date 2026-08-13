/**
 * `string`, the first owning type.
 *
 * REWRITE-PLAN §12.5 puts strings first because they are one machine word and
 * so exercise copy, move, destroy and temporaries without raising a single
 * layout question.
 *
 * Every test here runs through {@link run}, which asserts the live allocation
 * count is zero afterwards — automatically, on every single one. That check is
 * doing at least as much work as the assertions written below it.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("strings", () => {
  test("a literal prints", async () => {
    const result = await run(
      "string-literal",
      `export function main(): i32 {
         console.log("hello");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("hello\n");
    expect(result.leaked).toBe(0);
  });

  test("a literal is static, so nothing is allocated to print one", async () => {
    // Freeing a literal is a no-op the *runtime* decides, which is what makes
    // "the binding's scope releases it" a rule with no exceptions.
    const result = await run(
      "string-literal-static",
      `export function main(): i32 {
         const a: string = "static";
         const b: string = a;
         console.log(b);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("static\n");
    expect(result.leaked).toBe(0);
  });

  test("concatenation, and the temporaries it makes, are released", async () => {
    const result = await run(
      "string-concat",
      `export function main(): i32 {
         const a: string = "foo";
         const b: string = "bar";
         console.log(a + b);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("foobar\n");
  });

  test("template literals interpolate every scalar the same way", async () => {
    const result = await run(
      "string-template",
      `export function main(): i32 {
         const n: i32 = -7;
         const u: u8 = 200;
         const f: f64 = 1.5;
         const whole: f64 = 3;
         const yes: boolean = true;
         console.log(\`i=\${n} u=\${u} f=\${f} w=\${whole} b=\${yes}\`);
         return 0;
       }\n`,
    );
    // `3` rather than `3.0`: a whole float prints the way JavaScript prints it,
    // so a value reads the same as it would in the TypeScript this resembles.
    expect(result.stdout).toBe("i=-7 u=200 f=1.5 w=3 b=true\n");
  });

  test("`length` is a byte count, and it is a load", async () => {
    const result = await run(
      "string-length",
      `export function main(): i32 {
         const s: string = "hello";
         console.log(\`\${s.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("5\n");
  });

  test("a string returned from a function is not copied on the way out", async () => {
    const result = await run(
      "string-return",
      `function greet(name: string): string {
         return \`hello, \${name}\`;
       }

       export function main(): i32 {
         console.log(greet("world"));
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("hello, world\n");
  });

  test("console.warn and console.error go to stderr", async () => {
    // REWRITE-PLAN §9 asks for stderr to be asserted, not just stdout. v1
    // checked it in exactly one test.
    const result = await run(
      "string-streams",
      `export function main(): i32 {
         console.log("out");
         console.error("err");
         console.warn("warn");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\nwarn\n");
  });

  test("strings compare by value", async () => {
    const result = await run(
      "string-equality",
      `export function main(): i32 {
         const a: string = "abc";
         const b: string = "ab" + "c";
         if (a === b) {
           console.log("equal");
         }
         if (a !== "abd") {
           console.log("different");
         }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("equal\ndifferent\n");
  });

  test("a loop that builds strings does not accumulate them", async () => {
    // The one that would have caught v1's "expressions that need statements"
    // problem: every iteration allocates twice and releases twice, and the
    // count at the end is zero.
    const result = await run(
      "string-loop",
      `export function main(): i32 {
         let i: i32 = 0;
         while (i < 50) {
           const line: string = \`line \${i}\`;
           i = i + 1;
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("an early return out of nested scopes releases everything", async () => {
    const result = await run(
      "string-early-return",
      `export function main(): i32 {
         const outer: string = "a" + "a";
         {
           const middle: string = "b" + "b";
           {
             const inner: string = "c" + "c";
             console.log(inner + middle + outer);
             return 0;
           }
         }
       }\n`,
    );
    expect(result.stdout).toBe("ccbbaa\n");
    expect(result.leaked).toBe(0);
  });

  test("`break` out of a loop releases the loop body but not the loop", async () => {
    const result = await run(
      "string-break",
      `export function main(): i32 {
         const label: string = "x" + "y";
         let i: i32 = 0;
         while (i < 10) {
           const inside: string = label + "!";
           if (i === 3) {
             break;
           }
           i = i + 1;
         }
         console.log(label);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("xy\n");
    expect(result.leaked).toBe(0);
  });
});

describe("move", () => {
  test("a moved value can be read through its new name", async () => {
    const result = await run(
      "move-basic",
      `export function main(): i32 {
         const a: string = "a" + "b";
         const b: string = move(a);
         console.log(b);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ab\n");
    expect(result.leaked).toBe(0);
  });

  test("reading a moved-from value is GF0235", async () => {
    const diagnostic = await expectRejected(
      "move-use-after",
      `export function main(): i32 {
         const a: string = "a" + "b";
         const b: string = move(a);
         console.log(a);
         return 0;
       }\n`,
      "GF0235",
    );
    expect(diagnostic.message).toContain("moved");
    expect(diagnostic.location?.line).toBe(4);
  });

  test("moving twice is caught too", async () => {
    await expectRejected(
      "move-twice",
      `export function main(): i32 {
         const a: string = "a" + "b";
         const b: string = move(a);
         const c: string = move(a);
         return 0;
       }\n`,
      "GF0235",
    );
  });

  test("a copy is still a copy, and both are released", async () => {
    const result = await run(
      "move-vs-copy",
      `export function main(): i32 {
         const a: string = "a" + "b";
         const b: string = a;
         console.log(a + b);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("abab\n");
    expect(result.leaked).toBe(0);
  });
});

describe("the value model", () => {
  test("passing a string to a function does not transfer ownership", async () => {
    // REWRITE-PLAN §4.5: the machine value is a one-word handle, so the callee
    // shares the buffer and the caller keeps owning it. The caller makes the
    // copy that *is* the argument, and the caller destroys it.
    const result = await run(
      "value-model-args",
      `function twice(s: string): string {
         return s + s;
       }

       export function main(): i32 {
         const original: string = "ab";
         const doubled: string = twice(original);
         console.log(original);
         console.log(doubled);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ab\nabab\n");
    expect(result.leaked).toBe(0);
  });

  test("a string used many times is copied each time it is stored", async () => {
    const result = await run(
      "value-model-copies",
      `export function main(): i32 {
         const source: string = "x" + "y";
         const a: string = source;
         const b: string = source;
         const c: string = source;
         console.log(a + b + c);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("xyxyxy\n");
    expect(result.leaked).toBe(0);
  });
});

describe("what a string is made of", () => {
  test("`length` counts bytes, not characters", async () => {
    // The prelude is explicit that this is a byte count. `héllo ✓` is seven
    // characters and ten bytes: `é` is two and `✓` is three.
    const result = await run(
      "string-unicode",
      `export function main(): i32 {
         const s: string = "héllo ✓";
         console.log(\`\${s} \${s.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("héllo ✓ 10\n");
  });

  test("the empty string is a string, with a length", async () => {
    const result = await run(
      "string-empty",
      `export function main(): i32 {
         const s: string = "";
         console.log(\`[\${s}] \${s.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("[] 0\n");
    expect(result.leaked).toBe(0);
  });

  test("escapes in a literal reach the output as bytes", async () => {
    const result = await run(
      "string-escapes",
      `export function main(): i32 {
         console.log("a\\tb\\\\c\\"d");
         console.log("e\\nf");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe('a\tb\\c"d\ne\nf\n');
  });

  test("a template with no substitutions is still a string", async () => {
    const result = await run(
      "string-template-plain",
      `export function main(): i32 {
         console.log(\`\`);
         console.log(\`plain\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("\nplain\n");
  });

  test("a template nested inside a substitution", async () => {
    const result = await run(
      "string-template-nested",
      `export function main(): i32 {
         const a: string = "x";
         console.log(\`\${\`\${a}!\`}?\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("x!?\n");
    expect(result.leaked).toBe(0);
  });

  test("a long chain of concatenations releases every intermediate", async () => {
    const result = await run(
      "string-chain",
      `export function main(): i32 {
         const a: string = "a";
         const s: string = a + "b" + a + "c" + a + "d" + a + "e";
         console.log(s);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("abacadae\n");
    expect(result.leaked).toBe(0);
  });

  test("a `let` may be reassigned, and the old value is released first", async () => {
    const result = await run(
      "string-reassign",
      `export function main(): i32 {
         let s: string = "a" + "b";
         s = "c" + "d";
         s = s + "!";
         console.log(s);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("cd!\n");
    expect(result.leaked).toBe(0);
  });

  test("a `let` grown inside a loop does not accumulate", async () => {
    const result = await run(
      "string-grow",
      `export function main(): i32 {
         let s: string = "";
         let i: i32 = 0;
         while (i < 20) { s = s + "x"; i = i + 1; }
         console.log(\`\${s.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("20\n");
    expect(result.leaked).toBe(0);
  });

  test("a moved value may be handed straight to a call", async () => {
    const result = await run(
      "string-move-call",
      `function take(s: string): void { console.log(s); }

       export function main(): i32 {
         const a: string = "a" + "b";
         take(move(a));
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ab\n");
    expect(result.leaked).toBe(0);
  });
});

describe("interpolation", () => {
  test("every width converts the same way", async () => {
    const result = await run(
      "string-interp-widths",
      `export function main(): i32 {
         const a: i8 = -128;
         const b: u8 = 255;
         const c: i16 = -32768;
         const d: u16 = 65535;
         const e: i32 = -2147483648;
         const f: u32 = 4294967295;
         const g: i64 = -9223372036854775808;
         const h: u64 = 18446744073709551615;
         const i: isize = -1;
         const j: usize = 1;
         console.log(\`\${a} \${b} \${c} \${d} \${e} \${f} \${g} \${h} \${i} \${j}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe(
      "-128 255 -32768 65535 -2147483648 4294967295 " +
        "-9223372036854775808 18446744073709551615 -1 1\n",
    );
  });

  test("`console.log` of a scalar means the same as interpolating it", async () => {
    const result = await run(
      "string-console-scalar",
      `export function main(): i32 {
         const n: i32 = 42;
         const b: boolean = true;
         console.log(n);
         console.log(\`\${n}\`);
         console.log(b);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("42\n42\ntrue\n");
  });

  test("`info` and `debug` go to stdout, beside `log`", async () => {
    const result = await run(
      "string-info-debug",
      `export function main(): i32 {
         console.log("l");
         console.info("i");
         console.debug("d");
         console.warn("w");
         console.error("e");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("l\ni\nd\n");
    expect(result.stderr).toBe("w\ne\n");
  });

  test("a bare numeric literal has no width to interpolate", async () => {
    // `console.log(42)` works because the parameter is typed. A literal in a
    // template has nothing to take a width from, and that is GF0161 rather
    // than a silent choice of `i32`.
    await expectRejected(
      "string-interp-literal",
      `export function main(): i32 {
         console.log(\`\${42}\`);
         return 0;
       }\n`,
      "GF0161",
    );
  });
});

describe("what strings are not", () => {
  test("`-` on strings is rejected", async () => {
    const { result } = await compileSource(
      "string-minus",
      `export function main(): i32 {
         const a: string = "a";
         const b: string = a - a;
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    // tsc says so first, which is the right half of the compiler for it.
    expect(errorCodes(result).length).toBeGreaterThan(0);
  });

  test("a string is not a condition", async () => {
    const { result } = await compileSource(
      "string-truthiness",
      `export function main(): i32 {
         const s: string = "a";
         if (s) { return 1; }
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
  });
});
