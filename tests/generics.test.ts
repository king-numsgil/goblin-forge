/**
 * Generics, by monomorphisation.
 *
 * [`GENERICS-PLAN.md`](../GENERICS-PLAN.md) is the design; REWRITE-PLAN §11.7
 * is the question it answers. The claim being tested is a narrow one and worth
 * stating: **a generic is compiled once per set of type arguments, and the
 * copies share nothing but a source declaration.** So the interesting
 * assertions here are not "it compiled" — they are the ones where two
 * instantiations of one function have to behave *differently*, because that is
 * what a single shared body could not do.
 *
 * The sharpest of those is ownership. `hold<string>` has to clone its argument
 * and release it; `hold<i32>` has to do neither. Nothing in the source says so
 * — it falls out of the substituted type having a category — and the harness's
 * automatic live-allocation check is what proves it happened.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("generics", () => {
    test("one generic, one instantiation", async () => {
        const result = await run(
            "generic-identity",
            `function identity<T>(x: T): T { return x; }

       export function main(): i32 {
         return identity<i32>(7);
       }\n`,
        );
        expect(result.exitCode).toBe(7);
    });

    test("two instantiations are two functions", async () => {
        // The one that a shared body could not do: `first<string>` returns a
        // heap handle it has to clone, `first<i32>` returns a register.
        const result = await run(
            "generic-two-instantiations",
            `function first<T>(xs: T[]): T { return xs[0]; }

       export function main(): i32 {
         const numbers: i32[] = [7, 8];
         const words: string[] = ["hello", "there"];
         console.log(first<string>(words));
         return first<i32>(numbers);
       }\n`,
        );
        expect(result.stdout).toBe("hello\n");
        expect(result.exitCode).toBe(7);
        // The automatic check: `first<string>` cloned and the scope released.
        expect(result.leaked).toBe(0);
    });

    test("ownership comes from the substituted type, not from the source", async () => {
        const result = await run(
            "generic-ownership",
            `function hold<T>(x: T): T {
         const copy = x;
         return copy;
       }

       export function main(): i32 {
         const held = hold<string>("held");
         console.log(held);
         return hold<i32>(3);
       }\n`,
        );
        expect(result.stdout).toBe("held\n");
        expect(result.exitCode).toBe(3);
        expect(result.leaked).toBe(0);
    });

    test("a generic calling a generic passes its own `T` on", async () => {
        const result = await run(
            "generic-transitive",
            `function inner<T>(x: T): T { return x; }
       function outer<T>(x: T): T { return inner<T>(x); }

       export function main(): i32 {
         return outer<i32>(5);
       }\n`,
        );
        expect(result.exitCode).toBe(5);
    });

    test("recursion is fine while the type arguments stop growing", async () => {
        const result = await run(
            "generic-recursion",
            `function countDown<T>(x: T, n: i32): i32 {
         if (n <= 0) { return 0; }
         return 1 + countDown<T>(x, n - 1);
       }

       export function main(): i32 {
         return countDown<i32>(0, 4);
       }\n`,
        );
        expect(result.exitCode).toBe(4);
    });

    test("a generic nothing calls emits nothing", async () => {
        // C++ and Rust both do this, and it matters here for the same reason:
        // an uninstantiated body has no machine types in it, so there is
        // nothing that *could* be emitted.
        const result = await run(
            "generic-uninstantiated",
            `function unused<T>(xs: T[]): T { return xs[0]; }

       export function main(): i32 { return 1; }\n`,
        );
        expect(result.exitCode).toBe(1);
    });

    test("an aliased type argument is the same instantiation", async () => {
        // Memoised on the *erased* arguments, so two spellings of `i32` are one
        // copy rather than two identical ones.
        const result = await run(
            "generic-alias",
            `type Count = i32;
       function identity<T>(x: T): T { return x; }

       export function main(): i32 {
         return identity<i32>(2) + identity<Count>(3);
       }\n`,
        );
        expect(result.exitCode).toBe(5);
    });

    test("`T[]` inside a generic body", async () => {
        const result = await run(
            "generic-array-body",
            `function makeOne<T>(x: T): T[] { return [x]; }

       export function main(): i32 {
         const xs = makeOne<i32>(9);
         const words = makeOne<string>("one");
         console.log(words[0]);
         return xs[0];
       }\n`,
        );
        expect(result.stdout).toBe("one\n");
        expect(result.exitCode).toBe(9);
        expect(result.leaked).toBe(0);
    });

    test("`alloc<T>()` inside a generic body", async () => {
        // `Pointer<T>` is spelled as a conditional type, and tsc keeps *both*
        // branches over an unresolved `T` — so the pointee arrives as a union
        // of two things that both say `T`. Erasure sees through that; what it
        // deliberately does not do is make `p.deref()` work, which tsc refuses
        // first. See GENERICS-PLAN §2.
        const result = await run(
            "generic-alloc",
            `function sizeOfBox<T>(): usize {
         const p = alloc<T>();
         const size = sizeOf<T>();
         p.free();
         return size;
       }

       export function main(): i32 {
         return cast<i32>(sizeOfBox<i32>()) + cast<i32>(sizeOfBox<f64>());
       }\n`,
        );
        expect(result.exitCode).toBe(12);
        expect(result.leaked).toBe(0);
    });

    test("type arguments are inferred when the call determines them", async () => {
        const result = await run(
            "generic-inferred",
            `function first<T>(xs: T[]): T { return xs[0]; }
       function pick<A, B>(a: A, b: B): A { return a; }

       export function main(): i32 {
         const numbers: i32[] = [6, 7];
         const words: string[] = ["hi"];
         const n: i32 = 3;
         console.log(first(words));
         return first(numbers) + pick(n, words);
       }\n`,
        );
        expect(result.stdout).toBe("hi\n");
        expect(result.exitCode).toBe(9);
        expect(result.leaked).toBe(0);
    });

    test("inferred and written are the same instantiation", async () => {
        // Memoised on the erased arguments rather than on the spelling, so
        // these are one copy of `identity` and not two identical ones.
        const result = await run(
            "generic-inferred-and-written",
            `function identity<T>(x: T): T { return x; }

       export function main(): i32 {
         const i: i32 = 2;
         return identity(i) + identity<i32>(3);
       }\n`,
        );
        expect(result.exitCode).toBe(5);
    });

    test("inference sees through a generic that is itself being instantiated", async () => {
        const result = await run(
            "generic-inferred-nested",
            `function inner<T>(x: T): T { return x; }
       function outer<T>(x: T): T { return inner(x); }

       export function main(): i32 {
         const i: i32 = 8;
         return outer(i);
       }\n`,
        );
        expect(result.exitCode).toBe(8);
    });

    test("a generic reached through a module namespace instantiates", async () => {
        const result = await run(
            "generic-namespace",
            `import * as helpers from "./helpers.ts";

       export function main(): i32 {
         return helpers.identity<i32>(6);
       }\n`,
            {
                files: {
                    "helpers.ts": "export function identity<T>(x: T): T { return x; }\n",
                },
            },
        );
        expect(result.exitCode).toBe(6);
    });

    describe("what it refuses", () => {
        test("GF0404 — a call that determines nothing", async () => {
            // `T` appears in no argument, so there is nothing at the call for
            // tsc to have read it from either.
            const diagnostic = await expectRejected(
                "generic-undetermined",
                `function sizeOfIt<T>(): usize { return sizeOf<T>(); }

       export function main(): i32 {
         return cast<i32>(sizeOfIt());
       }\n`,
                "GF0404",
            );
            expect(diagnostic.message).toContain("does not determine `T`");
        });

        test("an untyped literal is GF0161, not a generics problem", async () => {
            // `identity(1)` determines `T` perfectly well — as the literal type
            // `1`, which has no width. The complaint belongs to the width rules
            // and the fix is at the literal, so it would be actively unhelpful
            // to answer it with "write the type arguments".
            await expectRejected(
                "generic-literal-argument",
                `function identity<T>(x: T): T { return x; }

       export function main(): i32 {
         return identity(1);
       }\n`,
                "GF0161",
            );
        });

        test("GF0403 — a generic with no body has nothing to instantiate", async () => {
            await expectRejected(
                "generic-extern",
                `declare function ext<T>(x: T): void;

       export function main(): i32 { return 0; }\n`,
                "GF0403",
            );
        });

        test("GF0402 — instantiation that never ends", async () => {
            const diagnostic = await expectRejected(
                "generic-unbounded",
                `interface Wrap<T> { inner: T; }

       function grow<T>(x: T): void {
         const w: Wrap<T> = { inner: x };
         grow<Wrap<T>>(w);
       }

       export function main(): i32 {
         grow<i32>(1);
         return 0;
       }\n`,
                "GF0402",
            );
            expect(diagnostic.message).toContain("deep so far");
        });

        test("a diagnostic inside an instantiation says which call caused it", async () => {
            // tsc checks a generic at its *declaration*, so a body that type-
            // checks is fine for every `T` as far as tsc is concerned. Erasure
            // is this compiler's rule and tsc knows nothing about it — so the
            // error lands inside a generic the reader may never have opened,
            // and the note is what connects it to the call. C++'s "required
            // from here", and it is not optional.
            const diagnostic = await expectRejected(
                "generic-backtrace",
                `declare class FILE { private _opaque: never; }

       function sizeOfIt<T>(): usize { return sizeOf<T>(); }

       export function main(): i32 {
         return cast<i32>(sizeOfIt<FILE>());
       }\n`,
                "GF0302",
            );
            // The error is in the generic's body, on line 3.
            expect(diagnostic.location?.line).toBe(3);
            const note = diagnostic.notes?.[0];
            expect(note?.message).toContain("`sizeOfIt<FILE>` was instantiated here");
            // And the note points at the call, on line 6.
            expect(note?.location?.line).toBe(6);
        });

        test("a generic has no address until it is instantiated", async () => {
            await expectRejected(
                "generic-as-value",
                `function identity<T>(x: T): T { return x; }

       export function main(): i32 {
         const f: (x: i32) => i32 = identity;
         return f(1);
       }\n`,
                "GF0001",
            );
        });
    });
});
