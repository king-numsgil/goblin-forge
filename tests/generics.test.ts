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

        test("one on the heap, through `alloc`", async () => {
            // `alloc(Box, n)` names the *declaration*, and `Box` on its own is
            // not a class this build has — the instantiation comes from the
            // call's own type, which tsc has already inferred from the
            // constructor's argument. The same route `new` takes.
            const result = await run(
                "generic-class-alloc",
                `class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       export function main(): i32 {
         const n: i32 = 3;
         const p = alloc(Box, n);
         const v = p.get();
         p.free();
         return v;
       }\n`,
            );
            expect(result.exitCode).toBe(3);
            expect(result.leaked).toBe(0);
        });

        test("one reached back through an erased pointer", async () => {
            // `reify` may be the first mention of `Box<i32>` anywhere, so the
            // path that asks what class an expression is has to be able to make
            // one — not only the path that interns a type.
            const result = await run(
                "generic-class-reify",
                `class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       export function main(): i32 {
         const n: i32 = 4;
         const p = alloc(Box, n);
         const erased = p.erase();
         const back = erased.reify<Box<i32>>();
         const v = back.get();
         back.free();
         return v;
       }\n`,
            );
            expect(result.exitCode).toBe(4);
            expect(result.leaked).toBe(0);
        });

        test("a `static` on a generic class has no name that resolves", async () => {
            // `Box.zero()` names none of the classes `Box` stands for, and
            // TypeScript has no syntax for saying which — it never needed one,
            // because a `static` may not use `T`. Which is also the way out.
            const diagnostic = await expectRejected(
                "generic-class-static",
                `class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
         static zero(): i32 { return 0; }
       }

       export function main(): i32 {
         const b = new Box<i32>(7);
         return b.get() + Box.zero();
       }\n`,
                "GF0001",
            );
            expect(diagnostic.message).toContain("may not use the class's type parameters");
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

    describe("generic methods", () => {
        // **A generic method has no vtable slot, and cannot have one.** A slot
        // holds one function and this is as many functions as it has sets of
        // type arguments, so there is no answer to which one goes in. C++
        // forbids `virtual` on a member template for exactly that reason, and
        // the consequence is the same here: a generic method is resolved
        // statically, neither overriding nor overridden, and inherited by name
        // the way a `static` is.

        test("on a plain class", async () => {
            const result = await run(
                "generic-method",
                `class Holder {
         pick<T>(a: T, b: T): T { return a; }
       }

       export function main(): i32 {
         const h = new Holder();
         const x: i32 = 3;
         return h.pick<i32>(x, x);
       }\n`,
            );
            expect(result.exitCode).toBe(3);
        });

        test("its type arguments are inferred too", async () => {
            const result = await run(
                "generic-method-inferred",
                `class Holder {
         pick<T>(a: T, b: T): T { return a; }
       }

       export function main(): i32 {
         const h = new Holder();
         const x: i32 = 3;
         return h.pick(x, x);
       }\n`,
            );
            expect(result.exitCode).toBe(3);
        });

        test("two instantiations of one method", async () => {
            const result = await run(
                "generic-method-two",
                `class Holder {
         echo<T>(x: T): T { const copy = x; return copy; }
       }

       export function main(): i32 {
         const h = new Holder();
         const n: i32 = 4;
         console.log(h.echo<string>("said"));
         return h.echo<i32>(n);
       }\n`,
            );
            expect(result.stdout).toBe("said\n");
            expect(result.exitCode).toBe(4);
            // The `string` copy clones and drops; the `i32` copy does neither.
            expect(result.leaked).toBe(0);
        });

        test("on a generic class, using both parameters", async () => {
            const result = await run(
                "generic-method-on-generic-class",
                `class Box<T> {
         constructor(private value: T) {}
         mine(): T { return this.value; }
         paired<U>(other: U): U { return other; }
       }

       export function main(): i32 {
         const b = new Box<string>("kept");
         const n: i32 = 5;
         console.log(b.mine());
         return b.paired<i32>(n);
       }\n`,
            );
            expect(result.stdout).toBe("kept\n");
            expect(result.exitCode).toBe(5);
            expect(result.leaked).toBe(0);
        });

        test("a method's parameter shadows the class's", async () => {
            // Two different parameters that happen to be spelled alike would be
            // one entry in a substitution keyed by *name*. It is keyed by
            // symbol, so `T` inside the method is the method's.
            const result = await run(
                "generic-method-shadow",
                `class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
         swap<T2>(v: T2): T2 { return v; }
       }

       export function main(): i32 {
         const b = new Box<i32>(1);
         const n: i32 = 6;
         return b.swap<i32>(n) + b.get();
       }\n`,
            );
            expect(result.exitCode).toBe(7);
        });

        test("inherited by name, like a `static`", async () => {
            const result = await run(
                "generic-method-inherited",
                `class Base { echo<T>(x: T): T { return x; } }
       class Derived extends Base {}

       export function main(): i32 {
         const d = new Derived();
         const n: i32 = 8;
         return d.echo<i32>(n);
       }\n`,
            );
            expect(result.exitCode).toBe(8);
        });

        test("and an ordinary method is still virtual", async () => {
            // The control: giving generic methods no slot must not have taken
            // anyone else's away.
            const result = await run(
                "generic-method-virtual-control",
                `class Base { name(): string { return "base"; } }
       class Derived extends Base { override name(): string { return "derived"; } }

       export function main(): i32 {
         const d = new Derived();
         const b: Reference<Base> = d;
         console.log(b.name());
         return 0;
       }\n`,
            );
            expect(result.stdout).toBe("derived\n");
        });

        test("a `static` one", async () => {
            const result = await run(
                "generic-static-method",
                `class Util {
         static identity<T>(x: T): T { return x; }
       }

       export function main(): i32 {
         const n: i32 = 6;
         return Util.identity<i32>(n);
       }\n`,
            );
            expect(result.exitCode).toBe(6);
        });

        test("a generic method on a generic class, inside a generic function", async () => {
            // Three substitutions at once, and the deepest case that works.
            const result = await run(
                "generic-method-deep",
                `class Box<T> {
         constructor(private value: T) {}
         paired<U>(other: U): U { return other; }
       }

       function wrap<T, U>(v: T, other: U): U {
         const b = new Box<T>(v);
         return b.paired<U>(other);
       }

       export function main(): i32 {
         const n: i32 = 10;
         return wrap<string, i32>("deep", n);
       }\n`,
            );
            expect(result.exitCode).toBe(10);
            expect(result.leaked).toBe(0);
        });
    });

    describe("generic classes and contracts", () => {
        test("a generic class implements a plain contract", async () => {
            const result = await run(
                "generic-class-plain-contract",
                `interface Getter { get(): i32; }
       class Box<T> implements Getter {
         constructor(private value: i32) {}
         get(): i32 { return this.value; }
       }

       export function main(): i32 {
         const b = new Box<i32>(7);
         const g: Reference<Getter> = b;
         return g.get();
       }\n`,
            );
            expect(result.exitCode).toBe(7);
        });

        test("a generic class implements a *generic* contract", async () => {
            // `implements Container<T>` names a contract whose `T` is this
            // instantiation's, and the clause has to be erased under the
            // class's substitution. It was not, so a generic class could
            // declare it implemented a generic contract and never be able to.
            const result = await run(
                "generic-class-generic-contract",
                `interface Container<T> { get(): T; }
       class Box<T> implements Container<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       export function main(): i32 {
         const b = new Box<i32>(8);
         const c: Reference<Container<i32>> = b;
         return c.get();
       }\n`,
            );
            expect(result.exitCode).toBe(8);
        });

        test("two instantiations satisfy the contract at their own type", async () => {
            // `Container<i32>` and `Container<string>` are two contracts with
            // two itables, and each `Box` answers its own.
            const result = await run(
                "generic-contract-two",
                `interface Container<T> { get(): T; }
       class Box<T> implements Container<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       export function main(): i32 {
         const n = new Box<i32>(3);
         const s = new Box<string>("held");
         const cn: Reference<Container<i32>> = n;
         const cs: Reference<Container<string>> = s;
         console.log(cs.get());
         return cn.get();
       }\n`,
            );
            expect(result.stdout).toBe("held\n");
            expect(result.exitCode).toBe(3);
            expect(result.leaked).toBe(0);
        });

        test("an accessor on a generic class", async () => {
            // An accessor's type is re-erased at each *use*, where a method's is
            // recorded once at declaration — so this is the member that showed
            // that a class's substitution has to travel with the class rather
            // than come from whoever is asking.
            const result = await run(
                "generic-class-accessor",
                `class Box<T> {
         constructor(private value: T) {}
         get held(): T { return this.value; }
         set held(v: T) { this.value = v; }
       }

       export function main(): i32 {
         const b = new Box<i32>(1);
         b.held = 6;
         return b.held;
       }\n`,
            );
            expect(result.exitCode).toBe(6);
        });
    });

    describe("the identity of an instantiation", () => {
        test("a dynamic cast finds a generic class's contract", async () => {
            const result = await run(
                "generic-trycast",
                `interface Named { tag(): i32; }
       class Box<T> implements Named {
         constructor(private value: T) {}
         get(): T { return this.value; }
         tag(): i32 { return 1; }
       }

       export function main(): i32 {
         const n: i32 = 4;
         const p = alloc(Box, n);
         const found = tryCast<Named>(p);
         const answer = found === null ? -1 : found.tag();
         p.free();
         return answer;
       }\n`,
            );
            expect(result.exitCode).toBe(1);
            expect(result.leaked).toBe(0);
        });

        test("and does not find another instantiation, or another class", async () => {
            // `Box<i32>` and `Box<f64>` are unrelated types with unrelated
            // descriptors, and this is what says so — the positive test above
            // would pass just as well if every cast succeeded.
            const result = await run(
                "generic-trycast-negative",
                `interface Named { tag(): i32; }
       class Box<T> implements Named {
         constructor(private value: T) {}
         tag(): i32 { return 1; }
       }
       class Other implements Named { tag(): i32 { return 2; } }

       export function main(): i32 {
         const n: i32 = 4;
         const p = alloc(Box, n);
         const asOther = tryCast<Other>(p.erase().reify<Box<i32>>());
         const wrong: i32 = asOther === null ? 0 : 9;
         const asWide = tryCast<Box<f64>>(p.erase().reify<Box<i32>>());
         const alsoWrong: i32 = asWide === null ? 0 : 9;
         p.free();
         return wrong + alsoWrong;
       }\n`,
            );
            expect(result.exitCode).toBe(0);
            expect(result.leaked).toBe(0);
        });

        test("one generic aggregate declared in two files is one struct", async () => {
            // The other direction of `layoutKey`: same name, same layout, so
            // one struct — and a value crosses between the files.
            const result = await run(
                "generic-aggregate-two-files",
                `import { sum } from "./other.ts";

       interface Pair<T> { a: T; b: T; }

       export function main(): i32 {
         const p: Pair<i32> = { a: 1, b: 2 };
         return p.a + p.b + sum();
       }\n`,
                {
                    files: {
                        "other.ts": `interface Pair<T> { a: T; b: T; }

       export function sum(): i32 {
         const p: Pair<i32> = { a: 3, b: 4 };
         return p.a + p.b;
       }\n`,
                    },
                },
            );
            expect(result.exitCode).toBe(10);
        });

        test("two generic classes of one name are still refused", async () => {
            // A class is emitted under its name, and `Box<i32>` from two files
            // would be one symbol. The rule that has always covered this covers
            // generics too — DECISIONS §11.8's known restriction.
            const diagnostic = await expectRejected(
                "generic-class-two-files",
                `import { make } from "./other.ts";

       class Box<T> { constructor(public value: T) {} }

       export function main(): i32 {
         const b = new Box<i32>(3);
         return b.value + make();
       }\n`,
                "GF0002",
                {
                    files: {
                        "other.ts": `class Box<T> { constructor(public value: T) {} }

       export function make(): i32 { const b = new Box<i32>(4); return b.value; }\n`,
                    },
                },
            );
            expect(diagnostic.message).toContain("already a class called");
        });
    });

    describe("with a class hierarchy", () => {
        test("a copy through a generic slices, as a copy does anywhere", async () => {
            // `copyOf<Base>` is handed a `Derived`, and a by-value copy of a
            // `Base` is a `Base` — the derived half is not there to keep. C++
            // does the same and REWRITE-PLAN §4.7 says so; being generic
            // neither causes it nor excuses it.
            const result = await run(
                "generic-slices",
                `class Base { tag(): i32 { return 1; } }
       class Derived extends Base { override tag(): i32 { return 2; } }

       function copyOf<T>(x: T): T { const c = x; return c; }

       export function main(): i32 {
         const d = new Derived();
         return copyOf<Base>(d).tag();
       }\n`,
            );
            expect(result.exitCode).toBe(1);
        });

        test("a generic class overriding a plain base still dispatches", async () => {
            // Virtual dispatch *into* an instantiation: the vtable belongs to
            // `Box<i32>` and the call goes through `Base`'s slot.
            const result = await run(
                "generic-class-override",
                `class Base { tag(): i32 { return 1; } }
       class Box<T> extends Base {
         constructor(private value: T) { super(); }
         override tag(): i32 { return 2; }
       }

       export function main(): i32 {
         const b = new Box<i32>(5);
         const r: Reference<Base> = b;
         return r.tag();
       }\n`,
            );
            expect(result.exitCode).toBe(2);
        });

        test("a class with a generic method still converts to a contract", async () => {
            // The generic method is simply not part of the contract — it has no
            // slot, so there is nothing for an itable to hold.
            const result = await run(
                "generic-method-and-contract",
                `interface Speaker { speak(): i32; }
       class Dog implements Speaker {
         speak(): i32 { return 1; }
         echo<T>(x: T): T { return x; }
       }

       export function main(): i32 {
         const d = new Dog();
         const s: Reference<Speaker> = d;
         return s.speak();
       }\n`,
            );
            expect(result.exitCode).toBe(1);
        });

        test("width promotion is unchanged inside a generic", async () => {
            const result = await run(
                "generic-width-promotion",
                `function scale<T extends number>(x: T): T { return cast<T>(x + x); }

       export function main(): i32 {
         const small: u8 = 3;
         const wide: i32 = 100;
         return cast<i32>(scale<u8>(small)) + scale<i32>(wide);
       }\n`,
            );
            expect(result.exitCode).toBe(206);
        });
    });

    describe("over the other type families", () => {
        test("a linear-algebra type", async () => {
            const result = await run(
                "generic-linalg",
                `import { dvec3 } from "std/linalg";

       function first<T>(xs: T[]): T { return xs[0]; }

       class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       export function main(): i32 {
         const vs: dvec3[] = [new dvec3(1, 2, 3)];
         const boxed = new Box<dvec3>(first<dvec3>(vs));
         const v = boxed.get();
         return cast<i32>(v.x + v.y + v.z);
       }\n`,
            );
            expect(result.exitCode).toBe(6);
        });

        test("an enum", async () => {
            const result = await run(
                "generic-enum",
                `enum Colour { Red = 1, Green = 2 }

       function echo<T>(x: T): T { return x; }

       export function main(): i32 { return cast<i32>(echo<Colour>(Colour.Green)); }\n`,
            );
            expect(result.exitCode).toBe(2);
        });

        test("a union", async () => {
            const result = await run(
                "generic-union",
                `interface Word extends Union { whole: u32; half: u16; }

       function echo<T>(x: T): T { return x; }

       export function main(): i32 {
         const w = zeroed<Word>();
         return cast<i32>(echo<Word>(w).half);
       }\n`,
            );
            expect(result.exitCode).toBe(0);
        });

        test("a fixed array, and a `Pointer<T>` parameter", async () => {
            const result = await run(
                "generic-fixed-and-pointer",
                `function firstOf<T>(a: FixedArray<T, 4>): T { return a[0]; }
       function sizeVia<T>(p: Pointer<T>): usize { return sizeOf<T>(); }

       export function main(): i32 {
         const a = fixedArray<i32, 4>(4, 7);
         const p = alloc<i32>();
         const n = sizeVia<i32>(p);
         p.free();
         return firstOf<i32>(a) + cast<i32>(n);
       }\n`,
            );
            expect(result.exitCode).toBe(11);
            expect(result.leaked).toBe(0);
        });

        test("returning a `T[]`", async () => {
            const result = await run(
                "generic-returns-array",
                `function pairOf<T>(a: T, b: T): T[] { return [a, b]; }

       export function main(): i32 {
         const n: i32 = 5;
         const xs = pairOf<i32>(n, n);
         const words = pairOf<string>("a", "b");
         console.log(words[1]);
         return xs[0] + xs[1];
       }\n`,
            );
            expect(result.stdout).toBe("b\n");
            expect(result.exitCode).toBe(10);
            expect(result.leaked).toBe(0);
        });

        test("`zeroed`, `sizeOf` and `alignOf` inside a generic", async () => {
            const result = await run(
                "generic-intrinsics",
                `function blank<T>(): usize {
         const v = zeroed<T>();
         return sizeOf<T>() + alignOf<T>();
       }

       export function main(): i32 { return cast<i32>(blank<i32>()); }\n`,
            );
            expect(result.exitCode).toBe(8);
        });

        test("a `LocalFn` parameter", async () => {
            const result = await run(
                "generic-localfn",
                `function apply<T>(f: LocalFn<(x: T) => T>, v: T): T { return f(v); }

       export function main(): i32 {
         const n: i32 = 3;
         return apply<i32>((x) => x * 2, n);
       }\n`,
            );
            expect(result.exitCode).toBe(6);
        });

        test("the ownership rules still apply inside one", async () => {
            // `move` out of a by-value parameter is refused in a generic for
            // exactly the reason it is anywhere: the caller releases it when the
            // call ends. Being generic neither excuses nor causes it.
            const diagnostic = await expectRejected(
                "generic-move-refused",
                `function take<T>(x: T): T { const held = move(x); return held; }

       export function main(): i32 {
         console.log(take<string>("moved"));
         return 0;
       }\n`,
                "GF0236",
            );
            expect(diagnostic.message).toContain("by-value parameter");
        });
    });

    describe("generic classes, harder shapes", () => {
        test("with a plain base class", async () => {
            const result = await run(
                "generic-class-base",
                `class Base { tag(): i32 { return 1; } }
       class Box<T> extends Base {
         constructor(private value: T) { super(); }
         get(): T { return this.value; }
       }

       export function main(): i32 {
         const b = new Box<i32>(6);
         return b.get() + b.tag();
       }\n`,
            );
            expect(result.exitCode).toBe(7);
        });

        test("a destructor runs for the instantiation that has one", async () => {
            const result = await run(
                "generic-class-drop",
                `class Holder<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }

       export function main(): i32 {
         const owning = new Holder<string>("one");
         const plain = new Holder<i32>(2);
         const heap = alloc(Holder, "released");
         console.log(owning.get());
         console.log(heap.get());
         heap.free();
         return plain.get();
       }\n`,
            );
            expect(result.stdout).toBe("one\nreleased\n");
            expect(result.exitCode).toBe(2);
            // Three instantiations, two of them owning a buffer.
            expect(result.leaked).toBe(0);
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
        test("a conditional type over `T` stays unresolved, and says so", async () => {
            // A real limit rather than an oversight. The substitution replaces
            // `T` at the *leaf*, with a machine type; re-evaluating a
            // conditional needs TypeScript's own types put back and the whole
            // thing instantiated, which tsc offers no way to ask for. The
            // message has to say that, because "`Chosen<T>` has no machine
            // representation" is true of the shape and sends the reader looking
            // for a missing feature in the wrong place.
            const diagnostic = await expectRejected(
                "generic-conditional",
                `type Chosen<T> = T extends i32 ? i32 : f64;

       function pick<T>(x: Chosen<T>): Chosen<T> { return x; }

       export function main(): i32 {
         const n: i32 = 4;
         return pick<i32>(n);
       }\n`,
                "GF0001",
            );
            expect(diagnostic.message).toContain("conditional type");
        });

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

        test("a deep chain that *does* end is not refused", async () => {
            // The other side of the limit, and the one a cap can get wrong: a
            // chain twenty instantiations deep that stops on its own. Without
            // this, a limit that counted the wrong thing — or counted it in the
            // wrong place — would look correct from the refusal alone.
            const lines: string[] = ["interface Wrap<T> { inner: T; }"];
            for (let i = 0; i < 20; i += 1) {
                lines.push(`function grow${i}<T>(x: T): i32 {`);
                lines.push("  const w: Wrap<T> = { inner: x };");
                lines.push(i + 1 < 20 ? `  return grow${i + 1}<Wrap<T>>(w);` : "  return 7;");
                lines.push("}");
            }
            lines.push("export function main(): i32 {");
            lines.push("  const n: i32 = 1;");
            lines.push("  return grow0<i32>(n);");
            lines.push("}");

            const result = await run("generic-depth-under-cap", `${lines.join("\n")}\n`);
            expect(result.exitCode).toBe(7);
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
