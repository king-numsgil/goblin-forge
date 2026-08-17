/**
 * The type checker, retained across builds.
 *
 * REWRITE-PLAN §2 and §3: tsc is the type checker and its verdict is final —
 * there is no second frontend, and Rust never sees a `ts.Type`. What changes
 * from v1 is that the `ts.Program` lives in a JavaScript object held across
 * calls rather than in a subprocess, because retrofitting incrementality into a
 * one-shot pipeline is expensive and `watch` is coming.
 */

import { globalDeclarations } from "@goblin-forge/runtime/paths";
import ts from "typescript";

import type { Diagnostic } from "./diagnostics.ts";
import { fromTsDiagnostic, loadConfig, type LoadedConfig } from "./tsconfig.ts";

export interface CheckerOptions {
    /** Absolute or relative path to the project's tsconfig. */
    readonly tsconfig: string;
    /** Extra root files, beyond what the tsconfig names. Usually the entry. */
    readonly rootNames?: readonly string[];
}

export interface CheckResult {
    readonly program: ts.Program;
    readonly checker: ts.TypeChecker;
    readonly config: LoadedConfig;
    /** Everything tsc and the config validation had to say. */
    readonly diagnostics: readonly Diagnostic[];
}

/**
 * Holds a `ts.Program` and rebuilds it incrementally.
 *
 * Reusing the old program as the "old program" argument to `createProgram` is
 * what makes a rebuild proportional to what changed rather than to the size of
 * the project. It costs nothing to do from the start and is awkward to add
 * later, which is the whole argument for doing it now — `watch` mode ships
 * later, but the shape it needs is here already.
 */
export class Checker {
    #program: ts.Program | undefined;
    #config: LoadedConfig | undefined;
    readonly #options: CheckerOptions;
    readonly #host: ts.CompilerHost;

    constructor(options: CheckerOptions) {
        this.#options = options;
        this.#config = loadConfig(options.tsconfig);
        this.#host = ts.createCompilerHost(this.#config.options, true);
    }

    /**
     * Build (or rebuild) the program and collect every diagnostic.
     *
     * Syntactic errors are reported without also reporting the semantic errors
     * that follow from them, because a missing brace produces a hundred type
     * errors that all say the same thing.
     */
    check(): CheckResult {
        const config = this.#config ?? loadConfig(this.#options.tsconfig);
        this.#config = config;

        const rootNames = rootsFor(config, this.#options.rootNames ?? []);
        const program = ts.createProgram({
            rootNames,
            options: config.options,
            host: this.#host,
            // Spread rather than pass `undefined`: with `exactOptionalPropertyTypes`
            // an absent optional property and one explicitly set to `undefined` are
            // different things, and tsc's own signature wants the former.
            ...(this.#program !== undefined ? {oldProgram: this.#program} : {}),
        });
        this.#program = program;

        const diagnostics: Diagnostic[] = [...config.diagnostics];
        diagnostics.push(...program.getOptionsDiagnostics().map(fromTsDiagnostic));
        diagnostics.push(...program.getGlobalDiagnostics().map(fromTsDiagnostic));

        const syntactic = program.getSyntacticDiagnostics();
        diagnostics.push(...syntactic.map(fromTsDiagnostic));
        if (syntactic.length === 0) {
            diagnostics.push(...program.getSemanticDiagnostics().map(fromTsDiagnostic));
        }

        return {
            program,
            checker: program.getTypeChecker(),
            config,
            diagnostics,
        };
    }

    /** Drop the cached config so the next {@link check} re-reads it from disk. */
    invalidateConfig(): void {
        this.#config = undefined;
    }
}

/**
 * The root files of the program.
 *
 * The ambient prelude is added whether or not the project's tsconfig names it,
 * because a program without it does not type-check at all. Whether the project
 * *also* names it matters for a different reason — see
 * {@link checkPreludeIsVisibleToEditors}.
 */
function rootsFor(config: LoadedConfig, extra: readonly string[]): string[] {
    const roots = new Set<string>([globalDeclarations(), ...config.fileNames, ...extra]);
    return [...roots];
}

/**
 * Warn when the project's tsconfig does not name the ambient prelude.
 *
 * The compiler adds it regardless, so the build works either way. The editor
 * does not: tsserver reads the tsconfig and nothing else, so a project that
 * omits the prelude gets red underlines under `i32` and `console` while the
 * compiler happily accepts the file. An editor that disagrees with the compiler
 * is worse than no editor support, and the whole reason tsc is the type checker
 * is that the user sees its verdict while typing.
 */
export function checkPreludeIsVisibleToEditors(config: LoadedConfig): Diagnostic[] {
    const named = config.fileNames.some(
        (file) => normalise(file) === normalise(globalDeclarations()),
    );
    if (named) {
        return [];
    }

    return [
        {
            severity: "warning",
            code: "GF0003",
            source: "goblin",
            message:
                "this tsconfig does not name the ambient prelude, so your editor is " +
                "type-checking against a different language than the compiler is. Add " +
                "\"@goblin-forge/runtime/global.d.ts\" to `files`.",
            location: {file: config.path, line: 1, column: 1, length: 1},
        },
    ];
}

function normalise(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase();
}
