/**
 * The files the compiler ships with, written out where they can be read.
 *
 * Three of the four are given to something that insists on a real path with a
 * real name: tsc reads the prelude, tsc resolves the tsconfig base, and cargo
 * builds the runtime crate. So they are embedded as *contents* and written to a
 * cache directory, rather than embedded as assets and read in place.
 *
 * The name is the reason. Bun's asset embedding renames what it embeds —
 * `global.d.ts` becomes `global.d-r4z2zczw.ts` — and that is not a declaration
 * file any more. tsc would parse the prelude as ordinary source, the lowerer
 * would stop skipping it, and every `declare function` in it would become an
 * `extern "C"` import of an intrinsic. Writing the files out keeps their names.
 *
 * The native addon is the exception and is embedded as an asset: nothing cares
 * what it is called, and Bun handles loading one out of the binary itself.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EMBEDDED } from "./embedded.generated.ts";

/** Where the compiler's own files ended up. */
export interface Materialised {
    readonly globalDeclarations: string;
    readonly tsconfigBase: string;
    readonly runtimeCrate: string;
}

/**
 * Write the embedded files into `root`, and say where they went.
 *
 * Rewritten on every run. They are a few kilobytes between them, and a stale
 * prelude that silently disagrees with the compiler reading it is a far worse
 * failure than a redundant write — the symptom would be a diagnostic about a
 * global that does exist.
 */
export function materialise(root: string): Materialised {
    const crate = join(root, "runtime-crate");
    mkdirSync(join(crate, "src"), {recursive: true});

    const write = (path: string, contents: string): string => {
        // Only when it differs: cargo rebuilds on mtime, so rewriting the crate
        // sources unconditionally would rebuild the runtime on every invocation.
        if (!same(path, contents)) {
            writeFileSync(path, contents, "utf8");
        }
        return path;
    };

    return {
        globalDeclarations: write(join(root, "global.d.ts"), EMBEDDED.globalDeclarations),
        tsconfigBase: write(join(root, "tsconfig.base.json"), EMBEDDED.tsconfigBase),
        runtimeCrate: (() => {
            write(join(crate, "Cargo.toml"), EMBEDDED.runtimeCargo);
            write(join(crate, "src", "lib.rs"), EMBEDDED.runtimeSource);
            return crate;
        })(),
    };
}

function same(path: string, contents: string): boolean {
    try {
        return readFileSync(path, "utf8") === contents;
    } catch {
        return false;
    }
}
