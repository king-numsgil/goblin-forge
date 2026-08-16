/**
 * `null` — the value, not the type.
 *
 * The type half has worked for a while: `Pointer<T> | null` erases to the same
 * machine word as `Pointer<T>`, and `p === null` is a comparison against zero.
 * Writing the word was the half that was missing, and every C binding needs it
 * — `SDL_RenderTexture(r, t, NULL, NULL)` has no other spelling.
 *
 * Nullability never reaches the MIR. There is no option type, no tag and no
 * second representation: `null` is `Const::Null`, a machine word of zero, and
 * which types may hold one is the whole of the rule. tsc does the rest, and it
 * is tsc that makes you check before you use.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("null is a value", () => {
  test("as a binding, an argument and a return", async () => {
    const result = await run(
      "null-values",
      `declare class SDL_Window { private _opaque: never }

       function accepts(p: Pointer<i32> | null): i32 { return p === null ? 1 : 0; }
       function nothing(): Pointer<SDL_Window> | null { return null; }

       export function main(): i32 {
         const p: Pointer<i32> | null = null;
         const s: CString | null = null;
         let total: i32 = 0;

         if (p === null) { total = total + 1; }
         if (s === null) { total = total + 2; }
         total = total + accepts(null) * 4;
         if (nothing() === null) { total = total + 8; }

         // And the non-null side still passes, with no conversion written.
         const real = alloc<i32>();
         total = total + accepts(real) * 16;
         real.free();

         console.log(\`\${total}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("15\n");
    expect(result.leaked).toBe(0);
  });

  test("in a struct field, and read back", async () => {
    const result = await run(
      "null-field",
      `interface Node { next: Pointer<u8> | null; value: i32; }

       export function main(): i32 {
         const head: Node = { next: null, value: 42 };
         return head.next === null ? head.value : 0;
       }\n`,
    );
    expect(result.exitCode).toBe(42);
    expect(result.leaked).toBe(0);
  });

  // That the word really is C's NULL rather than a sentinel this compiler
  // agrees with itself about is checked where it can only be checked: against a
  // C compiler, in `tests/libraries.test.ts`.

  test("`null` needs something to be the null of", async () => {
    // The same shape as a numeric literal with no context, and a distinct
    // message: `null` has no type at all rather than no width.
    const diagnostic = await expectRejected(
      "null-bare",
      `export function main(): i32 {
         const x = null;
         return 0;
       }\n`,
      "GF0161",
    );
    expect(diagnostic.message).toContain("null");
  });
});

describe("the types that have no null", () => {
  // An owning handle is one machine word too, and a zero one would reach the
  // drop pass at the end of its scope and be released like any other. That is
  // the whole reason the set is closed rather than "anything one word wide".
  test("`string` and `T[]` own their buffer, so they have none", async () => {
    for (const [name, source] of [
      ["string", "const s: string | null = null;"],
      ["array", "const xs: i32[] | null = null;"],
    ] as const) {
      const diagnostic = await expectRejected(
        `null-owning-${name}`,
        `export function main(): i32 {
           ${source}
           return 0;
         }\n`,
        "GF0237",
      );
      expect(diagnostic.message).toContain("owns its buffer");
    }
  });

  test("a `Reference<T>` has none either, and `tryCast` is why", async () => {
    // A reference is bound once and read through without asking. The nullable
    // one exists — `tryCast` returns it — but it is produced rather than
    // written, and its result is checked before it is used.
    const diagnostic = await expectRejected(
      "null-reference",
      `class Box { v: i32 = 1; }

       export function main(): i32 {
         const r: Reference<Box> | null = null;
         return 0;
       }\n`,
      "GF0237",
    );
    expect(diagnostic.message).toContain("tryCast");
  });
});
