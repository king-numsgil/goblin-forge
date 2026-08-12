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
    const { result } = await compileSource(
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
