/**
 * Structs, and the value semantics they make visible.
 *
 * REWRITE-PLAN §4.7 lists "objects are values" as the largest semantic
 * difference the language has from TypeScript, and the one tsc cannot warn
 * about. This is where it becomes observable:
 *
 *     const b = a;  b.x = 5;   // `a` is untouched
 *
 * Layout itself is tested differentially against a C compiler in
 * `layout.test.ts`; these test what the language does with it.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

const POINT = `interface Point { x: i32; y: i32; }\n`;

describe("structs", () => {
    test("an object literal builds a value, and its fields read back", async () => {
        const result = await run(
            "struct-literal",
            `${POINT}
       export function main(): i32 {
         const p: Point = { x: 3, y: 4 };
         console.log(\`(\${p.x}, \${p.y})\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("(3, 4)\n");
    });

    test("objects are values: binding copies", async () => {
        // The line REWRITE-PLAN §4.7 says has to be on the README's first page.
        const result = await run(
            "struct-value-semantics",
            `${POINT}
       export function main(): i32 {
         const a: Point = { x: 1, y: 2 };
         const b: Point = a;
         b.x = 5;
         console.log(\`a.x=\${a.x} b.x=\${b.x}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("a.x=1 b.x=5\n");
    });

    test("a by-value parameter is a copy the callee cannot write back through", async () => {
        const result = await run(
            "struct-by-value",
            `${POINT}
       function moveIt(p: Point): i32 {
         p.x = 99;
         return p.x;
       }

       export function main(): i32 {
         const original: Point = { x: 1, y: 2 };
         const inside: i32 = moveIt(original);
         console.log(\`inside=\${inside} outside=\${original.x}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("inside=99 outside=1\n");
    });

    test("a struct is returned into storage the caller designates", async () => {
        const result = await run(
            "struct-return",
            `${POINT}
       function shifted(p: Point, by: i32): Point {
         return { x: p.x + by, y: p.y };
       }

       export function main(): i32 {
         const start: Point = { x: 10, y: 20 };
         const moved: Point = shifted(start, 5);
         console.log(\`(\${moved.x}, \${moved.y}) from (\${start.x}, \${start.y})\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("(15, 20) from (10, 20)\n");
    });
});

describe("nested aggregates are inline", () => {
    test("a struct field occupies its own layout, not a pointer to it", async () => {
        // Not negotiable if C interop is a goal, and v1 had to be retrofitted for
        // it (REWRITE-PLAN §5.2). Observable here as the inner value being copied
        // with the outer one rather than shared with it.
        const result = await run(
            "struct-nested",
            `${POINT}
       interface Line { from: Point; to: Point; }

       export function main(): i32 {
         const a: Line = { from: { x: 0, y: 0 }, to: { x: 3, y: 4 } };
         const b: Line = a;
         b.to.x = 100;
         console.log(\`a.to.x=\${a.to.x} b.to.x=\${b.to.x}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("a.to.x=3 b.to.x=100\n");
    });

    test("three levels deep still copies the whole thing", async () => {
        const result = await run(
            "struct-deep",
            `interface Inner { v: i32; }
       interface Middle { inner: Inner; }
       interface Outer { middle: Middle; tag: i32; }

       export function main(): i32 {
         const a: Outer = { middle: { inner: { v: 1 } }, tag: 7 };
         const b: Outer = a;
         b.middle.inner.v = 42;
         console.log(\`\${a.middle.inner.v} \${b.middle.inner.v} \${b.tag}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 42 7\n");
    });

    test("a struct holding a string releases it", async () => {
        // The category comes from the type: a struct with an owning field is
        // owning, and there is no default copy operation to fall back on
        // (REWRITE-PLAN §4.1, §10).
        const result = await run(
            "struct-owning-field",
            `interface Named { name: string; id: i32; }

       export function main(): i32 {
         const a: Named = { name: "x" + "y", id: 1 };
         console.log(\`\${a.name} \${a.id}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("xy 1\n");
        expect(result.leaked).toBe(0);
    });
});

describe("what structs are not", () => {
    test("an optional field is rejected", async () => {
        // There is no `undefined` for it to be, and no space in the layout for it
        // not to be.
        await expectRejected(
            "struct-optional",
            `interface Loose { x?: i32; }

       export function main(): i32 {
         const a: Loose = { x: 1 };
         return 0;
       }\n`,
            "GF0002",
        );
    });

    test("an interface mixing a method and a data member", async () => {
        // An interface is a *shape* (data only, a struct) or a *contract* (methods
        // only, dispatched). One that is both would have to be a layout and a
        // dispatch table at once, so it is rejected rather than guessed at.
        const diagnostic = await expectRejected(
            "struct-method",
            `interface WithMethod { x: i32; go(): i32; }

       export function main(): i32 {
         const a: WithMethod = { x: 1, go: () => 1 };
         return 0;
       }\n`,
            "GF0002",
        );
        expect(diagnostic.message).toContain("both methods and the data member");
    });

    test("a missing field is tsc's business", async () => {
        const {result} = await compileSource(
            "struct-missing-field",
            `${POINT}
       export function main(): i32 {
         const p: Point = { x: 1 };
         return 0;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
    });
});

describe("struct edges", () => {
    test("an interface with no fields has no machine representation", async () => {
        // A zero-sized struct is a real design question — C++ gives it size 1 so
        // that two objects have different addresses, C forbids it outright — and
        // the compiler declines to answer it rather than picking silently.
        const diagnostic = await expectRejected(
            "struct-empty",
            `interface E { }

       export function main(): i32 {
         const e: E = { };
         return 0;
       }\n`,
            "GF0001",
        );
        expect(diagnostic.message).toContain("no fields");
    });

    test("a literal's field order does not have to match the declaration's", async () => {
        // Layout comes from the *declaration*; the literal is just a set of
        // initialisers. Reading `b` back proves the store went to the right slot.
        const result = await run(
            "struct-literal-order",
            `interface S { b: i32; a: i32; }

       export function main(): i32 {
         const s: S = { a: 1, b: 2 };
         return s.b * 10 + s.a;
       }\n`,
        );
        expect(result.exitCode).toBe(21);
    });

    test("a nested field is mutable through the outer value", async () => {
        const result = await run(
            "struct-nested-mutate",
            `interface In { a: i32; }
       interface Out { i: In; b: i32; }

       export function main(): i32 {
         const o: Out = { i: { a: 1 }, b: 2 };
         o.i.a = 5;
         return o.i.a * 10 + o.b;
       }\n`,
        );
        expect(result.exitCode).toBe(52);
    });

    test("assigning a struct to itself is not a self-destruction", async () => {
        // The copy-assignment corner every value-semantics language has to answer:
        // release-then-copy on the same storage reads freed memory.
        const result = await run(
            "struct-self-assign",
            `interface S { s: string; }

       export function main(): i32 {
         let s: S = { s: "a" + "b" };
         s = s;
         console.log(s.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("assigning an owning field from itself is not a self-destruction", async () => {
        // The same corner one projection down. The destination is `s.s` rather
        // than `s`, so a check that only compared whole locals would miss it —
        // which is why the overlap test is by local and not by place.
        const result = await run(
            "struct-field-self-assign",
            `interface S { s: string; t: string; }

       export function main(): i32 {
         let s: S = { s: "a" + "b", t: "c" + "d" };
         s.s = s.s;
         s.t = s.s;
         console.log(\`\${s.s} \${s.t}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab ab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("a field may be read straight off a returned temporary", async () => {
        const result = await run(
            "struct-temp-field",
            `interface S { a: i32; }
       function make(): S { return { a: 4 }; }

       export function main(): i32 {
         return make().a;
       }\n`,
        );
        expect(result.exitCode).toBe(4);
    });

    test("a `readonly` field is written by the literal and not afterwards", async () => {
        const result = await run(
            "struct-readonly",
            `interface S { readonly a: i32; }

       export function main(): i32 {
         const s: S = { a: 3 };
         return s.a;
       }\n`,
        );
        expect(result.exitCode).toBe(3);

        const {result: bad} = await compileSource(
            "struct-readonly-write",
            `interface S { readonly a: i32; }

       export function main(): i32 {
         const s: S = { a: 3 };
         s.a = 4;
         return s.a;
       }\n`,
        );
        expect(bad.ok).toBe(false);
        expect(errorCodes(bad).some((code) => code.startsWith("TS"))).toBe(true);
    });

    test("a `boolean` field sits beside an integer one", async () => {
        const result = await run(
            "struct-bool-field",
            `interface S { flag: boolean; n: i32; }

       export function main(): i32 {
         const s: S = { flag: true, n: 7 };
         if (s.flag) { return s.n; }
         return 0;
       }\n`,
        );
        expect(result.exitCode).toBe(7);
    });

    test("an interface may extend another, and the fields flatten", async () => {
        const result = await run(
            "struct-extends",
            `interface A { a: i32; }
       interface B extends A { b: i32; }

       export function main(): i32 {
         const v: B = { a: 1, b: 2 };
         return v.a * 10 + v.b;
       }\n`,
        );
        expect(result.exitCode).toBe(12);
    });

    test("copying a struct with an owning field copies the buffer too", async () => {
        const result = await run(
            "struct-owning-copy",
            `interface S { s: string; }

       export function main(): i32 {
         const a: S = { s: "x" + "y" };
         const b: S = a;
         console.log(a.s + b.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("xyxy\n");
        expect(result.leaked).toBe(0);
    });
});
