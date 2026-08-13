/**
 * `T[]` — the language's `std::vector`.
 *
 * An owning, growable handle whose elements live inline in one heap buffer,
 * with the same shape a `string` has: one machine word, a header behind the
 * pointer, `length` a load rather than a scan.
 *
 * The distinction this file exists to hold down is the one against
 * `FixedArray<T, N>`, which is tested next door. A fixed array **is** its
 * elements — inline, no allocation, length in the type. A `T[]` is a *handle*
 * to elements it owns, which is why it can grow, why copying one allocates,
 * and why indexing it is one indirection further down. Getting that second
 * indirection wrong reads the handle as element zero, and the first version of
 * this feature did exactly that: `xs[0]` came back as the low half of a
 * pointer, which is a plausible-looking integer.
 *
 * Every test here runs through {@link run}, so every one also asserts the live
 * allocation count is zero afterwards.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("construction", () => {
  test("a literal, read back by constant index", async () => {
    const result = await run(
      "vec-literal",
      `export function main(): i32 {
         const xs: i32[] = [10, 20, 30];
         return xs[0] + xs[2];
       }\n`,
    );
    expect(result.exitCode).toBe(40);
  });

  test("`length` is a load, and counts elements", async () => {
    const result = await run(
      "vec-length",
      `export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         console.log(\`\${xs.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("3\n");
  });

  test("an empty array holds no buffer and allocates nothing", async () => {
    // As an empty `std::vector` does not. The runtime hands back a shared
    // static header with `cap = 0`, so freeing it is a no-op — the same trick
    // a string literal plays with `owned = 0`.
    const result = await run(
      "vec-empty",
      `export function main(): i32 {
         const xs: i32[] = [];
         console.log(\`\${xs.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("0\n");
    expect(result.leaked).toBe(0);
  });

  test("`Array<T>` and `T[]` are the same type", async () => {
    const result = await run(
      "vec-array-alias",
      `function total(xs: Reference<Array<i32>>): i32 {
         let sum: i32 = 0;
         let i: usize = 0;
         while (i < xs.length) { sum = sum + xs[i]; i = i + 1; }
         return sum;
       }

       export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         return total(xs);
       }\n`,
    );
    expect(result.exitCode).toBe(6);
  });
});

describe("indexing", () => {
  test("an element is written through a constant index", async () => {
    const result = await run(
      "vec-write-const",
      `export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         xs[1] = 9;
         return xs[1];
       }\n`,
    );
    expect(result.exitCode).toBe(9);
  });

  test("a computed index reads and writes the same element", async () => {
    const result = await run(
      "vec-write-var",
      `export function main(): i32 {
         const xs: i32[] = [0, 0, 0, 0];
         let i: usize = 0;
         while (i < xs.length) { xs[i] = nativeCast<i32>(i) * 2; i = i + 1; }
         return xs[3];
       }\n`,
    );
    expect(result.exitCode).toBe(6);
  });

  test("the index is a `usize`, as `length` is", async () => {
    const diagnostic = await expectRejected(
      "vec-index-i32",
      `export function main(): i32 {
         const xs: i32[] = [1, 2];
         let i: i32 = 0;
         return xs[i];
       }\n`,
      "GF0161",
    );
    expect(diagnostic.message).toContain("usize");
  });

  test("elements of struct type are inline, and reached by field", async () => {
    const result = await run(
      "vec-struct-elements",
      `interface P { x: i32; y: i32; }

       export function main(): i32 {
         const xs: P[] = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
         return xs[1].x + xs[1].y;
       }\n`,
    );
    expect(result.exitCode).toBe(7);
  });

  test("an array of arrays indexes twice", async () => {
    const result = await run(
      "vec-nested",
      `export function main(): i32 {
         const xs: i32[][] = [[1, 2], [3, 4]];
         return xs[1][0];
       }\n`,
    );
    expect(result.exitCode).toBe(3);
  });
});

describe("growth", () => {
  test("`push` appends and `length` follows", async () => {
    const result = await run(
      "vec-push",
      `export function main(): i32 {
         const xs: i32[] = [];
         xs.push(7);
         xs.push(8);
         console.log(\`\${xs.length} \${xs[0]} \${xs[1]}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("2 7 8\n");
    expect(result.leaked).toBe(0);
  });

  test("growing past the initial capacity keeps every element", async () => {
    // The reallocation path: the buffer doubles from a floor of four, so forty
    // pushes relocate the elements several times. A byte copy is right there
    // and only there — the elements are moved, not duplicated.
    const result = await run(
      "vec-push-many",
      `export function main(): i32 {
         const xs: i32[] = [];
         let i: i32 = 0;
         while (i < 40) { xs.push(i * 2); i = i + 1; }
         console.log(\`\${xs.length} \${xs[0]} \${xs[39]}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("40 0 78\n");
    expect(result.leaked).toBe(0);
  });

  test("growing an array of owning elements does not duplicate them", async () => {
    const result = await run(
      "vec-push-strings",
      `export function main(): i32 {
         const xs: string[] = [];
         let i: i32 = 0;
         while (i < 20) { xs.push(\`v\${i}\`); i = i + 1; }
         console.log(\`\${xs.length} \${xs[0]} \${xs[19]}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("20 v0 v19\n");
    expect(result.leaked).toBe(0);
  });

  test("`push` copies its argument, as every other assignment does", async () => {
    const result = await run(
      "vec-push-copies",
      `export function main(): i32 {
         const s: string = "a" + "b";
         const xs: string[] = [];
         xs.push(s);
         console.log(s + xs[0]);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("abab\n");
    expect(result.leaked).toBe(0);
  });

  test("`pop` takes the last element and shortens the array", async () => {
    const result = await run(
      "vec-pop",
      `export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         const last: i32 = xs.pop();
         console.log(\`\${last} \${xs.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("3 2\n");
  });

  test("`pop` of an owning element moves it out rather than copying", async () => {
    // The array must not release what it handed over, and the binding must.
    // Either mistake shows up as a leak or a double free rather than as output.
    const result = await run(
      "vec-pop-owning",
      `export function main(): i32 {
         const xs: string[] = ["a" + "b", "c" + "d"];
         const last: string = xs.pop();
         console.log(\`\${last} \${xs.length} \${xs[0]}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("cd 1 ab\n");
    expect(result.leaked).toBe(0);
  });

  test("push and pop in a loop settle back to nothing", async () => {
    const result = await run(
      "vec-churn",
      `export function main(): i32 {
         const xs: string[] = [];
         let i: i32 = 0;
         while (i < 30) {
           xs.push(\`item \${i}\`);
           if (i % 2 === 0) { const gone: string = xs.pop(); }
           i = i + 1;
         }
         console.log(\`\${xs.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("15\n");
    expect(result.leaked).toBe(0);
  });
});

describe("value semantics", () => {
  test("binding copies the buffer, so writing one does not touch the other", async () => {
    const result = await run(
      "vec-copy",
      `export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         const ys: i32[] = xs;
         ys[0] = 99;
         console.log(\`\${xs[0]} \${ys[0]}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("1 99\n");
    expect(result.leaked).toBe(0);
  });

  test("copying an array of owning elements copies each element too", async () => {
    // The trap this rules out: a byte copy of the buffer is right for `i32[]`
    // and a double free for `string[]`, because both handles would own the
    // same strings. The operation comes from the element's type.
    const result = await run(
      "vec-copy-owning",
      `export function main(): i32 {
         const xs: string[] = ["a" + "b", "c" + "d"];
         const ys: string[] = xs;
         console.log(xs[0] + ys[0] + xs[1] + ys[1]);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ababcdcd\n");
    expect(result.leaked).toBe(0);
  });

  test("a by-value parameter is a copy the callee cannot write back through", async () => {
    const result = await run(
      "vec-by-value",
      `function bump(v: i32[]): i32 {
         v[0] = 99;
         return v[0];
       }

       export function main(): i32 {
         const xs: i32[] = [1];
         const inside: i32 = bump(xs);
         console.log(\`\${inside} \${xs[0]}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("99 1\n");
    expect(result.leaked).toBe(0);
  });

  test("a `Reference<T[]>` does not copy, and reaches the caller's elements", async () => {
    const result = await run(
      "vec-reference",
      `function bump(v: Reference<i32[]>): void {
         v[0] = 99;
       }

       export function main(): i32 {
         const xs: i32[] = [1];
         bump(xs);
         return xs[0];
       }\n`,
    );
    expect(result.exitCode).toBe(99);
  });

  test("a reference can be read from without copying anything", async () => {
    const result = await run(
      "vec-reference-read",
      `function total(v: Reference<i32[]>): i32 {
         let sum: i32 = 0;
         let i: usize = 0;
         while (i < v.length) { sum = sum + v[i]; i = i + 1; }
         return sum;
       }

       export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         return total(xs) + total(xs);
       }\n`,
    );
    expect(result.exitCode).toBe(12);
  });

  test("an array is released with its scope, and so are its elements", async () => {
    const result = await run(
      "vec-scope",
      `export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) {
           const xs: string[] = [\`a\${i}\`, \`b\${i}\`];
           i = i + 1;
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("an array returned from a function is moved out, not copied", async () => {
    const result = await run(
      "vec-return",
      `function build(): string[] {
         const xs: string[] = ["a" + "b"];
         return xs;
       }

       export function main(): i32 {
         console.log(build()[0]);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ab\n");
    expect(result.leaked).toBe(0);
  });

  test("an array inside a struct is owned by it", async () => {
    const result = await run(
      "vec-in-struct",
      `interface Bag { items: string[]; }

       export function main(): i32 {
         const a: Bag = { items: ["x" + "y"] };
         const b: Bag = a;
         console.log(a.items[0] + b.items[0]);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("xyxy\n");
    expect(result.leaked).toBe(0);
  });

  test("an array field of a class is released by the generated destructor", async () => {
    const result = await run(
      "vec-in-class",
      `class Bag {
         items: string[];
         constructor(first: string) { this.items = [first]; }
       }

       export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) { const bag = new Bag(\`v\${i}\`); i = i + 1; }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("`move` hands the buffer over without copying it", async () => {
    const result = await run(
      "vec-move",
      `export function main(): i32 {
         const xs: string[] = ["a" + "b"];
         const ys: string[] = move(xs);
         console.log(ys[0]);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ab\n");
    expect(result.leaked).toBe(0);
  });

  test("reading a moved-from array is GF0235", async () => {
    await expectRejected(
      "vec-move-read",
      `export function main(): i32 {
         const xs: i32[] = [1];
         const ys: i32[] = move(xs);
         return xs[0];
       }\n`,
      "GF0235",
    );
  });
});

describe("what `T[]` is not", () => {
  test("it cannot cross the C boundary", async () => {
    // It owns a heap buffer, and nothing in a C signature says who frees it.
    const diagnostic = await expectRejected(
      "vec-boundary",
      `export function take(xs: i32[]): i32 { return 0; }

       export function main(): i32 { return 0; }\n`,
      "GF0301",
    );
    expect(diagnostic.message).toContain("owns");
  });

  test("it has `push`, `pop` and `length`, and nothing else yet", async () => {
    // The prelude declares the whole surface, so a method that is not there is
    // tsc's to refuse — which means it is underlined while you type rather than
    // reported at build time. `map` and `filter` are absent for a reason that
    // outlasts this milestone: they take a callback, and the language has no
    // closures.
    for (const method of ["slice", "map", "indexOf", "concat", "reverse"]) {
      const { result } = await compileSource(
        `vec-no-${method}`,
        `export function main(): i32 {
           const xs: i32[] = [1, 2];
           xs.${method}(1);
           return 0;
         }\n`,
      );
      expect({ method, ok: result.ok }).toEqual({ method, ok: false });
      expect({ method, tsc: errorCodes(result).some((c) => c.startsWith("TS")) }).toEqual({
        method,
        tsc: true,
      });
    }
  });

  test("a spread element is GF0001", async () => {
    await expectRejected(
      "vec-spread",
      `export function main(): i32 {
         const xs: i32[] = [1, 2];
         const ys: i32[] = [0, ...xs];
         return 0;
       }\n`,
      "GF0001",
    );
  });

  test("an untyped empty literal has nothing to take an element type from", async () => {
    const { result } = await compileSource(
      "vec-untyped",
      `export function main(): i32 {
         const xs = [];
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).length).toBeGreaterThan(0);
  });
});
