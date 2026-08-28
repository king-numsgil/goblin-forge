/**
 * `Reference<T>` — borrowing, written down.
 *
 * DECISIONS §24. The thing to hold on to while reading this: **a reference is
 * an address and nothing else.** It is the same machine word a `Pointer<T>`
 * occupies and the same one C++ gives a `T&`, which both the Itanium and the
 * MSVC ABI specify as identical to `T*`. The C ABI has no opinion about
 * references because C has none, and it does not need one.
 *
 * So nothing here is testing a representation. What is being tested is the
 * *frontend* rule the type carries — who copies — and the two places that
 * becomes observable: a mutation the caller can see, and an allocation that
 * does not happen.
 *
 * The one exception to "an address and nothing else" is a contract, which is
 * two words. That is a wart and it is a known one: DECISIONS §24 leaves the
 * question of whether it should keep the name open.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

const POINT = "interface Point { x: i32; y: i32; }\n";

describe("references", () => {
    test("a struct is borrowed, not copied", async () => {
        const result = await run(
            "ref-struct-read",
            `${POINT}
       function sum(p: Reference<Point>): i32 { return p.x + p.y; }

       export function main(): i32 {
         const p: Point = { x: 3, y: 4 };
         return sum(p);
       }\n`,
        );
        expect(result.exitCode).toBe(7);
    });

    test("writing through a reference is visible to the caller", async () => {
        // The observable half of "who copies". By value the callee gets its own
        // and this returns 3; by reference it writes the caller's.
        const result = await run(
            "ref-struct-write",
            `${POINT}
       function bump(p: Reference<Point>): void { p.x = p.x + 10; }

       export function main(): i32 {
         const p: Point = { x: 3, y: 4 };
         bump(p);
         return p.x;
       }\n`,
        );
        expect(result.exitCode).toBe(13);
    });

    test("borrowing an owning struct clones nothing", async () => {
        // The other observable half. A `Held` by value would clone the `string`
        // and release it; the reference does neither, and the caller's copy is
        // still readable afterwards.
        const result = await run(
            "ref-struct-owning",
            `interface Held { name: string; }

       function look(h: Reference<Held>): usize { return h.name.length; }

       export function main(): i32 {
         const h: Held = { name: "abcd" };
         const n = look(h);
         console.log(h.name);
         return cast<i32>(n);
       }\n`,
        );
        expect(result.stdout).toBe("abcd\n");
        expect(result.exitCode).toBe(4);
        expect(result.leaked).toBe(0);
    });

    test("a reference binds to a named value", async () => {
        const result = await run(
            "ref-binding",
            `${POINT}
       export function main(): i32 {
         const p: Point = { x: 2, y: 3 };
         const r: Reference<Point> = p;
         return r.x + r.y;
       }\n`,
        );
        expect(result.exitCode).toBe(5);
    });

    test("a fixed array is borrowed too", async () => {
        const result = await run(
            "ref-fixed-array",
            `function first(a: Reference<FixedArray<i32, 4>>): i32 { return a[0]; }

       export function main(): i32 {
         const a = fixedArray<i32, 4>(4, 7);
         return first(a);
       }\n`,
        );
        expect(result.exitCode).toBe(7);
    });

    test("a reference crosses the C boundary as `T *`", async () => {
        const result = await run(
            "ref-c-boundary",
            `${POINT}
       export function main(): i32 { return 0; }
       export function sum(p: Reference<Point>): i32 { return p.x + p.y; }\n`,
        );
        expect(result.exitCode).toBe(0);
    });

    describe("inside a generic", () => {
        // These are the reason the prelude's `Reference<T>` stopped being a
        // conditional type: tsc will not resolve one over an unresolved `T`, so
        // it kept both branches and member access found nothing in their union.
        // None of the four compiled at all before that.

        test("a constrained `T` calls the constraint's method", async () => {
            const result = await run(
                "ref-generic-contract",
                `interface Speaker { speak(): i32; }
       class Dog implements Speaker { speak(): i32 { return 4; } }

       function ask<T extends Speaker>(x: Reference<T>): i32 { return x.speak(); }

       export function main(): i32 {
         const d = new Dog();
         return ask<Dog>(d);
       }\n`,
            );
            expect(result.exitCode).toBe(4);
        });

        test("a `T` constrained by a class calls its method directly", async () => {
            const result = await run(
                "ref-generic-class",
                `class Counter {
         constructor(public n: i32) {}
         get(): i32 { return this.n; }
       }

       function readIt<T extends Counter>(x: Reference<T>): i32 { return x.get(); }

       export function main(): i32 {
         const c = new Counter(5);
         return readIt<Counter>(c);
       }\n`,
            );
            expect(result.exitCode).toBe(5);
        });

        test("a `Reference<T>` where `T` is a struct", async () => {
            const result = await run(
                "ref-generic-struct",
                `${POINT}
       function same<T>(v: Reference<T>): Reference<T> { return v; }

       export function main(): i32 {
         const p: Point = { x: 9, y: 1 };
         const r = same<Point>(p);
         return r.x;
       }\n`,
            );
            expect(result.exitCode).toBe(9);
        });
    });

    describe("what it refuses", () => {
        test("GF0234 — a reference cannot outlive a temporary", async () => {
            const diagnostic = await expectRejected(
                "ref-temporary",
                `${POINT}
       function make(): Point { return { x: 1, y: 2 }; }

       export function main(): i32 {
         const r: Reference<Point> = make();
         return r.x;
       }\n`,
                "GF0234",
            );
            expect(diagnostic.message).toContain("Bind it to a name first");
        });

        test("GF0002 — a reference to something a copy is free", async () => {
            // A rule, not a gap: an `i32` is already a register, so a reference
            // to one is an extra load bought with nothing.
            const diagnostic = await expectRejected(
                "ref-scalar",
                `function twice(n: Reference<i32>): i32 { return n + n; }

       export function main(): i32 {
         const v: i32 = 5;
         return twice(v);
       }\n`,
                "GF0002",
            );
            expect(diagnostic.message).toContain("Pointer<i32>");
        });

        test("GF0001 — a `Reference<string>` is a gap, and says so", async () => {
            // Copying a `string` clones its buffer, so borrowing one is worth
            // doing. Nothing reads one back through a reference yet.
            const diagnostic = await expectRejected(
                "ref-string",
                `function len(s: Reference<string>): usize { return s.length; }

       export function main(): i32 {
         const s = "hello";
         return cast<i32>(len(s));
       }\n`,
                "GF0001",
            );
            expect(diagnostic.message).toContain("clones its buffer");
        });

        test("GF0301 — an owning struct cannot cross behind a reference", async () => {
            // The reference is not what makes the difference: `Held` is refused
            // at the boundary, so a `Reference<Held>` has to be too.
            const diagnostic = await expectRejected(
                "ref-c-boundary-owning",
                `interface Held { name: string; }

       export function main(): i32 { return 0; }
       export function look(h: Reference<Held>): i32 { return 0; }\n`,
                "GF0301",
            );
            expect(diagnostic.message).toContain("reference to a value that");
        });

        test("GF0302 — an opaque handle has nothing to read through", async () => {
            await expectRejected(
                "ref-opaque",
                `declare class FILE { private _opaque: never; }

       function f(h: Reference<FILE>): i32 { return 0; }

       export function main(): i32 { return 0; }\n`,
                "GF0302",
            );
        });
    });
});
