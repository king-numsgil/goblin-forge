/**
 * `runtime: "shared"` — one runtime for several Goblin artefacts.
 *
 * Static linking puts a copy of the runtime inside every artefact, which is the
 * right answer for one artefact and the wrong one for two. A `shared-lib`
 * loaded by a `bin` would otherwise carry its own mimalloc, its own live
 * allocation counter and its own `gf_string_free` — so a `string` allocated on
 * one side and released by the scope that holds it on the other is a free
 * against a heap that never allocated it.
 *
 * That configuration has never actually worked: before mimalloc the two copies
 * happened to share the CRT's heap and the corruption was silent, and a Windows
 * DLL exports only its own defines, so a consumer could not reach
 * `gf_string_free` at all. This is the fix, and the second test here is the
 * whole reason the option exists.
 *
 * The default is unchanged and stays `"static"`: one file to ship, nothing
 * beside it.
 */

import { copyFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { compileSource, runBinary } from "./harness.ts";

describe("a shared runtime", () => {
    test("a bin links against it, runs, and reports its allocations", async () => {
        const {result} = await compileSource(
            "shared-bin",
            `export function main(): i32 {
         const n: i32 = 41;
         const s: string = \`hello \${n + 1}\`;
         console.log(s);
         const p = alloc<i32>();
         p[0] = 7;
         const v: i32 = p[0];
         p.free();
         return v;
       }\n`,
            {runtime: "shared"},
        );
        expect(result.ok).toBe(true);

        // The runtime is no longer inside the binary, so the build has to say
        // where the other half went — this is the one build whose output path is
        // not the whole answer to "what do I ship?".
        expect(result.runtimeImage).toBeDefined();
        expect(existsSync(result.runtimeImage!)).toBe(true);
        expect(dirname(result.runtimeImage!)).toBe(dirname(result.output!));

        const run = runBinary("shared-bin", result.output!);
        expect(run.stdout).toBe("hello 42\n");
        expect(run.exitCode).toBe(7);
        // The counter lives in the shared runtime now. A zero here says the
        // reporter still runs and is still read, through one more indirection.
        expect(run.leaked).toBe(0);
    }, 120_000);

    test("a shared-lib and a bin share one heap and one counter", async () => {
        // The case the option exists for. `greet` allocates inside the DLL and
        // hands the string back; the binding in `main` owns it, so the *bin*
        // calls `gf_string_free` on memory the *library* allocated.
        //
        // Linked statically that is a free against the wrong heap. Linked
        // shared there is only one of everything, and the leak check below is
        // reading a single counter that both artefacts incremented — which is
        // also why it is allowed to be exactly zero rather than two reports
        // that happen to sum to it.
        const lib = await compileSource(
            "shared-lib-greeter",
            `export function greet(name: string): string { return \`hi \${name}\`; }\n`,
            {type: "shared-lib", runtime: "shared"},
        );
        expect(lib.result.ok).toBe(true);

        // Windows cannot link against a DLL directly; everywhere else the shared
        // object itself is what the linker is given.
        const linkAgainst = lib.result.importLibrary ?? lib.result.output!;

        const app = await compileSource(
            "shared-bin-consumer",
            `declare function greet(name: string): string;

       export function main(): i32 {
         const s: string = greet("goblin");
         console.log(s);
         return 0;
       }\n`,
            {runtime: "shared", nativeLibs: [linkAgainst]},
        );
        expect(app.result.ok).toBe(true);

        // The library beside the executable, where the loader looks. The shared
        // runtime is already there — the compiler put it there for both.
        const beside = join(dirname(app.result.output!), basename(lib.result.output!));
        copyFileSync(lib.result.output!, beside);

        const run = runBinary("shared-bin-consumer", app.result.output!);
        expect(run.stdout).toBe("hi goblin\n");
        expect(run.exitCode).toBe(0);
        expect(run.leaked).toBe(0);
    }, 120_000);

    test("the default is static, and stays one self-contained file", async () => {
        const {result} = await compileSource(
            "static-by-default",
            `export function main(): i32 { return 0; }\n`,
        );
        expect(result.ok).toBe(true);
        expect(result.runtimeImage).toBeUndefined();
    }, 120_000);
});
