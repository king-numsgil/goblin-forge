// What a build script exports, for the editor.
//
// This file is the compiler's own, written into `.goblin/` by `init` and
// refreshed by every build — the same arrangement as `global.d.ts`, and for the
// same reason: an editor that disagrees with the compiler is worse than no
// editor at all. A build script is the one file in a project that tsserver
// otherwise knows nothing about, because the project's tsconfig covers `src/`
// and a build script is not source.
//
// It declares a *global* type rather than exporting one, so a build script
// reaches it with a reference line and no import:
//
//   /// <reference path="./.goblin/build.d.ts" />
//
//   export default {
//       entry: "./src/main.ts",
//       output: "./bin/app",
//   } satisfies GoblinBuild;
//
// `satisfies` rather than a type annotation, deliberately: it checks the object
// against the type without widening it, so the literal keeps its exact types
// and an unknown key is an error rather than being quietly ignored.
//
// The compiler checks this file against its own `CompileOptions` — see
// `packages/cli/src/main.ts` — so a field added on one side and not the other
// fails `bun run typecheck` rather than drifting.

/**
 * The path to a system library, for {@link GoblinBuild.nativeLibs}.
 *
 * ```ts
 * export default {
 *     entry: "./src/main.ts",
 *     output: "./bin/game",
 *     nativeLibs: [systemLib("SDL3")],
 * } satisfies GoblinBuild;
 * ```
 *
 * The name is the library's own, without the platform's decoration: `SDL3`, not
 * `libSDL3.so` and not `SDL3.lib`. What it looks for and where is the platform's
 * business — `libSDL3.so` under Arch's `/usr/lib` and Debian's multiarch
 * directory, `libSDL3.dylib` under Homebrew's prefix, `SDL3.lib` under vcpkg or
 * whatever `LIB` names — and pkg-config and the C compiler driver are asked
 * before any of that is guessed at.
 *
 * A global rather than an import, because a build script has no `node_modules`
 * to import from: this executable *is* the toolchain. `goblin-forge` the
 * library exports the same function under the same name, for a build script
 * that calls `compile` itself.
 *
 * Throws when nothing matches, naming what it tried. `GOBLIN_LIB_PATH` — a
 * `PATH`-shaped list of directories — is the override that always works.
 */
declare function systemLib(
    name: string,
    options?: {
        /**
         * The pkg-config package name, when it is not the library's own.
         * SDL3's is `sdl3`; OpenSSL's library is `ssl` and its package is
         * `libssl`, which no rule would have guessed.
         */
        readonly pkgConfig?: string;

        /** Directories to look in before anywhere else. */
        readonly search?: readonly string[];

        /**
         * Which spelling wins where a machine has both. Defaults to `"shared"`,
         * because that is what a package manager installs.
         */
        readonly prefer?: "shared" | "static";
    },
): string;

/** What a build script's default export describes. */
declare type GoblinBuild = {
    /**
     * The entry module, and the only required field besides `output`.
     *
     * Resolved against the build script's own directory, not the working
     * directory — a build script that only works from the right `cwd` is a
     * build script that will be run from the wrong one.
     */
    readonly entry: string;

    /**
     * Where the artefact goes, without an extension.
     *
     * The platform's own is added: `.exe` on Windows, none elsewhere, `.lib` or
     * `.a` for a static library, `.dll` or `.so` for a shared one.
     */
    readonly output: string;

    /** What to build. Defaults to `"bin"`. */
    readonly type?: "bin" | "static-lib" | "shared-lib";

    /**
     * The project's tsconfig. Defaults to `tsconfig.json` beside the build
     * script, which is where every layout anybody actually writes puts it.
     */
    readonly tsconfig?: string;

    /**
     * What relative paths resolve against. Defaults to the build script's own
     * directory.
     */
    readonly root?: string;

    /** Optimisation level. Defaults to `"speed"`. */
    readonly optLevel?: "none" | "speed" | "size";

    /**
     * Target triple, such as `"x86_64-pc-windows-msvc"`. Defaults to the host.
     *
     * The compiler targets `x86-64-v3` — AVX2, FMA, BMI — and does not run on
     * anything older.
     */
    readonly target?: string;

    /**
     * Debug information: DWARF on ELF, CodeView on Windows. Defaults to `true`.
     *
     * Function granularity, so a backtrace names the right function and a
     * profile symbolizes. Stepping line by line does not work yet.
     */
    readonly debugInfo?: boolean;

    /** Runtime liveness checks. Defaults to `false`. */
    readonly checked?: boolean;

    /** Static libraries to link, each a path to a `.lib` or `.a`. */
    readonly nativeLibs?: readonly string[];

    /** Extra link manifests, for a platform that wants one. */
    readonly manifests?: readonly string[];

    /**
     * How the Goblin runtime is linked. Defaults to `"static"`.
     *
     * `"static"` puts the runtime inside the artefact and leaves one file to
     * ship. `"shared"` exists for the one case that cannot serve: **two Goblin
     * artefacts in one process**, a `shared-lib` loaded by a `bin`. Each would
     * otherwise carry its own heap and its own live-allocation counter, and a
     * `string` allocated on one side and released on the other is a cross-heap
     * free. The cost is a second file that has to stay beside the output.
     */
    readonly runtime?: "static" | "shared";

    /** Where objects and other intermediates go. Defaults to `build/`. */
    readonly outDir?: string;

    /** Extra artefacts to write beside the output. */
    readonly emit?: {
        /** The MIR, as text. What the backend was actually given. */
        readonly ir?: boolean;
        /** A C header for a library target, so C can call in. */
        readonly header?: boolean;
        /** The `.d.ts` a Goblin consumer of a library imports. */
        readonly declarations?: boolean;
    };

    /** Reuse the previous program where nothing changed. */
    readonly incremental?: boolean;

    /**
     * Panic inside the backend on an internal error rather than returning a
     * diagnostic.
     *
     * For debugging the compiler, not a program: a compiler crash must not be
     * able to read as a clean rejection.
     */
    readonly strictInternalErrors?: boolean;

    /**
     * What to run before the compiler, in order.
     *
     * A string is a command line, run by **Bun's own shell** rather than the
     * platform's — so `&&`, a pipe, a glob and `$VAR` mean the same thing on
     * every machine, and a step does not depend on which `sh` is installed. A
     * function is called inside the compiler's own process, for a step that is
     * a few lines of TypeScript rather than a program somebody already wrote.
     * A list of either runs one step at a time, in the order written.
     *
     * These run before the *typecheck*, not merely before the link, so a step
     * that writes a source file writes it in time to be checked. A step that
     * fails stops the build: nothing is compiled, and the exit code is 1.
     *
     * A command's working directory is the build script's own, like every
     * relative path here.
     */
    readonly before?:
        | string
        | (() => void | Promise<void>)
        | readonly (string | (() => void | Promise<void>))[];

    /**
     * What to run after a build that produced something, in order.
     *
     * Handed the absolute path of the artefact — as an argument to a function,
     * and as `$GOBLIN_OUTPUT` to a command. That is the one thing a post-build
     * step reliably wants and the one thing this config cannot spell:
     * {@link GoblinBuild.output} carries no extension, and which one gets added
     * is the target's business and the platform's.
     *
     * A build that failed does not run these — there is nothing to run them on.
     * A step that fails here leaves the artefact where it is, says so, and
     * exits 1: the file was built, but the build did not finish.
     */
    readonly after?:
        | string
        | ((output: string) => void | Promise<void>)
        | readonly (string | ((output: string) => void | Promise<void>))[];
};
