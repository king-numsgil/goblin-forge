/**
 * Building the runtime static library, on demand.
 *
 * The runtime is compiled for the *user's* target, not the compiler's host, so
 * it cannot be a prebuilt artefact shipped beside the addon the way the backend
 * is. It is built with cargo the first time a program needs it, and cached for
 * the rest of the process.
 *
 * The system libraries it needs come from `--print native-static-libs` rather
 * than from a hardcoded list, which is the one detail here worth insisting on:
 * a hardcoded list is right on the day it is written and rots at the next
 * toolchain bump, and the failure is an unresolved symbol from inside the Rust
 * standard library that means nothing to whoever hits it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runtimeCrate } from "./paths.ts";

/**
 * What to ask the optimiser for, in the optimiser's own vocabulary.
 *
 * Declared here rather than in `forge` because the runtime build needs it and
 * `forge` already depends on this package — one definition, and the arrow only
 * points one way. `forge` re-exports it as part of its public API.
 */
export type OptLevel = "O0" | "O1" | "O2" | "O3" | "Os" | "Oz";

/** What cargo calls the same thing. */
const CARGO_OPT_LEVEL: Readonly<Record<OptLevel, string>> = {
    O0: "0",
    O1: "1",
    O2: "2",
    O3: "3",
    Os: "s",
    Oz: "z",
};

export interface RuntimeBuild {
    /** Absolute path to the static library. */
    readonly library: string;
    /** System libraries the linker needs, in the platform's spelling. */
    readonly systemLibs: readonly string[];
    /**
     * The runtime as a shared library, for `runtime: "shared"`.
     *
     * Two paths because Windows needs two: a DLL cannot be linked against
     * directly, so the linker is given an import stub and the loader is given
     * the DLL. On ELF and Mach-O both are the same file, and saying so here
     * keeps the asymmetry in one place instead of at every use.
     */
    readonly shared?: SharedRuntime;
}

export interface SharedRuntime {
    /** What the linker is given. */
    readonly link: string;
    /** What has to sit beside the executable when it runs. */
    readonly image: string;
}

const cache = new Map<string, RuntimeBuild>();

/**
 * The crate directory.
 *
 * A function because a single-file executable extracts its embedded copy on
 * first use, so the answer is not known when this module is evaluated.
 */
export const RUNTIME_CRATE = (): string => runtimeCrate();

/**
 * Build the runtime for `target` at `optLevel`, or the host when omitted.
 *
 * Cached per target **and level** for the life of the process. Both, because
 * the artefact is per both: keying on the target alone would hand the second
 * caller the first caller's library, at whatever level that one asked for, and
 * a program linked against a runtime built at the wrong level is not something
 * anything downstream can notice.
 *
 * cargo is itself incremental, so a cold cache in a new process is still fast —
 * this cache is here to avoid paying cargo's own startup on every one of a few
 * hundred test compiles.
 */
export function buildRuntime(target?: string, optLevel: OptLevel = "O2"): RuntimeBuild {
    const key = `${target ?? "<host>"}|${optLevel}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
        return cached;
    }

    // `--release` stays whatever the level is, and is not a contradiction: the
    // profile carries `lto` and `panic = "abort"` as well as an optimisation
    // level, and those two are properties of *how this crate is built at all*
    // rather than of how hard it is optimised. Only the level is overridden.
    const args = ["rustc", "--release", "--quiet"];
    // A directory per level, which is the part that cannot be skipped. cargo
    // writes every profile's output to `target/release`, so two levels would be
    // the same path — the second build would overwrite the first, and the first
    // caller's cached path would quietly start naming the other one's library.
    args.push("--target-dir", targetDir(optLevel));
    if (target !== undefined) {
        args.push("--target", target);
    }
    // The same baseline the compiler itself targets (DECISIONS §17's
    // amendment). Without this the runtime — which already goes through LLVM —
    // is built at the x86-64 baseline while the code calling it is built for
    // `x86-64-v3`, so `gf_string_concat` and friends are the one part of a
    // program compiled for a 2003 CPU.
    //
    // rustc spells it `-C target-cpu`; clang spells the same value `-march`,
    // and `llc` spells it `-mcpu`. Getting the spelling wrong is an error
    // rather than a silent fallback, which is the one merciful thing about it.
    args.push("--", "-C", "target-cpu=x86-64-v3");
    // `--print native-static-libs` reports what a staticlib needs on stderr, as
    // part of an ordinary build, so this is not a second compilation.
    args.push("--print", "native-static-libs");

    const result = spawnSync("cargo", args, {
        cwd: RUNTIME_CRATE(),
        encoding: "utf8",
        shell: process.platform === "win32",
        // The profile's level, overridden for this build. An environment
        // variable rather than `-C opt-level` after the `--`, because those
        // flags reach the *final* crate only: mimalloc, libc and libm would
        // stay at the profile's `3` while the runtime alone moved, which makes
        // `Oz` a claim about one of four things in the library.
        env: {...process.env, CARGO_PROFILE_RELEASE_OPT_LEVEL: CARGO_OPT_LEVEL[optLevel]},
    });

    if (result.error) {
        throw new Error(
            `could not run cargo to build the Goblin runtime: ${result.error.message}`,
        );
    }
    if (result.status !== 0) {
        throw new Error(
            `building the Goblin runtime failed:\n${result.stderr ?? ""}${result.stdout ?? ""}`,
        );
    }

    const library = locateLibrary(target, optLevel);
    if (library === undefined) {
        throw new Error(
            `the Goblin runtime built, but its static library was not where it was ` +
            `expected under ${targetDir(optLevel)}`,
        );
    }

    const shared = locateShared(target, optLevel);
    const build: RuntimeBuild = {
        library,
        systemLibs: parseNativeStaticLibs(result.stderr ?? ""),
        ...(shared !== undefined ? {shared} : {}),
    };
    cache.set(key, build);
    return build;
}

/**
 * Where cargo is told to put this level's artefacts.
 *
 * Under `target/` so that `cargo clean` still reaches it, and one level down so
 * that two levels are two directories. Nesting a target directory inside the
 * default one is not something cargo minds.
 */
function targetDir(optLevel: OptLevel): string {
    return join(RUNTIME_CRATE(), "target", `opt-${optLevel}`);
}

function releaseDir(target: string | undefined, optLevel: OptLevel): string {
    return join(targetDir(optLevel), ...(target ? [target] : []), "release");
}

function locateLibrary(target: string | undefined, optLevel: OptLevel): string | undefined {
    const base = releaseDir(target, optLevel);
    for (const name of ["goblin_runtime.lib", "libgoblin_runtime.a"]) {
        const candidate = join(base, name);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * The shared runtime, when the crate produced one.
 *
 * Both crate types come out of a single build — the manifest asks for
 * `["staticlib", "cdylib"]` — so this is a lookup rather than a second
 * compilation. It is *optional* on purpose: a `static-lib` never needs it, and
 * a target whose toolchain cannot produce a cdylib should fail when someone
 * asks for one rather than at every build.
 *
 * The import library is `goblin_runtime.dll.lib`, which is deliberately not the
 * staticlib's `goblin_runtime.lib`. The two sit in the same directory and only
 * the `.dll` in the middle tells them apart, so picking the wrong one links a
 * whole second copy of the runtime into a program that meant to share one.
 */
function locateShared(target: string | undefined, optLevel: OptLevel): SharedRuntime | undefined {
    const base = releaseDir(target, optLevel);
    for (const [image, link] of [
        ["goblin_runtime.dll", "goblin_runtime.dll.lib"],
        ["libgoblin_runtime.so", "libgoblin_runtime.so"],
        ["libgoblin_runtime.dylib", "libgoblin_runtime.dylib"],
    ] as const) {
        const imagePath = join(base, image);
        const linkPath = join(base, link);
        if (existsSync(imagePath) && existsSync(linkPath)) {
            return {link: linkPath, image: imagePath};
        }
    }
    return undefined;
}

/**
 * Pull the library list out of rustc's report.
 *
 * The line looks like `native-static-libs: kernel32.lib ws2_32.lib …`, and
 * rustc prints it with a `note:` prefix on some versions and without on others,
 * so the marker is matched rather than the whole line.
 */
export function parseNativeStaticLibs(stderr: string): string[] {
    const marker = "native-static-libs:";
    const at = stderr.lastIndexOf(marker);
    if (at === -1) {
        return [];
    }
    const line = stderr.slice(at + marker.length).split(/\r?\n/, 1)[0] ?? "";
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of line.trim().split(/\s+/)) {
        if (entry.length === 0 || seen.has(entry)) {
            continue;
        }
        seen.add(entry);
        out.push(entry);
    }
    return out;
}
