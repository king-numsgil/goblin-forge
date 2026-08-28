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

    describe("generic aggregates", () => {
        test("two instantiations of one interface are two structs", async () => {
            // This is the program from GENERICS-PLAN §3 that used to reach clang
            // and come back as `GF9003` — the compiler calling itself broken
            // about a program tsc accepted. `layoutKey` is what fixed it, and
            // this is here as well as in `structs.test.ts` because generics are
            // how anybody actually hits it.
            const result = await run(
                "generic-interface",
                `interface Pair<T> { a: T; b: T; }

       export function main(): i32 {
         const small: Pair<u8> = { a: 1, b: 2 };
         const big: Pair<f64> = { a: 1.5, b: 2.5 };
         console.log(\`\${small.a} \${big.b}\`);
         return cast<i32>(small.a) + cast<i32>(big.b);
       }\n`,
            );
            expect(result.stdout).toBe("1 2.5\n");
            expect(result.exitCode).toBe(3);
        });

        test("a generic type alias", async () => {
            const result = await run(
                "generic-alias-type",
                `type Pair<T> = { a: T; b: T };

       export function main(): i32 {
         const p: Pair<i32> = { a: 4, b: 5 };
         return p.a + p.b;
       }\n`,
            );
            expect(result.exitCode).toBe(9);
        });

        test("a generic aggregate nested in itself", async () => {
            const result = await run(
                "generic-nested",
                `interface Pair<T> { a: T; b: T; }

       function sum(p: Pair<i32>): i32 { return p.a + p.b; }

       export function main(): i32 {
         const inner: Pair<i32> = { a: 1, b: 2 };
         const outer: Pair<Pair<i32>> = { a: inner, b: inner };
         return sum(outer.a) + sum(outer.b);
       }\n`,
            );
            expect(result.exitCode).toBe(6);
        });

        test("a generic aggregate holding something owning", async () => {
            const result = await run(
                "generic-aggregate-owning",
                `interface Boxed<T> { held: T; }

       export function main(): i32 {
         const s: Boxed<string> = { held: "kept" };
         console.log(s.held);
         return 0;
       }\n`,
            );
            expect(result.stdout).toBe("kept\n");
            expect(result.leaked).toBe(0);
        });
    });

    describe("numeric generics", () => {
        // **The constraint is `T extends number`, not `T extends i32`.** A width
        // brand is an exact string literal, so `T extends i32` *pins* `T` to
        // `i32` and the generic can only ever be instantiated at the one width —
        // which makes it not a generic at all. This plan predicted the wrong
        // spelling and the tests are where that got found.

        test("one body, two widths, arithmetic at each", async () => {
            const result = await run(
                "generic-numeric-int",
                `function twice<T extends number>(x: T): T { return cast<T>(x + x); }

       export function main(): i32 {
         const small: u8 = twice<u8>(200);
         const big: i32 = twice<i32>(200);
         console.log(\`\${small} \${big}\`);
         return 0;
       }\n`,
            );
            // 400 does not fit a `u8`, so the narrow copy wraps to 144. If both
            // were computed at `i32` this would say 400.
            expect(result.stdout).toBe("144 400\n");
        });

        test("`f32` and `f64` round differently, which is the point", async () => {
            const result = await run(
                "generic-numeric-float",
                `function sum<T extends number>(a: T, b: T): T { return cast<T>(a + b); }

       export function main(): i32 {
         const wide: f64 = sum<f64>(0.1, 0.2);
         const narrow: f32 = sum<f32>(0.1, 0.2);
         console.log(\`\${wide}\`);
         console.log(\`\${narrow}\`);
         return 0;
       }\n`,
            );
            // The cheap wrong implementation computes both at `f64` and prints
            // the same number twice.
            expect(result.stdout).toBe("0.30000000000000004\n0.30000001192092896\n");
        });

        test("comparison on a numeric type parameter", async () => {
            const result = await run(
                "generic-numeric-compare",
                `function biggest<T extends number>(a: T, b: T): T { return a > b ? a : b; }

       export function main(): i32 { return biggest<i32>(3, 9); }\n`,
            );
            expect(result.exitCode).toBe(9);
        });
    });

    describe("generic classes", () => {
        // `Box<i32>` and `Box<f64>` are two *classes*, not one with a variable
        // in it: different layouts, different vtables, different destructors.
        // They are made on demand, because the first mention of one may be
        // inside a generic function's body — which is lowered long after the
        // ordinary classes were declared.

        test("a generic class, instantiated once", async () => {
            const result = await run(
                "generic-class",
                `class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       export function main(): i32 {
         const b = new Box<i32>(3);
         return b.get();
       }\n`,
            );
            expect(result.exitCode).toBe(3);
        });

        test("two instantiations, one of them owning", async () => {
            // The `string` one has a destructor that releases a buffer and the
            // `i32` one has nothing to do. Same source, two classes.
            const result = await run(
                "generic-class-two",
                `class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       export function main(): i32 {
         const n = new Box<i32>(4);
         const s = new Box<string>("held");
         console.log(s.get());
         return n.get();
       }\n`,
            );
            expect(result.stdout).toBe("held\n");
            expect(result.exitCode).toBe(4);
            expect(result.leaked).toBe(0);
        });

        test("an instantiation in a signature", async () => {
            const result = await run(
                "generic-class-signature",
                `class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       function read(b: Reference<Box<i32>>): i32 { return b.get(); }

       export function main(): i32 {
         const b = new Box<i32>(6);
         return read(b);
       }\n`,
            );
            expect(result.exitCode).toBe(6);
        });

        test("a generic class instantiated inside a generic function", async () => {
            // The case a pre-pass could not have found: `Box<T>` is only
            // `Box<i32>` once `wrap<i32>` exists, and that happens while a body
            // is being lowered.
            const result = await run(
                "generic-class-in-generic-fn",
                `class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       function wrap<T>(v: T): T {
         const b = new Box<T>(v);
         return b.get();
       }

       export function main(): i32 {
         const words = wrap<string>("through");
         console.log(words);
         return wrap<i32>(8);
       }\n`,
            );
            expect(result.stdout).toBe("through\n");
            expect(result.exitCode).toBe(8);
            expect(result.leaked).toBe(0);
        });

        test("a public field of the substituted type", async () => {
            const result = await run(
                "generic-class-field",
                `class Box<T> { constructor(public value: T) {} }

       export function main(): i32 {
         const b = new Box<i32>(5);
         return b.value;
       }\n`,
            );
            expect(result.exitCode).toBe(5);
        });

        test("a generic base class is refused, for now", async () => {
            // Narrow, and honest about why: resolving a base by its erased type
            // arguments is a different question from resolving one by name,
            // which is all the heritage clause is read for today.
            const diagnostic = await expectRejected(
                "generic-class-base",
                `class Box<T> { constructor(public value: T) {} }
       class IntBox extends Box<i32> {}

       export function main(): i32 { return 0; }\n`,
                "GF0001",
            );
            expect(diagnostic.message).toContain("base class");
        });
    });

    describe("an instantiation as a value", () => {
        test("`identity<i32>` is a code address", async () => {
            const result = await run(
                "generic-value",
                `function identity<T>(x: T): T { return x; }

       export function main(): i32 {
         const f: (x: i32) => i32 = identity<i32>;
         return f(9);
       }\n`,
            );
            expect(result.exitCode).toBe(9);
        });

        test("a callback table mixing an instantiation and a plain function", async () => {
            const result = await run(
                "generic-value-table",
                `function identity<T>(x: T): T { return x; }
       function negate(x: i32): i32 { return 0 - x; }

       function apply(f: (x: i32) => i32, v: i32): i32 { return f(v); }

       export function main(): i32 {
         const table: FixedArray<(x: i32) => i32, 2> =
           fixedArray<(x: i32) => i32, 2>(2, identity<i32>);
         table[1] = negate;
         return apply(table[0], 5) + apply(table[1], 2);
       }\n`,
            );
            expect(result.exitCode).toBe(3);
        });

        test("the same instantiation addressed and called", async () => {
            // The convention has to agree: a `FnPtr`'s signature is classified
            // by the C rules, so an instantiation whose address is taken is
            // emitted that way and the *direct* call has to match.
            const result = await run(
                "generic-value-and-call",
                `function identity<T>(x: T): T { return x; }

       export function main(): i32 {
         const f: (x: i32) => i32 = identity<i32>;
         return f(4) + identity<i32>(5);
       }\n`,
            );
            expect(result.exitCode).toBe(9);
        });

        test("GF0404 — a generic named with no type arguments has no address", async () => {
            const diagnostic = await expectRejected(
                "generic-value-bare",
                `function identity<T>(x: T): T { return x; }

       export function main(): i32 {
         const f: (x: i32) => i32 = identity;
         return f(1);
       }\n`,
                "GF0404",
            );
            expect(diagnostic.message).toContain("has no one address");
        });
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
