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

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

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

/**
 * `Readonly<T>`, and `Reference<Readonly<T>>` — the read-only borrow.
 *
 * `Readonly<T>` is TypeScript's own mapped type, which `noLib` means the
 * prelude has to declare. It is a **view**: it erases to whatever `T` erases
 * to, so a class keeps its name, its vtable and its interned MIR struct, and
 * the backend never learns the type was written.
 *
 * That unwrapping is not a shortcut — erasing the mapped type *structurally*
 * gets a different answer three ways over, and each of them is a test below.
 * A class would lose its nominality and therefore its dispatch. `keyof` drops
 * `private`, so a layout would lose fields it has. And over an unresolved type
 * parameter a mapped type has no properties at all, so `Readonly<T>` inside a
 * generic erased to an empty struct rather than to what the instantiation
 * bound `T` to.
 *
 * By value it is nearly pointless — refusing to write your own copy protects
 * nobody — so most of these borrow. `Reference<Readonly<T>>` is `const T &`,
 * and it is the signature a loop over somebody else's data wants.
 */
describe("`Readonly<T>`", () => {
    test("a borrowed shape reads, and will not be written", async () => {
        const result = await run(
            "readonly-shape",
            `${POINT}
       function sum(p: Reference<Readonly<Point>>): i32 { return p.x + p.y; }

       export function main(): i32 {
         const p: Point = {x: 3, y: 4};
         console.log(\`\${sum(p)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("7\n");
        expect(result.leaked).toBe(0);
    });

    test("writing through one is tsc's to refuse", async () => {
        const {result} = await compileSource(
            "readonly-shape-write",
            `${POINT}
       function bad(p: Reference<Readonly<Point>>): void { p.x = 9; }

       export function main(): i32 {
         const p: Point = {x: 1, y: 2};
         bad(p);
         return 0;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2540");
    });

    test("a class keeps its vtable, so dispatch still works through one", async () => {
        // The test that says the unwrapping is real. Erased structurally, a
        // `Readonly<Animal>` is a nameless aggregate with `Animal`'s fields and no
        // vtable slot — so this would either not compile or answer 1.
        const result = await run(
            "readonly-class-dispatch",
            `class Animal { speak(): i32 { return 1; } }
       class Dog extends Animal { override speak(): i32 { return 2; } }

       function ask(a: Reference<Readonly<Animal>>): i32 { return a.speak(); }

       export function main(): i32 {
         const d = new Dog();
         console.log(\`\${ask(d)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("2\n");
        expect(result.leaked).toBe(0);
    });

    test("a class field is refused, and a method is not", async () => {
        // `Readonly<T>` cannot stop `c.bump()`: TypeScript has no way to say a
        // method does not mutate its receiver, which is what a declared `this` is
        // for. Both halves asserted, because the gap is the point.
        const result = await run(
            "readonly-class-method",
            `class Counter {
         constructor(public n: i32) {}
         bump(): void { this.n = this.n + 1; }
       }

       function poke(c: Reference<Readonly<Counter>>): i32 { c.bump(); return c.n; }

       export function main(): i32 {
         const c = new Counter(1);
         console.log(\`\${poke(c)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("2\n");

        const {result: refused} = await compileSource(
            "readonly-class-field-write",
            `class Counter { constructor(public n: i32) {} }

       function poke(c: Reference<Readonly<Counter>>): void { c.n = 9; }

       export function main(): i32 { const c = new Counter(1); poke(c); return 0; }\n`,
        );
        expect(refused.ok).toBe(false);
        expect(errorCodes(refused)).toContain("TS2540");
    });

    test("it survives a type parameter, where a mapped type has no properties", async () => {
        // Unwrapped to `T` *before* anything asks for properties, so the type
        // parameter resolves from the instantiation's bindings the way a bare `T`
        // does. Erased structurally this is an object with no fields, which is
        // `GF0001`.
        const result = await run(
            "readonly-generic",
            `${POINT}
       function first<T>(a: Reference<Readonly<T>>, b: Reference<Readonly<T>>): i32 {
         return 1;
       }

       interface Named { tag: string; }

       export function main(): i32 {
         const p: Point = {x: 1, y: 2};
         const n: Named = {tag: "a"};
         console.log(\`\${first<Point>(p, p)} \${first<Named>(n, n)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 1\n");
        expect(result.leaked).toBe(0);
    });

    test("an owning field is borrowed rather than copied", async () => {
        const result = await run(
            "readonly-owning",
            `interface Held { name: string; }

       function len(h: Reference<Readonly<Held>>): usize { return h.name.length; }

       export function main(): i32 {
         const h: Held = {name: "abcd"};
         console.log(\`\${len(h)} \${h.name}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("4 abcd\n");
        expect(result.leaked).toBe(0);
    });

    test("it is shallow, and nests", async () => {
        const result = await run(
            "readonly-nested",
            `interface Inner { n: i32; }
       interface Outer { inner: Inner; }

       function read(o: Reference<Readonly<Outer>>): i32 { return o.inner.n; }

       export function main(): i32 {
         const o: Outer = {inner: {n: 5}};
         console.log(\`\${read(o)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("5\n");
    });

    test("over an array and a string, tsc has already answered", async () => {
        // A homomorphic mapped type over an array is `readonly T[]`, and over a
        // primitive it is the primitive — so neither reaches the unwrapping at
        // all, and `Readonly<i32[]>` is the `readonly i32[]` of the array module.
        const result = await run(
            "readonly-array-string",
            `function total(xs: Readonly<i32[]>): i32 {
         let sum: i32 = 0;
         for (let i: usize = 0; i < xs.length; i = i + 1) { sum = sum + xs[i]; }
         return sum;
       }

       function size(s: Readonly<string>): usize { return s.length; }

       export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         console.log(\`\${total(xs)} \${size("abcd")}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("6 4\n");
        expect(result.leaked).toBe(0);

        const {result: refused} = await compileSource(
            "readonly-array-push",
            `function bad(xs: Readonly<i32[]>): void { xs.push(3); }

       export function main(): i32 { const xs: i32[] = [1]; bad(xs); return 0; }\n`,
        );
        expect(refused.ok).toBe(false);
        expect(errorCodes(refused)).toContain("TS2339");
    });

    test("a file's own `Readonly` is not this one", async () => {
        // Recognised by the declaration, never by the name. A module-local alias
        // shadows the prelude's for the file that writes it, and unwrapping it
        // would answer about a type this compiler has never seen. Here the local
        // one wraps rather than views, so the field it declares is the proof.
        const result = await run(
            "readonly-shadowed",
            `type Readonly<T> = { held: T; count: i32 };

       ${POINT}
       function read(r: Reference<Readonly<Point>>): i32 {
         return r.held.x + r.count;
       }

       export function main(): i32 {
         const r: Readonly<Point> = {held: {x: 3, y: 4}, count: 10};
         console.log(\`\${read(r)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("13\n");
        expect(result.leaked).toBe(0);
    });
});
