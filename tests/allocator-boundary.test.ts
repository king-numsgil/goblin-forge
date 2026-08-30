/**
 * Sharing the heap with a C library, at every optimisation level.
 *
 * `LINKING.md`'s "Sharing the heap with a library that lets you" is the
 * feature: a C library that takes allocator callbacks —
 * `SDL_SetMemoryFunctions(mi_malloc, mi_calloc, mi_realloc, mi_free)` — can be
 * given ours, and then one heap serves both sides and a buffer allocated by
 * either can be freed by the other.
 *
 * This exists because that worked at `O0`, `O2` and `O3` and **crashed at
 * `O1`, `Os` and `Oz`** with an access violation, and nothing in the suite
 * noticed. Two things hid it:
 *
 * * the suite compiles at `O0` (`HARNESS_OPT_LEVEL`), so the broken levels
 *   were never built at all; and
 * * a Goblin program that allocates heavily is *fine* at every level. The
 *   allocations have to arrive through the exported `gf_mi_*` trampolines,
 *   from a caller that is not us, before it fails — so no amount of testing
 *   the language would have found it.
 *
 * The cause was **MSVC 14.43.34808 miscompiling mimalloc at `/O1`**, which
 * levels 1, s and z all reach through `cc`. It was read at first as mimalloc
 * being broken at `/O1` and answered with a pin to `-O2`; holding the source
 * and flags fixed and moving one thing at a time said otherwise — C against
 * C++ made no difference, mimalloc 3.3.2 against 3.5.0 made no difference, and
 * 14.38.33130 against 14.43.34808 made all of it. The pin is gone and C
 * dependencies are built with clang on MSVC instead, so these six levels now
 * genuinely reach the allocator. DECISIONS §28.
 *
 * So the assertion that matters is not "it compiles" — it is that a real C
 * caller can allocate through our allocator, *touch what it gets back*, and
 * hand it back, at every level the compiler offers.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compileSource, runBinary, scratchPath } from "./harness.ts";

/**
 * A C library that keeps allocator callbacks and uses them.
 *
 * It **touches the first and last byte** of every block, which is the whole
 * point: a pointer into memory that was never committed is only a crash if
 * something reads or writes it, and returning one is exactly the failure this
 * file is about.
 */
const HOST_C = `#include <stddef.h>

typedef void *(*alloc_fn)(size_t);
typedef void *(*calloc_fn)(size_t, size_t);
typedef void (*free_fn)(void *);

static alloc_fn g_alloc;
static calloc_fn g_calloc;
static free_fn g_free;

void host_set_allocators(alloc_fn a, calloc_fn c, free_fn f) {
    g_alloc = a;
    g_calloc = c;
    g_free = f;
}

static int touch(void *p, size_t size) {
    if (p == NULL) { return 1; }
    ((unsigned char *) p)[0] = 1;
    ((unsigned char *) p)[size - 1] = 2;
    return 0;
}

int host_churn(int rounds) {
    size_t sizes[7] = { 8, 64, 512, 4096, 65536, 1048576, 4194304 };
    for (int r = 0; r < rounds; r += 1) {
        void *held[7];
        for (int i = 0; i < 7; i += 1) {
            held[i] = (i % 2 == 0) ? g_alloc(sizes[i]) : g_calloc(1, sizes[i]);
            if (touch(held[i], sizes[i]) != 0) { return i + 1; }
        }
        for (int i = 0; i < 7; i += 1) {
            g_free(held[i]);
        }
    }
    return 0;
}
`;

const PROGRAM = `import { mi_malloc, mi_calloc, mi_free } from "std/alloc";

declare function host_set_allocators(
    a: (size: usize) => Pointer<unknown> | null,
    c: (count: usize, size: usize) => Pointer<unknown> | null,
    f: (mem: Pointer<unknown> | null) => void,
): void;
declare function host_churn(rounds: i32): i32;

export function main(): i32 {
    host_set_allocators(mi_malloc, mi_calloc, mi_free);
    const failedAt = host_churn(20);
    console.log(failedAt === 0 ? "churn ok" : "churn failed");
    return failedAt;
}
`;

/** Build the C library once, and skip the suite if there is no `ar` to do it. */
function hostLibrary(): string | undefined {
    const dir = scratchPath("allocator-host");
    mkdirSync(dir, {recursive: true});
    const source = join(dir, "host.c");
    writeFileSync(source, HOST_C, "utf8");
    const object = join(dir, "host.o");
    const compiled = spawnSync(
        process.env["GOBLIN_CLANG"] ?? "clang",
        ["-c", source, "-o", object, "-O2"],
        {encoding: "utf8"},
    );
    if (compiled.status !== 0) {
        return undefined;
    }
    const archive = join(dir, process.platform === "win32" ? "host.lib" : "libhost.a");
    for (const tool of ["llvm-ar", "ar"]) {
        if (spawnSync(tool, ["rcs", archive, object], {encoding: "utf8"}).status === 0) {
            return archive;
        }
    }
    return undefined;
}

const LEVELS = ["O0", "O1", "O2", "O3", "Os", "Oz"] as const;

describe("a C library allocating through our allocator", () => {
    const archive = hostLibrary();

    for (const optLevel of LEVELS) {
        test(`at ${optLevel}`, async () => {
            // `clang` is checked before the type-check (`GF0006`), so a missing
            // one is not something this can reach; a missing `ar` is, and it is
            // not this file's business to fail over.
            if (archive === undefined) {
                return;
            }
            const {result} = await compileSource(`alloc-boundary-${optLevel}`, PROGRAM, {
                optLevel,
                nativeLibs: [archive],
            });
            expect(result.ok).toBe(true);

            // `runBinary` is what asserts the interesting part: a crash inside
            // the allocator produces no live-allocation report, and a missing
            // report is a failure rather than a zero.
            const ran = runBinary(`alloc-boundary-${optLevel}`, result.output!);
            expect(ran.stdout).toBe("churn ok\n");
            expect(ran.exitCode).toBe(0);
            expect(ran.leaked).toBe(0);
        }, 300_000);
    }
});
