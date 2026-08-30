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
         while (i < xs.length) { xs[i] = cast<i32>(i) * 2; i = i + 1; }
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

/**
 * `capacity` and `reserve` — room, as opposed to length.
 *
 * These exist so that a growth policy can be *written* rather than accepted.
 * `push` on its own doubles, which is the right default and allocates a second
 * buffer beside the first at every step; `reserve` goes through the allocator's
 * `realloc`, so growing in fixed steps can extend the block in place.
 *
 * What is asserted here is the contract — the room, the length, the elements —
 * and never that a particular growth happened in place. That is mimalloc's
 * decision and it is allowed to move the block; a test that required otherwise
 * would be testing the allocator.
 */
describe("capacity and reserve", () => {
    test("an empty array holds no buffer, so it has no room", async () => {
        const result = await run(
            "vec-capacity-empty",
            `export function main(): i32 {
         const xs: i32[] = [];
         console.log(\`\${xs.length} \${xs.capacity}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("0 0\n");
    });

    test("reserve delivers the room and does not change the length", async () => {
        const result = await run(
            "vec-reserve",
            `export function main(): i32 {
         const xs: i32[] = [];
         xs.reserve(1000);
         console.log(\`\${xs.length} \${xs.capacity}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("0 1000\n");
    });

    test("pushing up to the reserved capacity does not reallocate", async () => {
        // The observable half of "reserve means what it says": a thousand pushes
        // after a thousand-element reserve leave the capacity exactly where it
        // was, so no growth happened on the way.
        const result = await run(
            "vec-reserve-fill",
            `export function main(): i32 {
         const xs: i32[] = [];
         xs.reserve(1000);
         for (let i: usize = 0; i < 1000; i = i + 1) { xs.push(cast<i32>(i)); }
         console.log(\`\${xs.length} \${xs.capacity} \${xs[0]} \${xs[999]}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1000 1000 0 999\n");
    });

    test("reserve never shrinks", async () => {
        // A shrink would be a reallocation that invalidates every pointer into
        // the array, asked for by a number smaller than the one already there.
        const result = await run(
            "vec-reserve-shrink",
            `export function main(): i32 {
         const xs: i32[] = [];
         xs.reserve(64);
         xs.reserve(4);
         console.log(\`\${xs.capacity}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("64\n");
    });

    test("growing an existing buffer keeps every element", async () => {
        // The reallocation path, which is the one that has something to lose:
        // the elements are relocated by the allocator rather than copied by the
        // compiler, and a wrong alignment or offset loses them silently.
        const result = await run(
            "vec-reserve-regrow",
            `export function main(): i32 {
         const xs: i32[] = [];
         xs.reserve(8);
         for (let i: usize = 0; i < 8; i = i + 1) { xs.push(cast<i32>(i) * 3); }
         xs.reserve(4096);
         let sum: i32 = 0;
         for (let i: usize = 0; i < xs.length; i = i + 1) { sum = sum + xs[i]; }
         console.log(\`\${xs.length} \${xs.capacity} \${sum} \${xs[7]}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("8 4096 84 21\n");
    });

    test("owning elements survive a reserve, and are released once", async () => {
        // A `string[]` is the case where getting relocation wrong is a double
        // free rather than a wrong number. The automatic leak check is the other
        // half of this assertion.
        const result = await run(
            "vec-reserve-strings",
            `export function main(): i32 {
         const xs: string[] = [];
         xs.reserve(2);
         for (let i: i32 = 0; i < 40; i = i + 1) { xs.push(\`item \${i}\`); }
         xs.reserve(4096);
         console.log(\`\${xs[0]} | \${xs[39]} | \${xs.length}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("item 0 | item 39 | 40\n");
        expect(result.leaked).toBe(0);
    });

    test("a wide struct element survives a reserve intact", async () => {
        // Four `f64` per element, so a stride the compiler supplies from
        // `SizeOf` rather than one the runtime could guess.
        //
        // This does *not* exercise the over-aligned branch of `raw_realloc_at`:
        // nothing reachable from Goblin source wants more than eight bytes of
        // alignment today, since a linalg type is an ordinary struct of `f64`.
        // That branch is covered directly, at six alignments, by
        // `reserve_grows_in_place_and_keeps_what_was_there` in the runtime crate.
        const result = await run(
            "vec-reserve-aligned",
            `import { dvec4 } from "std/linalg";

       export function main(): i32 {
         const xs: dvec4[] = [];
         xs.reserve(4);
         for (let i: i32 = 0; i < 4; i = i + 1) {
           xs.push(new dvec4(cast<f64>(i), 1.0, 2.0, 3.0));
         }
         xs.reserve(2048);
         xs.push(new dvec4(9.0, 9.0, 9.0, 9.0));
         console.log(\`\${xs[0].x} \${xs[3].x} \${xs[4].w} \${xs.length}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("0 3 9 5\n");
    });

    test("a growth policy in fixed steps, which is what this is for", async () => {
        // The capacity lands on a multiple of the step rather than on a power of
        // two, which is the observable difference between this policy and the
        // doubling `push` does on its own. Twenty elements in steps of eight is
        // 8, 16, 24 — where doubling would have reached 32.
        const result = await run(
            "vec-reserve-steps",
            `export function main(): i32 {
         const step: usize = 8;
         const xs: f64[] = [];
         for (let i: usize = 0; i < 20; i = i + 1) {
           if (xs.length === xs.capacity) { xs.reserve(xs.capacity + step); }
           xs.push(cast<f64>(i));
         }
         console.log(\`\${xs.length} \${xs.capacity} \${xs[19]}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("20 24 19\n");
    });

    test("reserve reaches an array behind a reference", async () => {
        const result = await run(
            "vec-reserve-reference",
            `function make(xs: Reference<i32[]>): void {
         xs.reserve(256);
         xs.push(7);
       }

       export function main(): i32 {
         const xs: i32[] = [];
         make(xs);
         console.log(\`\${xs.length} \${xs.capacity} \${xs[0]}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 256 7\n");
    });

    test("`capacity` and `reserve` are a `T[]`'s, not a `FixedArray`'s", async () => {
        // A fixed array has no buffer to have room in and its length *is* its
        // capacity, so neither question means anything there. tsc is what says
        // so — the prelude declares both on `Array<T>` and not on
        // `FixedArray<T, N>` — which is the better refusal of the two available,
        // because it arrives in the editor.
        await expectRejected(
            "vec-capacity-fixed",
            `export function main(): i32 {
         const xs: FixedArray<i32, 4> = fixedArray(4, 0);
         console.log(\`\${xs.capacity}\`);
         return 0;
       }\n`,
            "TS2339",
        );
        await expectRejected(
            "vec-reserve-fixed",
            `export function main(): i32 {
         const xs: FixedArray<i32, 4> = fixedArray(4, 0);
         xs.reserve(8);
         return 0;
       }\n`,
            "TS2339",
        );
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

    test("assigning an array to itself is not a self-destruction", async () => {
        const result = await run(
            "vec-self-assign",
            `export function main(): i32 {
         let xs: string[] = ["a" + "b", "c" + "d"];
         xs = xs;
         console.log(xs[0] + xs[1]);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("abcd\n");
        expect(result.leaked).toBe(0);
    });

    test("an element may be assigned from another element of the same array", async () => {
        // `xs[i] = xs[j]` reads and writes the same buffer, and whether the two
        // indices are equal is not something the compiler can see. The element
        // being overwritten is therefore copied *before* the old one is released,
        // for both `i === j` and `i !== j` — the first is the one that corrupts.
        const result = await run(
            "vec-element-self-assign",
            `export function main(): i32 {
         let xs: string[] = ["a" + "b", "c" + "d"];
         xs[0] = xs[0];
         xs[1] = xs[0];
         console.log(xs[0] + " " + xs[1]);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab ab\n");
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
            const {result} = await compileSource(
                `vec-no-${method}`,
                `export function main(): i32 {
           const xs: i32[] = [1, 2];
           xs.${method}(1);
           return 0;
         }\n`,
            );
            expect({method, ok: result.ok}).toEqual({method, ok: false});
            expect({method, tsc: errorCodes(result).some((c) => c.startsWith("TS"))}).toEqual({
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
        const {result} = await compileSource(
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
