/**
 * The allocator, under its own C name.
 *
 * Every Goblin program allocates through mimalloc — `new`, `alloc`, a `string`,
 * a `T[]` — and the prelude publishes that same allocator as eight ordinary
 * `extern "C"` declarations. They are the only names in the prelude that are
 * *not* intrinsics: nothing in the lowerer recognises `mi_malloc`, which is the
 * whole point, because a name nothing recognises can be called, passed and
 * stored like any other C function.
 *
 * That last part is the reason the surface exists. A C library that lets its
 * allocator be replaced wants function pointers, so `mi_malloc` has to work as
 * a *value* and not only as a call — which is what makes
 * `SDL_SetMemoryFunctions(mi_malloc, mi_calloc, mi_realloc, mi_free)` a line
 * someone can write.
 *
 * Blocks from here are outside the live-allocation counter on purpose: it
 * counts what the *runtime* handed out and is owed back, and these are handed
 * to whoever asked. Every test still asserts a clean report, which is what says
 * the two bookkeeping systems do not touch.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("mimalloc, by its C name", () => {
    test("a block round-trips through mi_malloc and mi_free", async () => {
        const result = await run(
            "mi-round-trip",
            `export function main(): i32 {
         const raw = mi_malloc(64);
         if (raw === null) { return 1; }
         const bytes = raw.reify<u8>();
         bytes[0] = 7;
         bytes[63] = 9;
         const sum: i32 = cast<i32>(bytes[0]) + cast<i32>(bytes[63]);
         mi_free(raw);
         return sum;
       }\n`,
        );
        expect(result.exitCode).toBe(16);
        expect(result.leaked).toBe(0);
    });

    test("mi_zalloc and mi_calloc hand back zeroed bytes", async () => {
        // Distinct from `mi_malloc`, whose bytes are whatever was there before —
        // so this is checked on a block big enough to have been recycled rather
        // than on a fresh page that would read zero either way.
        const result = await run(
            "mi-zeroed",
            `export function main(): i32 {
         const scratch = mi_malloc(256);
         if (scratch === null) { return 1; }
         const dirty = scratch.reify<u8>();
         let i: usize = 0;
         while (i < 256) { dirty[i] = 0xff; i = i + 1; }
         mi_free(scratch);

         const z = mi_zalloc(256);
         const c = mi_calloc(32, 8);
         if (z === null || c === null) { return 2; }
         let total: i32 = 0;
         const zb = z.reify<u8>();
         const cb = c.reify<u8>();
         let j: usize = 0;
         while (j < 256) {
           total = total + cast<i32>(zb[j]) + cast<i32>(cb[j]);
           j = j + 1;
         }
         mi_free(z);
         mi_free(c);
         return total;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("mi_realloc keeps the bytes that were already there", async () => {
        const result = await run(
            "mi-realloc",
            `export function main(): i32 {
         const first = mi_malloc(8);
         if (first === null) { return 1; }
         const before = first.reify<u8>();
         before[0] = 11;
         before[7] = 22;

         // Big enough that the block has to move, so this is testing the copy
         // rather than testing that mimalloc had slack in the size class.
         const grown = mi_realloc(first, 4096);
         if (grown === null) { mi_free(first); return 2; }
         const after = grown.reify<u8>();
         const kept: i32 = cast<i32>(after[0]) + cast<i32>(after[7]);
         mi_free(grown);
         return kept;
       }\n`,
        );
        expect(result.exitCode).toBe(33);
        expect(result.leaked).toBe(0);
    });

    test("mi_malloc_aligned lands on the boundary, and mi_free still takes it", async () => {
        // The property the whole free-side ABI rests on: an over-aligned block
        // goes back through the *same* one-argument free. Windows' own
        // `_aligned_malloc` needs `_aligned_free` and pairing them wrongly is
        // undefined; there is no second free here to pair wrongly.
        const result = await run(
            "mi-aligned",
            `export function main(): i32 {
         let misaligned: i32 = 0;
         let i: usize = 0;
         while (i < 8) {
           const p = mi_malloc_aligned(100, 64);
           if (p === null) { return 1; }
           if (p.address % 64 !== 0) { misaligned = misaligned + 1; }
           const q = mi_realloc_aligned(p, 200, 64);
           if (q === null) { mi_free(p); return 2; }
           if (q.address % 64 !== 0) { misaligned = misaligned + 1; }
           mi_free(q);
           i = i + 1;
         }
         return misaligned;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("mi_usable_size is at least what was asked for", async () => {
        const result = await run(
            "mi-usable-size",
            `export function main(): i32 {
         const p = mi_malloc(100);
         if (p === null) { return 1; }
         const usable = mi_usable_size(p);
         mi_free(p);
         if (usable < 100) { return 2; }
         // Null is nobody's block, and the answer is nought rather than a crash.
         if (mi_usable_size(null) !== 0) { return 3; }
         return 0;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("mi_free of null is a no-op, as it is in C", async () => {
        const result = await run(
            "mi-free-null",
            `export function main(): i32 {
         mi_free(null);
         console.log("survived");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("survived\n");
        expect(result.leaked).toBe(0);
    });

    test("the four are function pointers, which is what SDL wants", async () => {
        // The shape of `SDL_SetMemoryFunctions`, written in Goblin so the test
        // needs no SDL. What is being checked is that `mi_malloc` survives being
        // named rather than called: it has to reach `#functionValue` as an
        // ordinary extern and come out a code address.
        const result = await run(
            "mi-as-callbacks",
            `function install(
         m: (size: usize) => Pointer<unknown> | null,
         c: (count: usize, size: usize) => Pointer<unknown> | null,
         r: (mem: Pointer<unknown> | null, size: usize) => Pointer<unknown> | null,
         f: (mem: Pointer<unknown> | null) => void,
       ): i32 {
         const p = m(16);
         if (p === null) { return 1; }
         p.reify<u8>()[0] = 3;

         const grown = r(p, 4096);
         if (grown === null) { f(p); return 2; }
         const kept: i32 = cast<i32>(grown.reify<u8>()[0]);
         f(grown);

         const z = c(4, 8);
         if (z === null) { return 3; }
         const zb = z.reify<u8>();
         const clean: i32 = cast<i32>(zb[0]) + cast<i32>(zb[31]);
         f(z);

         return kept + clean;
       }

       export function main(): i32 {
         return install(mi_malloc, mi_calloc, mi_realloc, mi_free);
       }\n`,
        );
        expect(result.exitCode).toBe(3);
        expect(result.leaked).toBe(0);
    });

    test("a callback type that drops the `| null` is refused by tsc", async () => {
        // Refused, and refused by the *type checker* rather than by a rule of
        // this compiler's — which is why the prelude spells the SDL signature out
        // rather than leaving it to be guessed. A `malloc` that cannot fail is a
        // claim C does not make, and the mismatch is an ordinary assignability
        // failure once the four are ordinary declarations.
        const diagnostic = await expectRejected(
            "mi-callback-not-null",
            `function install(m: (size: usize) => Pointer<unknown>): usize {
         const p = m(8);
         return p.address;
       }

       export function main(): i32 {
         return cast<i32>(install(mi_malloc));
       }\n`,
            "TS2345",
        );
        expect(diagnostic.message).toContain("null");
    });

    test("the program's own allocations still balance beside them", async () => {
        // The two bookkeeping systems are separate: `LIVE` counts what the
        // runtime handed out, and a raw `mi_malloc` block is not that. A leak
        // here would mean the counter had started following blocks it does not
        // own.
        const result = await run(
            "mi-beside-owned",
            `class Rect { w: i32; h: i32; constructor(w: i32, h: i32) { this.w = w; this.h = h; } }

       export function main(): i32 {
         const raw = mi_malloc(32);
         if (raw === null) { return 1; }
         const r = alloc(Rect, 3, 4);
         const text = \`\${r.w * r.h}\`;
         console.log(text);
         r.free();
         mi_free(raw);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("12\n");
        expect(result.leaked).toBe(0);
    });
});
