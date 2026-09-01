/**
 * Function pointers: a function as a value.
 *
 * One machine word holding a code address, owning nothing, and **always
 * classified by the C rules**. That last part is the whole design rather than a
 * simplification: a function pointer exists so that a call site and a
 * definition agree without sharing a declaration, and C's classification is the
 * only one anything outside this build knows. So a function whose address is
 * taken is emitted C-classified too, and the two cannot drift.
 *
 * There are no closures. A capturing function needs an environment and a
 * function pointer has nowhere to put one, which is also why an *instance*
 * method cannot be one — `c.speak` needs a receiver — and why `static` is the
 * spelling a callback written in a class takes.
 *
 * The distinction that decides how a call is emitted is the one the language
 * already draws at a declaration: `speak(): i32` is a method and dispatches;
 * `speak: () => i32` is a field holding an address and is called through.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("a function as a value", () => {
    test("bound to a name, then called", async () => {
        const result = await run(
            "fn-value",
            `function add(a: i32, b: i32): i32 { return a + b; }

       export function main(): i32 {
         const f: (a: i32, b: i32) => i32 = add;
         return f(2, 3);
       }\n`,
        );
        expect(result.exitCode).toBe(5);
    });

    test("passed as a parameter and called by the callee", async () => {
        const result = await run(
            "fn-parameter",
            `function add(a: i32, b: i32): i32 { return a + b; }
       function apply(f: (a: i32, b: i32) => i32, x: i32): i32 { return f(x, x); }

       export function main(): i32 {
         return apply(add, 5);
       }\n`,
        );
        expect(result.exitCode).toBe(10);
    });

    test("naming a function does not stop it being called directly", async () => {
        // Taking the address changes the *convention* the function is emitted
        // under, not how a direct call to it is written — and both spellings have
        // to keep working in the same program.
        const result = await run(
            "fn-both-ways",
            `function add(a: i32, b: i32): i32 { return a + b; }

       export function main(): i32 {
         const f: (a: i32, b: i32) => i32 = add;
         return add(1, 2) + f(3, 4);
       }\n`,
        );
        expect(result.exitCode).toBe(10);
    });

    test("a `void` return", async () => {
        const result = await run(
            "fn-void",
            `function shout(): void { console.log("hi"); }

       export function main(): i32 {
         const f: () => void = shout;
         f();
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("hi\n");
    });

    test("an aggregate parameter travels by the C rules on both halves", async () => {
        // The case the "always C" rule exists for. A struct is passed one way under
        // the internal convention and another under C's, so if the pointer's
        // signature and the definition disagreed this would return a plausible
        // wrong number rather than fail.
        const result = await run(
            "fn-struct-param",
            `interface P { x: i32; y: i32; }

       function sum(p: P): i32 { return p.x + p.y; }

       export function main(): i32 {
         const f: (p: P) => i32 = sum;
         return f({ x: 3, y: 4 });
       }\n`,
        );
        expect(result.exitCode).toBe(7);
    });

    test("an aggregate return does too", async () => {
        const result = await run(
            "fn-struct-return",
            `interface P { x: i32; y: i32; }

       function make(a: i32): P { return { x: a, y: a * 2 }; }

       export function main(): i32 {
         const f: (a: i32) => P = make;
         const p: P = f(3);
         return p.x + p.y;
       }\n`,
        );
        expect(result.exitCode).toBe(9);
    });

    test("a larger aggregate, past what fits in registers", async () => {
        const result = await run(
            "fn-big-struct",
            `interface Big { a: i32; b: i32; c: i32; d: i32; e: i32; f: i32; }

       function total(v: Big): i32 { return v.a + v.b + v.c + v.d + v.e + v.f; }

       export function main(): i32 {
         const f: (v: Big) => i32 = total;
         return f({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
       }\n`,
        );
        expect(result.exitCode).toBe(21);
    });

    test("floats, which are classified into different registers", async () => {
        const result = await run(
            "fn-floats",
            `function scale(a: f64, b: f64): f64 { return a * b; }

       export function main(): i32 {
         const f: (a: f64, b: f64) => f64 = scale;
         console.log(\`\${f(1.5, 4)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("6\n");
    });

    test("two addresses compare, so a callback can be recognised", async () => {
        const result = await run(
            "fn-compare",
            `function a(): i32 { return 1; }
       function b(): i32 { return 2; }

       export function main(): i32 {
         const f: () => i32 = a;
         const g: () => i32 = a;
         const h: () => i32 = b;
         if (f === g && f !== h) { return 0; }
         return 1;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
    });

    test("reassigning which function a binding names", async () => {
        const result = await run(
            "fn-reassign",
            `function one(): i32 { return 1; }
       function two(): i32 { return 2; }

       export function main(): i32 {
         let f: () => i32 = one;
         const first: i32 = f();
         f = two;
         return first * 10 + f();
       }\n`,
        );
        expect(result.exitCode).toBe(12);
    });

    test("recursion through a pointer", async () => {
        const result = await run(
            "fn-recursive",
            `function countdown(n: i32): i32 {
         const self: (n: i32) => i32 = countdown;
         if (n <= 0) { return 0; }
         return 1 + self(n - 1);
       }

       export function main(): i32 {
         return countdown(5);
       }\n`,
        );
        expect(result.exitCode).toBe(5);
    });

    test("one imported from another module", async () => {
        const result = await run(
            "fn-cross-module",
            `import { add } from "./math.ts";

       function apply(f: (a: i32, b: i32) => i32): i32 { return f(20, 22); }

       export function main(): i32 {
         return apply(add);
       }\n`,
            {files: {"math.ts": `export function add(a: i32, b: i32): i32 { return a + b; }\n`}},
        );
        expect(result.exitCode).toBe(42);
    });
});

describe("where a function pointer can live", () => {
    test("a struct field — C's struct of callbacks", async () => {
        const result = await run(
            "fn-in-struct",
            `interface Ops { apply: (a: i32) => i32; }

       function twice(a: i32): i32 { return a * 2; }

       export function main(): i32 {
         const o: Ops = { apply: twice };
         return o.apply(21);
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("an array element", async () => {
        const result = await run(
            "fn-in-array",
            `function one(): i32 { return 1; }
       function two(): i32 { return 2; }

       export function main(): i32 {
         const fs: (() => i32)[] = [one, two];
         return fs[0]() + fs[1]() * 10;
       }\n`,
        );
        expect(result.exitCode).toBe(21);
    });

    test("a class field, assigned in the constructor", async () => {
        const result = await run(
            "fn-in-class",
            `function twice(a: i32): i32 { return a * 2; }

       class Button {
         onClick: (a: i32) => i32;
         constructor(f: (a: i32) => i32) { this.onClick = f; }
       }

       export function main(): i32 {
         const b = new Button(twice);
         return b.onClick(21);
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("a struct holding one is trivially copied", async () => {
        // A code address owns nothing, so a struct holding one needs no drop and
        // copies as bytes.
        const result = await run(
            "fn-struct-copy",
            `interface Ops { apply: (a: i32) => i32; }

       function twice(a: i32): i32 { return a * 2; }

       export function main(): i32 {
         const a: Ops = { apply: twice };
         const b: Ops = a;
         return b.apply(21);
       }\n`,
        );
        expect(result.exitCode).toBe(42);
        expect(result.leaked).toBe(0);
    });
});

describe("`static` methods", () => {
    test("called by name", async () => {
        const result = await run(
            "static-call",
            `class M { static twice(a: i32): i32 { return a * 2; } }

       export function main(): i32 {
         return M.twice(21);
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("taken as a function pointer, which an instance method cannot be", async () => {
        const result = await run(
            "static-as-value",
            `class M { static twice(a: i32): i32 { return a * 2; } }

       function apply(f: (a: i32) => i32, x: i32): i32 { return f(x); }

       export function main(): i32 {
         return apply(M.twice, 21);
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("one static may call another", async () => {
        const result = await run(
            "static-calls-static",
            `class M {
         static twice(a: i32): i32 { return a * 2; }
         static quad(a: i32): i32 { return M.twice(M.twice(a)); }
       }

       export function main(): i32 {
         return M.quad(3);
       }\n`,
        );
        expect(result.exitCode).toBe(12);
    });

    test("inherited, because the name resolves through the base", async () => {
        const result = await run(
            "static-inherited",
            `class A { static id(a: i32): i32 { return a; } }
       class B extends A { }

       export function main(): i32 {
         return B.id(7);
       }\n`,
        );
        expect(result.exitCode).toBe(7);
    });

    test("a derived class may shadow a base static, and each keeps its own body", async () => {
        // Shadowing, not overriding: there is no receiver, so nothing dispatches.
        // The name is resolved at compile time against the class it was written
        // on, and a class that declares neither inherits whichever one it reaches
        // first. Both bodies are emitted, under `A$tag` and `B$tag`.
        const result = await run(
            "static-shadowed",
            `class A { static tag(): i32 { return 1; } }
       class B extends A { static override tag(): i32 { return 2; } }
       class C extends B { }

       export function main(): i32 {
         console.log(\`\${A.tag()} \${B.tag()} \${C.tag()}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 2 2\n");
    });

    test("`override` is required on a shadowing static, as it is on a method", async () => {
        // tsc's rule under `noImplicitOverride`, and it applies to statics too —
        // which is easy to be surprised by, because nothing is being overridden in
        // the dispatch sense.
        const {result} = await compileSource(
            "static-no-override",
            `class A { static tag(): i32 { return 1; } }
       class B extends A { static tag(): i32 { return 2; } }

       export function main(): i32 { return B.tag(); }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS4114");
    });

    test("a static and an instance method may share a class", async () => {
        const result = await run(
            "static-beside-instance",
            `class C {
         n: i32;
         constructor(n: i32) { this.n = n; }
         get(): i32 { return this.n; }
         static make(n: i32): i32 { return n * 2; }
       }

       export function main(): i32 {
         const c = new C(3);
         return c.get() * 10 + C.make(2);
       }\n`,
        );
        expect(result.exitCode).toBe(34);
    });

    test("`this` inside a static is not in scope", async () => {
        const {result} = await compileSource(
            "static-this",
            `class C {
         n: i32;
         static get(): i32 { return this.n; }
       }

       export function main(): i32 { return 0; }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result).length).toBeGreaterThan(0);
    });

    test("a static may take and return owning values, like any internal function", async () => {
        const result = await run(
            "static-owning",
            `class Text {
         static shout(s: string): string { return s + "!"; }
       }

       export function main(): i32 {
         console.log(Text.shout("hi"));
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("hi!\n");
        expect(result.leaked).toBe(0);
    });
});

describe("the C boundary", () => {
    test("an exported function may take a callback", async () => {
        const {result} = await compileSource(
            "fn-exported-callback",
            `export function run(f: (a: i32) => i32, x: i32): i32 { return f(x); }

       export function main(): i32 { return 0; }\n`,
        );
        expect(result.ok).toBe(true);
    });

    test("the header gives a callback a typedef and uses it", async () => {
        // A typedef rather than an inline declarator, because C spells a function
        // *returning* a function pointer as `int32_t (*pick(bool))(int32_t)` — which
        // no `${ret} ${name}(${params})` template can produce. The typedef makes a
        // callback an ordinary noun in every position.
        const {result} = await compileSource(
            "fn-header",
            `export function run(f: (a: i32) => i32, x: i32): i32 { return f(x); }
       export function pick(): (a: i32) => i32 { return double; }
       function double(a: i32): i32 { return a * 2; }\n`,
            {type: "static-lib"},
        );
        expect(result.ok).toBe(true);
        const header = await Bun.file(result.headerPath!).text();
        expect(header).toMatch(/typedef int32_t \(\*GfFn\d+\)\(int32_t\);/);
        expect(header).toMatch(/int32_t run\(GfFn\d+ p0, int32_t p1\);/);
        expect(header).toMatch(/GfFn\d+ pick\(void\);/);
    });

    test("a struct reached only through a callback is still declared", async () => {
        // The header's dependency walk has to descend into a callback's signature.
        // Without it the typedef names a struct C has never heard of, and the
        // failure is a syntax error in the *consumer* rather than here.
        const {result} = await compileSource(
            "fn-header-struct",
            `interface Point { x: i32; y: i32; }

       export function applyTo(f: (p: Point) => i32): i32 { return f({ x: 1, y: 2 }); }\n`,
            {type: "static-lib"},
        );
        expect(result.ok).toBe(true);
        const header = await Bun.file(result.headerPath!).text();
        // Declared as a forward declaration, and defined after the callback —
        // the callback's typedef comes before the struct definitions, because
        // a struct field of callback type needs the name. A forward
        // declaration is all the typedef's mention needs: C allows an
        // incomplete parameter type in a declarator that is not a definition.
        expect(header).toContain("struct Point {\n    int32_t x;\n    int32_t y;\n};");
        expect(header.indexOf("typedef struct Point Point;")).toBeLessThan(
            header.indexOf("typedef int32_t (*GfFn"),
        );
    });

    test("a callback whose signature cannot cross is refused", async () => {
        // The rule is the same one every exported signature obeys, applied one
        // level in: what the callback itself takes has to be able to cross too.
        await expectRejected(
            "fn-boundary-owning",
            `interface Named { id: i32; name: string; }

       export function run(f: (n: Named) => i32): i32 { return 0; }

       export function main(): i32 { return 0; }\n`,
            "GF0301",
        );
    });
});

describe("what a function pointer is not", () => {
    test("an instance method needs a receiver, so it cannot be one", async () => {
        const diagnostic = await expectRejected(
            "fn-instance-method",
            `class C { twice(a: i32): i32 { return a * 2; } }

       export function main(): i32 {
         const c = new C();
         const f: (a: i32) => i32 = c.twice;
         return f(1);
       }\n`,
            "GF0001",
        );
        expect(diagnostic.message).toContain("method");
    });

    test("an arrow function is GF0001 — there are no closures", async () => {
        await expectRejected(
            "fn-arrow",
            `export function main(): i32 {
         const f: (a: i32) => i32 = (a) => a * 2;
         return f(3);
       }\n`,
            "GF0001",
        );
    });

    test("a capturing arrow is the same refusal", async () => {
        await expectRejected(
            "fn-closure",
            `export function main(): i32 {
         const n: i32 = 2;
         const f: (a: i32) => i32 = (a) => a * n;
         return f(3);
       }\n`,
            "GF0001",
        );
    });

    test("an overloaded function type has no single address", async () => {
        const {result} = await compileSource(
            "fn-overloaded-type",
            `interface Both { (a: i32): i32; (a: f64): f64; }

       export function main(): i32 {
         return 0;
       }\n`,
        );
        // Declared but unused, so nothing erases it — the point is only that this
        // does not crash the compiler.
        expect(result.diagnostics.every((d) => !d.code.startsWith("GF9"))).toBe(true);
    });

    test("a signature mismatch is tsc's business", async () => {
        const {result} = await compileSource(
            "fn-mismatch",
            `function add(a: i32, b: i32): i32 { return a + b; }

       export function main(): i32 {
         const f: (a: i32) => i32 = add;
         return f(1);
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
    });

    test("a function pointer owns nothing, so nothing is released", async () => {
        const result = await run(
            "fn-no-drop",
            `function one(): i32 { return 1; }

       export function main(): i32 {
         let i: i32 = 0;
         let total: i32 = 0;
         while (i < 20) {
           const f: () => i32 = one;
           total = total + f();
           i = i + 1;
         }
         return total;
       }\n`,
        );
        expect(result.exitCode).toBe(20);
        expect(result.leaked).toBe(0);
    });
});
