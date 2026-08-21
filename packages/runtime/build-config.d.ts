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
};
