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
import { dirname, join } from "node:path";

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
 * The arguments cargo is given, quoted for the shell Windows runs them under.
 *
 * `shell: true` is needed for cargo on Windows — some installs arrive as a
 * shim rather than a `.exe` — and Node implements it by joining the command
 * and its arguments with spaces and **no quoting**. Any argument with a space
 * in it is then split in two, and the callee sees half of it plus a stray
 * positional. The packaged CLI caches the runtime crate under
 * `%LOCALAPPDATA%`, so a username with a space in it puts one in
 * `--target-dir`'s path: every build on that machine, for every program,
 * failed as "building the Goblin runtime failed" until the argument was
 * quoted. `cmd`'s `/s /c` handling keeps the inner quotes intact, and a path
 * cannot contain a quote to break them.
 *
 * Only applied where the shell is actually in use, which is Windows alone;
 * elsewhere the arguments travel as an argv and quoting would *become* the
 * bug.
 */
const forShell = (args: readonly string[]): string[] =>
    process.platform === "win32"
        ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
        : [...args];

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

    const result = spawnSync("cargo", forShell(args), {
        cwd: RUNTIME_CRATE(),
        encoding: "utf8",
        shell: process.platform === "win32",
        // The profile's level, overridden for this build. An environment
        // variable rather than `-C opt-level` after the `--`, because those
        // flags reach the *final* crate only: mimalloc, libc and libm would
        // stay at the profile's `3` while the runtime alone moved, which makes
        // `Oz` a claim about one of four things in the library.
        env: {
            ...process.env,
            CARGO_PROFILE_RELEASE_OPT_LEVEL: CARGO_OPT_LEVEL[optLevel],
            ...cToolchain(target ?? hostTarget()),
        },
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
 * What C dependencies are compiled with, for an MSVC target: clang, not `cl`.
 *
 * **MSVC 14.43.34808 miscompiles mimalloc at `/O1`.** `cc` turns cargo's
 * `OPT_LEVEL` into a flag for the C it builds, and on MSVC levels `1`, `s` and
 * `z` all become `/O1`. Built that way by that compiler, mimalloc hands out
 * overlapping blocks — four allocations of four different sizes come back in
 * one page, on top of the arena metadata — and the access violation lands a
 * moment later inside its own bitmap search. 14.38.33130 is clean at `/O1`,
 * both are clean at `/O2`, and clang is clean at every level, which is what
 * makes this a compiler defect rather than a property of `/O1`.
 *
 * The measurement that settled it held mimalloc's source and every flag fixed
 * and moved one thing at a time: C against C++ (no difference), 3.3.2 against
 * 3.5.0 (no difference), toolset against toolset (the difference). DECISIONS
 * §28 is the reasoning; `tests/allocator-boundary.test.ts` is the assertion.
 *
 * So the allocator is no longer pinned to `-O2` — `optLevel` now reaches it
 * honestly — and the reason to trust clang with it is the reason the backend
 * already trusts clang with every object it emits. It is not a new dependency:
 * `packages/forge/src/toolchain.ts` already requires clang before the
 * type-check, and `clang-cl` is the same binary under another name.
 *
 * Set per *target triple* rather than as a bare `CC`, so that `cc` decides
 * whether this applies by asking the question it was going to ask anyway. The
 * question is not "is this Windows" — MinGW is `windows` too, and wants the
 * GNU driver rather than this one.
 *
 * An override already in the environment is left alone. `CC_<triple>` is the
 * documented way to name a C compiler, and a build that was told which one to
 * use should not be argued with.
 */
function cToolchain(triple: string | undefined): Record<string, string> {
    if (triple === undefined || !triple.endsWith("-msvc")) {
        return {};
    }

    const clang = msvcClang();
    const suffix = triple.replaceAll("-", "_");
    const env: Record<string, string> = {};
    for (const [name, value] of [
        [`CC_${suffix}`, clang],
        [`CXX_${suffix}`, clang],
        // mimalloc's C++ path has a `try` in `alloc.c`, and clang refuses one
        // with exceptions disabled. `cl` accepts it — with warning C4530, and
        // unspecified behaviour if it ever throws — which is how a library
        // built without `/EHsc` for years looked fine.
        [`CXXFLAGS_${suffix}`, "-EHsc"],
    ] as const) {
        if (process.env[name] === undefined) {
            env[name] = value;
        }
    }
    return env;
}

/**
 * clang, in the driver mode that speaks MSVC's command line.
 *
 * `clang-cl` rather than `clang --driver-mode=cl`, because `cc` picks the
 * command-line dialect from the *name* of the program it was handed: a `clang`
 * carrying a cl-mode flag is still given `-o` and `-c` in gcc's spelling, and
 * the failure is a page of "unknown argument" rather than anything pointing
 * here.
 *
 * Beside `GOBLIN_CLANG` when that names a path, because a machine with two
 * LLVMs should use the one it was told about rather than whichever came first
 * on `PATH`. Otherwise the bare name, which is where the toolchain check looked.
 */
export function msvcClang(): string {
    const named = process.env["GOBLIN_CLANG"];
    if (named === undefined || !(named.includes("/") || named.includes("\\"))) {
        return "clang-cl";
    }
    for (const name of ["clang-cl.exe", "clang-cl"]) {
        const beside = join(dirname(named), name);
        if (existsSync(beside)) {
            return beside;
        }
    }
    return "clang-cl";
}

/**
 * The host's own target triple, as rustc names it.
 *
 * Needed only when no target was asked for, since that is the one case where
 * the triple is implied rather than given. Asked of rustc rather than inferred
 * from `process.platform`, which cannot tell MSVC from MinGW — the distinction
 * the whole of [`cToolchain`] turns on.
 *
 * Cached for the process, including the failure: this sits on a path that is
 * about to run cargo, so one short subprocess is affordable and two are waste.
 * A rustc that cannot be asked leaves the C toolchain alone, which is the
 * behaviour every release before this one had.
 */
let hostTriple: string | undefined;
let hostAsked = false;

function hostTarget(): string | undefined {
    if (hostAsked) {
        return hostTriple;
    }
    hostAsked = true;
    const probe = spawnSync("rustc", ["-vV"], {
        encoding: "utf8",
        shell: process.platform === "win32",
    });
    const marker = "host: ";
    const line = (probe.stdout ?? "")
        .split(/\r?\n/)
        .find((candidate) => candidate.startsWith(marker));
    hostTriple = line?.slice(marker.length).trim() || undefined;
    return hostTriple;
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
