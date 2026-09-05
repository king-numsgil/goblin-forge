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
 * `Readonly<T>` — a view of a value, and the mechanism the borrow is built on.
 *
 * TypeScript's own mapped type, which `noLib` means the prelude has to declare.
 * It erases to whatever `T` erases to, so a class keeps its name, its vtable
 * and its interned MIR struct, and the backend never learns it was written.
 *
 * That unwrapping is not a shortcut — erasing the mapped type *structurally*
 * gets a different answer three ways over, and each of them is a test here or
 * next door. A class would lose its nominality and therefore its dispatch.
 * `keyof` drops `private`, so a layout would lose fields it has. And over an
 * unresolved type parameter a mapped type has no properties at all, so
 * `Readonly<T>` inside a generic erased to an empty struct rather than to what
 * the instantiation bound `T` to.
 *
 * **The borrow is `ConstReference<T>`, not `Reference<Readonly<T>>`**, and the
 * second is `GF0242`. What is left for this type on its own is by-value
 * positions, field types, and `Readonly<T[]>`.
 */
describe("`Readonly<T>`", () => {
    test("by value it reads, and will not be written", async () => {
        const result = await run(
            "readonly-shape",
            `${POINT}
       function sum(p: Readonly<Point>): i32 { return p.x + p.y; }

       export function main(): i32 {
         const p: Point = {x: 3, y: 4};
         console.log(\`\${sum(p)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("7\n");
        expect(result.leaked).toBe(0);
    });

    test("writing one is tsc's to refuse", async () => {
        const {result} = await compileSource(
            "readonly-shape-write",
            `${POINT}
       function bad(p: Readonly<Point>): void { p.x = 9; }

       export function main(): i32 {
         const p: Point = {x: 1, y: 2};
         bad(p);
         return 0;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2540");
    });

    test("`Reference<Readonly<T>>` is refused, and points at the spelling", async () => {
        // The almost-const borrow. It refuses a field write, permits a method
        // that writes the same field, and converts to a plain `Reference<T>` at
        // the first call that wants one — and both holes close only for a class
        // that happens to declare a `private` member.
        const diagnostic = await expectRejected(
            "readonly-reference-refused",
            `${POINT}
       function sum(p: Reference<Readonly<Point>>): i32 { return p.x + p.y; }

       export function main(): i32 {
         const p: Point = {x: 3, y: 4};
         return sum(p);
       }\n`,
            "GF0242",
        );
        expect(diagnostic.message).toContain("ConstReference");
    });

    test("as a field type, and over an array", async () => {
        const result = await run(
            "readonly-field-array",
            `interface Holder { rows: Readonly<i32[]>; }

       function size(s: Readonly<string>): usize { return s.length; }

       export function main(): i32 {
         const h: Holder = {rows: [1, 2, 3]};
         console.log(\`\${h.rows[1]} \${h.rows.length} \${size("abcd")}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("2 3 4\n");
        expect(result.leaked).toBe(0);
    });

    test("over an array and a string, tsc has already answered", async () => {
        // A homomorphic mapped type over an array is `readonly T[]`, and over a
        // primitive it is the primitive — so neither reaches the unwrapping at
        // all, and `Readonly<i32[]>` is the `readonly i32[]` of the array module.
        const {result} = await compileSource(
            "readonly-array-push",
            `function bad(xs: Readonly<i32[]>): void { xs.push(3); }

       export function main(): i32 { const xs: i32[] = [1]; bad(xs); return 0; }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2339");
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

/**
 * `ConstReference<T>` — `const T &`, and the only spelling for it.
 *
 * The same address a `Reference<T>` is: one machine word, the same ABI, the
 * same erasure, nothing in the backend that knows which was written. What
 * differs is what tsc will allow, and it is three things rather than one.
 *
 * The type is `Readonly<T> & ConstReferenceCore<T>`, and each of the two brands
 * in that core is load-bearing:
 *
 * `[ReferenceBrand]?: unknown`, where a `Reference<T>` carries `T`, is the
 * **one-way door**. A key both declare is checked covariantly, so `T` satisfies
 * `unknown` and `unknown` does not satisfy `T` — mutable converts to const and
 * never back. Both optional, so a plain value still satisfies either and no
 * call site has to write anything. It is also what makes a `ConstReference<T>`
 * *be* a reference to everything that reads the brand.
 *
 * `[ConstBrand]?: T` carries the referent unmapped — the erasure reads it,
 * because the other brand says `unknown` — and repairs the nominality
 * `Readonly<>` throws away, since `keyof` drops `private` members.
 *
 * Without the door, both the laundering test and the method test below pass or
 * fail depending on whether the class happens to declare a `private` field.
 * That was the state of `Reference<Readonly<T>>`, and is why it is `GF0242`.
 */
describe("`ConstReference<T>`", () => {
    test("it borrows, reads, and runs", async () => {
        const result = await run(
            "cref-read",
            `class Body {
         constructor(public mass: f64, public name: string) {}
         heavy(this: ConstReference<Body>): boolean { return this.mass > 1.0; }
       }

       function named(b: ConstReference<Body>): string { return b.name; }

       export function main(): i32 {
         const b = new Body(2.5, "ceres");
         console.log(\`\${named(b)} \${b.heavy()}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ceres true\n");
        expect(result.leaked).toBe(0);
    });

    test("a field write is refused", async () => {
        const {result} = await compileSource(
            "cref-write",
            `${POINT}
       function bad(p: ConstReference<Point>): void { p.x = 9; }

       export function main(): i32 { const p: Point = {x: 1, y: 2}; bad(p); return 0; }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2540");
    });

    test("it does not launder into a mutable reference", async () => {
        // Neither of these declares a `private` member, which is the whole point:
        // under `Reference<Readonly<T>>` both of these compiled and mutated.
        for (const [name, source] of [
            [
                "shape",
                `${POINT}
       function mutate(p: Reference<Point>): void { p.x = 9; }
       function read(p: ConstReference<Point>): void { mutate(p); }

       export function main(): i32 { const p: Point = {x: 1, y: 2}; read(p); return 0; }\n`,
            ],
            [
                "class",
                `class C { constructor(public x: i32) {} }
       function mutate(c: Reference<C>): void { c.x = 9; }
       function read(c: ConstReference<C>): void { mutate(c); }

       export function main(): i32 { const c = new C(1); read(c); return 0; }\n`,
            ],
        ] as const) {
            const {result} = await compileSource(`cref-launder-${name}`, source);
            expect({name, ok: result.ok}).toEqual({name, ok: false});
            expect({name, codes: errorCodes(result)}).toEqual({name, codes: ["TS2345"]});
        }
    });

    test("a mutating method is refused, and a const one is not", async () => {
        // The half `Readonly<T>` cannot reach on its own. `bump` says what it
        // needs; `read` says it needs less, and is callable through either.
        const {result} = await compileSource(
            "cref-mutating-method",
            `class C {
         constructor(public x: i32) {}
         bump(this: Reference<C>): void { this.x = this.x + 1; }
       }

       function poke(c: ConstReference<C>): void { c.bump(); }

       export function main(): i32 { const c = new C(1); poke(c); return 0; }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2684");

        const allowed = await run(
            "cref-const-method",
            `class C {
         constructor(public x: i32) {}
         read(this: ConstReference<C>): i32 { return this.x; }
       }

       function ask(c: ConstReference<C>): i32 { return c.read(); }

       export function main(): i32 {
         const c = new C(7);
         // Through a const borrow, and on the value itself: a method that asks
         // for less is callable from more.
         console.log(\`\${ask(c)} \${c.read()}\`);
         return 0;
       }\n`,
        );
        expect(allowed.stdout).toBe("7 7\n");
    });

    test("a class keeps its vtable, so dispatch still works through one", async () => {
        // The test that says the unwrapping is real. Erased structurally, this is
        // a nameless aggregate with no vtable slot — so it would either not
        // compile or answer 1.
        const result = await run(
            "cref-dispatch",
            `class Animal { speak(): i32 { return 1; } }
       class Dog extends Animal { override speak(): i32 { return 2; } }

       function ask(a: ConstReference<Animal>): i32 { return a.speak(); }

       export function main(): i32 {
         const d = new Dog();
         console.log(\`\${ask(d)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("2\n");
        expect(result.leaked).toBe(0);
    });

    test("the const brand keeps two classes apart that `Readonly<>` merges", async () => {
        // `keyof` drops `private` members, so `Readonly<aligned_dvec3>` satisfies
        // a `Readonly<dvec3>` — the exact confusion the linalg brand exists to
        // prevent. Comparing `[ConstBrand]` compares the unmapped types, which
        // are nominal.
        const {result} = await compileSource(
            "cref-nominal",
            `import { dvec3, aligned_dvec3 } from "std/linalg";

       function packed(v: ConstReference<dvec3>): f64 { return v.x; }

       export function main(): i32 {
         const padded = new aligned_dvec3(1, 2, 3);
         const x: f64 = packed(padded);
         return 0;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2345");
    });

    test("an owning field is borrowed rather than copied, and survives a generic", async () => {
        const result = await run(
            "cref-owning-generic",
            `interface Held { name: string; }

       function len(h: ConstReference<Held>): usize { return h.name.length; }
       function pass<T>(v: ConstReference<T>): ConstReference<T> { return v; }

       export function main(): i32 {
         const h: Held = {name: "abcd"};
         console.log(\`\${len(pass<Held>(h))} \${h.name}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("4 abcd\n");
        expect(result.leaked).toBe(0);
    });

    test("it is shallow, and nests", async () => {
        const result = await run(
            "cref-nested",
            `interface Inner { n: i32; }
       interface Outer { inner: Inner; }

       function read(o: ConstReference<Outer>): i32 { return o.inner.n; }

       export function main(): i32 {
         const o: Outer = {inner: {n: 5}};
         console.log(\`\${read(o)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("5\n");
    });
});
