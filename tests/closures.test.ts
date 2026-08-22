/**
 * `LocalFn<F>` — the non-escaping closure. DECISIONS §18, step 1.
 *
 * Two things this suite is arranged around.
 *
 * **Captures are by reference, and the tests have to be able to tell.** A
 * closure that only reads its captures passes whether the environment holds
 * addresses or copies, so every capture test writes through one and asserts
 * the enclosing frame saw it. That is the difference between this feature and a
 * feature that looks like it from the outside.
 *
 * **Nothing here is allowed to allocate.** A `LocalFn`'s environment lives in
 * the caller's frame and holds `Reference<T>`, so the live-allocation check
 * every `run` test carries is a real assertion for this feature and not a
 * formality: a closure that reached the heap would show up as a leak or as a
 * count the C++ oracle disagrees with.
 */

// noinspection ES6UnusedImports
import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("LocalFn", () => {
    test("a non-capturing lambda is accepted, with no environment", async () => {
        const result = await run(
            "closure-plain",
            `function apply(f: LocalFn<(x: i32) => i32>, v: i32): i32 {
         return f(v);
       }

       export function main(): i32 {
         console.log(\`\${apply((x) => x * 2, 21)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("42\n");
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
    });

    test("a capture is read through the environment", async () => {
        const result = await run(
            "closure-read",
            `function apply(f: LocalFn<(x: i32) => i32>, v: i32): i32 {
         return f(v);
       }

       export function main(): i32 {
         const base: i32 = 100;
         const step: i32 = 7;
         console.log(\`\${apply((x) => base + step * x, 3)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("121\n");
        expect(result.stderr).toBe("");
    });

    /**
     * The test that separates a real capture from a copy.
     *
     * `total` is written inside the closure and read outside it afterwards. If
     * the environment held a copy this prints `0`, and every other test in the
     * file would still pass.
     */
    test("a write through a capture lands on the enclosing frame's local", async () => {
        const result = await run(
            "closure-write",
            `function each(n: i32, f: LocalFn<(x: i32) => void>): void {
         for (let i: i32 = 0; i < n; i++) {
           f(i);
         }
       }

       export function main(): i32 {
         let total: i32 = 0;
         const scale: i32 = 10;
         each(5, (x) => { total += x * scale; });
         console.log(\`\${total}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("100\n");
        expect(result.stderr).toBe("");
    });

    test("a closure runs many times, over the same environment", async () => {
        const result = await run(
            "closure-repeat",
            `function times(n: i32, f: LocalFn<() => void>): void {
         for (let i: i32 = 0; i < n; i++) {
           f();
         }
       }

       export function main(): i32 {
         let calls: i32 = 0;
         times(4, () => { calls += 1; });
         times(3, () => { calls += 10; });
         console.log(\`\${calls}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("34\n");
    });

    test("an owning capture is borrowed, not copied and not released", async () => {
        // The allocation check is the assertion that matters here: `name` is a
        // `string`, the closure reads it, and exactly one buffer exists for the
        // whole program. A capture that copied would show a second, and one that
        // took ownership would double-free on the way out.
        const result = await run(
            "closure-owning",
            `function apply(f: LocalFn<() => void>): void {
         f();
       }

       export function main(): i32 {
         const name: string = "wor" + "ld";
         apply(() => { console.log(\`hello \${name}\`); });
         console.log(\`\${name.length}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("hello world\n5\n");
        expect(result.stderr).toBe("");
    });

    test("a concise body is the return value", async () => {
        const result = await run(
            "closure-concise",
            `function apply(f: LocalFn<(x: i32) => i32>, v: i32): i32 {
         return f(v);
       }

       export function main(): i32 {
         const n: i32 = 5;
         console.log(\`\${apply((x) => x * n, 6)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("30\n");
    });

    test("a parameter shadowing a capture is the parameter", async () => {
        const result = await run(
            "closure-shadow",
            `function apply(f: LocalFn<(x: i32) => i32>, v: i32): i32 {
         return f(v);
       }

       export function main(): i32 {
         const x: i32 = 100;
         console.log(\`\${apply((x) => x + 1, 7)}\`);
         console.log(\`\${x}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("8\n100\n");
    });

    /**
     * A name captured *and* shadowed, in a nested block.
     *
     * The reason capture analysis asks tsc rather than collecting declared
     * names: a flat name set sees `total` declared inside and concludes it is
     * not a capture, which silently drops the write on the line above.
     */
    test("a capture that is also shadowed deeper in the body is still a capture", async () => {
        const result = await run(
            "closure-shadow-nested",
            `function apply(f: LocalFn<() => void>): void {
         f();
       }

       export function main(): i32 {
         let total: i32 = 1;
         apply(() => {
           total += 10;
           {
             const total: i32 = 999;
             console.log(\`\${total}\`);
           }
         });
         console.log(\`\${total}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("999\n11\n");
    });

    test("a `LocalFn` is bound to a name and passed on, inside the call", async () => {
        const result = await run(
            "closure-forward",
            `function apply(f: LocalFn<(x: i32) => i32>, v: i32): i32 {
         return f(v);
       }

       function forward(f: LocalFn<(x: i32) => i32>, v: i32): i32 {
         const g = f;
         return apply(g, v);
       }

       export function main(): i32 {
         let seen: i32 = 0;
         console.log(\`\${forward((x) => { seen += 1; return x * 2; }, 7)}\`);
         console.log(\`\${seen}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("14\n1\n");
    });

    test("a closure calls a declared function, which is not a capture", async () => {
        const result = await run(
            "closure-calls-fn",
            `function twice(x: i32): i32 {
         return x * 2;
       }

       function apply(f: LocalFn<(x: i32) => i32>, v: i32): i32 {
         return f(v);
       }

       export function main(): i32 {
         const bump: i32 = 1;
         console.log(\`\${apply((x) => twice(x) + bump, 10)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("21\n");
    });

    /**
     * `return name` inside a closure is a **copy**, not the move it would be for
     * an ordinary local. The enclosing frame still owns `name` and still
     * destroys it, so moving out would hand the same buffer to two releases —
     * the shape `GF0236` refuses for a by-value parameter, arriving by a
     * different route. The allocation check is what proves it.
     */
    test("returning an owning capture copies it", async () => {
        const result = await run(
            "closure-return-capture",
            `function apply(f: LocalFn<() => string>): void {
         const got: string = f();
         console.log(got);
       }

       export function main(): i32 {
         const name: string = "wor" + "ld";
         apply(() => name);
         console.log(\`\${name.length}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("world\n5\n");
        expect(result.stderr).toBe("");
    });

    test("two closures over the same local both see the writes", async () => {
        const result = await run(
            "closure-two",
            `function apply(f: LocalFn<() => void>): void {
         f();
       }

       export function main(): i32 {
         let n: i32 = 0;
         apply(() => { n += 2; });
         apply(() => { n *= 5; });
         console.log(\`\${n}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("10\n");
    });
});

/**
 * `this` is a local of type `Reference<Self>` bound under that name
 * (REWRITE-PLAN §4.6), so a closure captures it the way it captures any other
 * local — one mechanism, not two. The environment holds a reference to the
 * local holding the reference, which is one more indirection than strictly
 * needed and one fewer shape of capture to keep in agreement.
 */
describe("LocalFn, capturing `this`", () => {
    test("a field is read and written through the captured receiver", async () => {
        const result = await run(
            "closure-this-field",
            `function apply(f: LocalFn<() => void>): void { f(); }

       class Counter {
         n: i32 = 0;

         bump(by: i32): void {
           this.n += by;
         }

         run(): void {
           apply(() => {
             this.n += 1;
             this.bump(10);
             console.log(\`\${this.n}\`);
           });
         }
       }

       export function main(): i32 {
         const c: Counter = new Counter();
         c.run();
         console.log(\`\${c.n}\`);
         return 0;
       }\n`,
        );
        // The second line is the point: the writes landed on `c`, not on a copy
        // the closure was holding.
        expect(result.stdout).toBe("11\n11\n");
        expect(result.stderr).toBe("");
    });

    /**
     * `() => this.v += 2` — a concise body whose value is discarded, writing
     * through a captured receiver. Three things that are each tested elsewhere
     * and had not met: the void concise-body path, a compound assignment, and a
     * field reached through the environment.
     */
    test("a concise body writes through the captured receiver", async () => {
        const result = await run(
            "closure-this-concise",
            `function apply(f: LocalFn<() => void>): void { f(); }

       class Box {
         v: i32 = 0;
         run(): void { apply(() => this.v += 2); }
       }

       export function main(): i32 {
         const b: Box = new Box();
         b.run();
         b.run();
         console.log(\`\${b.v}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("4\n");
        expect(result.stderr).toBe("");
    });

    test("`this` alongside parameters and locals", async () => {
        const result = await run(
            "closure-this-mixed",
            `function apply(f: LocalFn<() => void>): void { f(); }

       class Acc {
         total: i32 = 0;

         add(a: i32, b: i32): void {
           const bonus: i32 = 100;
           apply(() => { this.total += a + b + bonus; });
         }
       }

       export function main(): i32 {
         const acc: Acc = new Acc();
         acc.add(1, 2);
         console.log(\`\${acc.total}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("103\n");
    });

    test("a method call through the captured receiver still dispatches virtually", async () => {
        const result = await run(
            "closure-this-virtual",
            `function apply(f: LocalFn<() => void>): void { f(); }

       class Animal {
         speak(): string { return "..."; }
         announce(): void {
           apply(() => { console.log(this.speak()); });
         }
       }

       class Wolf extends Animal {
         override speak(): string { return "howl"; }
       }

       export function main(): i32 {
         const w: Wolf = new Wolf();
         w.announce();
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("howl\n");
    });

    test("`super.m()` inside a closure is still a direct call to the base", async () => {
        const result = await run(
            "closure-this-super",
            `function apply(f: LocalFn<() => void>): void { f(); }

       class Animal {
         speak(): string { return "..."; }
       }

       class Wolf extends Animal {
         override speak(): string { return "howl"; }

         both(): void {
           apply(() => {
             console.log(super.speak());
             console.log(this.speak());
           });
         }
       }

       export function main(): i32 {
         const w: Wolf = new Wolf();
         w.both();
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("...\nhowl\n");
    });

    /**
     * A `function` expression is a closure over names but **not** over `this`:
     * JavaScript binds its `this` from the receiver at the call site, and a
     * `LocalFn` is a code address and an environment with no receiver in it. So
     * `this` in there is not a *different* receiver, it is one nothing can
     * supply — and it is refused rather than quietly given the enclosing one.
     */
    test("a `function` expression may not use the enclosing `this`", async () => {
        // tsc refuses the bare spelling under `noImplicitThis`, so this is the
        // one it lets through: a declared `this` parameter is a promise about
        // what some caller will supply.
        await expectRejected(
            "closure-fn-this-param",
            `function apply(f: LocalFn<() => void>): void { f(); }

       class Box {
         v: i32 = 0;
         run(): void { apply(function (this: Box) { this.v = 1; }); }
       }

       export function main(): i32 { const b: Box = new Box(); b.run(); return 0; }\n`,
            "GF0002",
        );
    });

    test("and is refused by the compiler, not only by `noImplicitThis`", async () => {
        // The `strict` guard in `checker/src/tsconfig.ts` accepts
        // `strictNullChecks` + `noImplicitAny` in place of `strict`, which does
        // not imply `noImplicitThis` — so a project really can reach here with
        // tsc silent, and the rule cannot be tsc's alone.
        await expectRejected(
            "closure-fn-this-loose",
            `function apply(f: LocalFn<() => void>): void { f(); }

       class Box {
         v: i32 = 0;
         run(): void { apply(function () { this.v = 1; }); }
       }

       export function main(): i32 { const b: Box = new Box(); b.run(); return 0; }\n`,
            "GF0002",
            {compilerOptions: {noImplicitThis: false}},
        );
    });

    test("a `function` expression that does not use `this` is an ordinary closure", async () => {
        const result = await run(
            "closure-fn-plain",
            `function apply(f: LocalFn<() => void>): void { f(); }

       export function main(): i32 {
         let n: i32 = 0;
         apply(function () { n += 1; });
         console.log(\`\${n}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1\n");
    });

    test("a closure inside a constructor captures the receiver being built", async () => {
        const result = await run(
            "closure-this-ctor",
            `function apply(f: LocalFn<() => void>): void { f(); }

       class Box {
         v: i32 = 0;

         constructor(start: i32) {
           apply(() => { this.v = start; });
         }
       }

       export function main(): i32 {
         const b: Box = new Box(7);
         console.log(\`\${b.v}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("7\n");
    });
});

describe("LocalFn, refused", () => {
    test("returning one", async () => {
        await expectRejected(
            "closure-escape-return",
            `function make(): LocalFn<(x: i32) => i32> {
         return (x) => x;
       }

       export function main(): i32 { return 0; }\n`,
            "GF0239",
        );
    });

    test("storing one in a field", async () => {
        await expectRejected(
            "closure-escape-field",
            `interface Holder { readonly f: LocalFn<(x: i32) => i32>; }

       function take(h: Holder): void {}

       export function main(): i32 { return 0; }\n`,
            "GF0239",
        );
    });

    test("an array of them", async () => {
        await expectRejected(
            "closure-escape-array",
            `function take(fs: LocalFn<(x: i32) => i32>[]): void {}

       export function main(): i32 { return 0; }\n`,
            "GF0239",
        );
    });

    /**
     * The environment is a temporary of the statement that writes the lambda, so
     * a binding outlives it. Same rule as `GF0234`'s, same reasoning.
     */
    test("binding a written lambda to a name", async () => {
        await expectRejected(
            "closure-escape-binding",
            `function apply(f: LocalFn<(x: i32) => i32>, v: i32): i32 { return f(v); }

       export function main(): i32 {
         let n: i32 = 3;
         const g: LocalFn<(x: i32) => i32> = (x) => x + n;
         return apply(g, 1);
       }\n`,
            "GF0239",
        );
    });

    test("a lambda where nothing expects one", async () => {
        await expectRejected(
            "closure-nowhere",
            `export function main(): i32 {
         const g = (x: i32) => x;
         return 0;
       }\n`,
            "GF0239",
        );
    });

    test("moving out of a capture", async () => {
        await expectRejected(
            "closure-move-capture",
            `function apply(f: LocalFn<() => void>): void { f(); }

       export function main(): i32 {
         const s: string = "a" + "b";
         apply(() => { const t: string = move(s); });
         return 0;
       }\n`,
            "GF0238",
        );
    });

    test("one crossing the C boundary", async () => {
        await expectRejected(
            "closure-c-boundary",
            `export function take(f: LocalFn<(x: i32) => i32>): i32 { return f(1); }

       export function main(): i32 { return 0; }\n`,
            "GF0301",
        );
    });

});

/**
 * A closure inside a closure needs nothing added, and the reason is worth
 * stating because the opposite is the intuitive answer.
 *
 * The inner environment does not reach *through* the outer one. Its field
 * operand is a `Ref` of the captured binding's place, and a capture's place
 * ends in a `Deref` — so taking its address hands back the address that was
 * dereferenced, which is the original frame's slot. Each level collapses rather
 * than chaining, so a capture three closures deep costs the same two loads as
 * one, and every level writes to the same storage.
 */
describe("`forEach`, the first prelude method that takes a closure", () => {
    test("a capture accumulates across the whole array", async () => {
        const result = await run(
            "foreach-sum",
            `export function main(): i32 {
         const xs: i32[] = [1, 2, 3, 4];
         let total: i32 = 0;
         xs.forEach((x) => { total = total + x; });
         return total;
       }\n`,
        );
        expect(result.exitCode).toBe(10);
        expect(result.leaked).toBe(0);
    });

    test("an empty array calls nothing", async () => {
        const result = await run(
            "foreach-empty",
            `export function main(): i32 {
         const xs: i32[] = [];
         let calls: i32 = 0;
         xs.forEach((x) => { calls = calls + x + 1; });
         return calls;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("the element type reaches the callback, and owning elements balance", async () => {
        // The type comes from tsc's *contextual* type at the call — `Array<T>`
        // is generic, so nothing else knows the callback takes a `string`. And
        // the element arrives by value, so each one is copied in and released by
        // the callee: a non-zero leak count here would mean one half happened
        // without the other.
        const result = await run(
            "foreach-strings",
            `export function main(): i32 {
         const words: string[] = ["a", "bb", "ccc"];
         let n: usize = 0;
         words.forEach((w) => { n = n + w.length; });
         console.log(\`\${n}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("6\n");
        expect(result.leaked).toBe(0);
    });

    test("the callback may call a declared function and read other captures", async () => {
        const result = await run(
            "foreach-mixed",
            `function twice(n: i32): i32 { return n * 2; }

       export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         const bonus: i32 = 10;
         let total: i32 = 0;
         xs.forEach((x) => { total = total + twice(x) + bonus; });
         return total;
       }\n`,
        );
        expect(result.exitCode).toBe(42);
        expect(result.leaked).toBe(0);
    });

    test("forEach nests over two arrays", async () => {
        const result = await run(
            "foreach-nested",
            `export function main(): i32 {
         const rows: i32[] = [1, 2, 3];
         const cols: i32[] = [10, 20];
         let total: i32 = 0;
         rows.forEach((r) => {
           cols.forEach((c) => { total = total + r * c; });
         });
         return total;
       }\n`,
        );
        expect(result.exitCode).toBe(180);
        expect(result.leaked).toBe(0);
    });

    test("writing an element through the array the callback captured", async () => {
        // The array is a capture like any other, so this reaches the caller's
        // own buffer rather than a copy of it.
        const result = await run(
            "foreach-write-back",
            `export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         let i: usize = 0;
         xs.forEach((x) => { xs[i] = x * 10; i = i + 1; });
         return xs[0] + xs[1] + xs[2];
       }\n`,
        );
        expect(result.exitCode).toBe(60);
        expect(result.leaked).toBe(0);
    });

    test("an array reached through a `Reference` iterates too", async () => {
        // The receiver is resolved by `asArray`, which unwraps a reference — so
        // a function taking `Reference<T[]>` to avoid copying the buffer can
        // still iterate it.
        const result = await run(
            "foreach-by-reference",
            `function total(xs: Reference<i32[]>): i32 {
         let n: i32 = 0;
         xs.forEach((x) => { n = n + x; });
         return n;
       }

       export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         return total(xs);
       }\n`,
        );
        expect(result.exitCode).toBe(6);
        expect(result.leaked).toBe(0);
    });

    test("an array of class values iterates without copying itself apart", async () => {
        const result = await run(
            "foreach-classes",
            `class Rect { w: i32; h: i32; constructor(w: i32, h: i32) { this.w = w; this.h = h; } }

       export function main(): i32 {
         const rs: Rect[] = [new Rect(2, 3), new Rect(4, 5)];
         let area: i32 = 0;
         rs.forEach((r) => { area = area + r.w * r.h; });
         return area;
       }\n`,
        );
        expect(result.exitCode).toBe(26);
        expect(result.leaked).toBe(0);
    });

    test("a `FixedArray` has no `forEach`, and tsc is what says so", async () => {
        // Not an oversight. `FixedArray<T, N>` extends `CorePointer<T>`, not
        // `Array<T>` — it *is* the bytes, and the methods that grow and iterate
        // a handle are the handle's. Pinned because "helpfully" adding it to the
        // prelude would make a fixed array pretend to be a vector.
        await expectRejected(
            "foreach-fixed-array",
            `export function main(): i32 {
         const buf: FixedArray<i32, 3> = fixedArray(3, 2);
         let total: i32 = 0;
         buf.forEach((x) => { total = total + x; });
         return total;
       }\n`,
            "TS2339",
        );
    });

    test("a callback of the wrong arity is refused by tsc", async () => {
        // Which is why the lowerer's own arity check is defence rather than the
        // diagnostic anybody sees: the declared parameter type is a `LocalFn`
        // with one argument, and a two-argument lambda does not satisfy it.
        await expectRejected(
            "foreach-wrong-arity",
            `export function main(): i32 {
         const xs: i32[] = [1];
         xs.forEach((a, b) => { });
         return 0;
       }\n`,
            "TS2345",
        );
    });

    test("a callback that is not written as a lambda still works", async () => {
        // A `LocalFn` parameter accepts a non-capturing lambda with a null
        // environment, which is what lets a caller not know which kind it wrote.
        const result = await run(
            "foreach-noncapturing",
            `export function main(): i32 {
         const xs: i32[] = [5, 6];
         xs.forEach((x) => { console.log(\`\${x}\`); });
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("5\n6\n");
        expect(result.leaked).toBe(0);
    });
});

describe("LocalFn, nested", () => {
    test("the inner closure writes to the outermost frame's local", async () => {
        const result = await run(
            "closure-nested-write",
            `function apply(f: LocalFn<() => void>): void { f(); }

       export function main(): i32 {
         let n: i32 = 0;
         apply(() => { apply(() => { n += 1; }); });
         console.log(\`\${n}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1\n");
        expect(result.stderr).toBe("");
    });

    test("three deep, every level writing the same local", async () => {
        const result = await run(
            "closure-nested-three",
            `function apply(f: LocalFn<() => void>): void { f(); }

       export function main(): i32 {
         let n: i32 = 1;
         const step: i32 = 10;
         apply(() => {
           n += step;
           apply(() => {
             n += step;
             apply(() => { n += step; });
           });
         });
         console.log(\`\${n}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("31\n");
    });

    test("the inner closure over the outer closure's own parameter", async () => {
        // Not a capture-of-a-capture: `x` is an ordinary local of the outer
        // closure's frame, which is alive for the whole of the inner call.
        const result = await run(
            "closure-nested-param",
            `function apply(f: LocalFn<() => void>): void { f(); }

       function each(n: i32, f: LocalFn<(x: i32) => void>): void {
         for (let i: i32 = 0; i < n; i++) { f(i); }
       }

       export function main(): i32 {
         let total: i32 = 0;
         each(4, (x) => {
           apply(() => { total += x; });
         });
         console.log(\`\${total}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("6\n");
    });

    test("`this` through two levels", async () => {
        const result = await run(
            "closure-nested-this",
            `function apply(f: LocalFn<() => void>): void { f(); }

       class Counter {
         n: i32 = 0;

         run(): void {
           apply(() => {
             this.n += 1;
             apply(() => { this.n += 10; });
           });
         }
       }

       export function main(): i32 {
         const c: Counter = new Counter();
         c.run();
         console.log(\`\${c.n}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("11\n");
    });

    test("an owning capture reassigned from the inner closure", async () => {
        // The allocation check is the assertion: the release of the old buffer
        // belongs to the frame that owns `s`, two levels up, and happens once.
        const result = await run(
            "closure-nested-owning",
            `function apply(f: LocalFn<() => void>): void { f(); }

       export function main(): i32 {
         let s: string = "a" + "b";
         apply(() => {
           apply(() => { s = "c" + "d"; });
         });
         console.log(s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("cd\n");
        expect(result.stderr).toBe("");
    });
});
