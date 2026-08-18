/**
 * The build API.
 *
 * REWRITE-PLAN §3, and its rules are the interesting part:
 *
 * * **`compile` resolves, it does not throw** — unless something outside the
 *   program's control failed, like a missing toolchain or an unreadable file. A
 *   program that does not compile is a *result*, not an exception.
 * * **Paths in, paths out.** Every path in the result is absolute, and every
 *   path in the options is resolved against the build script's directory rather
 *   than the working directory, because a build script that only works from the
 *   right cwd is a build script that will be run from the wrong one.
 * * **The `ts.Program` is retained**, so a rebuild is proportional to what
 *   changed. `watch` ships later; retrofitting incrementality into a one-shot
 *   pipeline does not.
 */

import {
    Backend,
    type BackendOptions,
    checkBindingsMatchAddon,
    encodeModule,
    outputExtension,
    printModule,
} from "@goblin-forge/backend";

import { Checker, checkPreludeIsVisibleToEditors, type Diagnostic, hasErrors } from "@goblin-forge/checker";

import { buildRuntime } from "@goblin-forge/runtime/build";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { elaborateDrops } from "./drop-elaboration.ts";
import { emitHeader, HeaderError, runtimeSymbols } from "./header.ts";
import { lower } from "./lower.ts";

export type OutputKind = "bin" | "static-lib" | "shared-lib";
export type OptLevel = "none" | "speed" | "size";

export interface CompileOptions {
    /** The entry module. Resolved against {@link CompileOptions.root}. */
    readonly entry: string;
    /** The project's tsconfig. Resolved against {@link CompileOptions.root}. */
    readonly tsconfig: string;

    /**
     * What every other relative path is resolved against.
     *
     * Defaults to the directory of the build script that called `compile`, not
     * the working directory.
     */
    readonly root?: string;

    readonly type?: OutputKind;
    /** Output path. The platform's extension for the target type is added. */
    readonly output: string;

    readonly nativeLibs?: readonly string[];
    readonly manifests?: readonly string[];

    /**
     * How the Goblin runtime is linked. Defaults to `"static"`.
     *
     * `"static"` is the self-contained answer and the right one for almost
     * everything: the runtime is inside the artefact and there is one file to
     * ship.
     *
     * `"shared"` exists for the one case static linking cannot serve — **two
     * Goblin artefacts in the same process**, a `shared-lib` loaded by a `bin`.
     * Each would otherwise carry its own runtime, and therefore its own heap,
     * its own live-allocation counter and its own copy of `gf_string_free`; a
     * `string` allocated on one side and released on the other is then a
     * cross-heap free. Linked shared, both artefacts import one runtime and
     * there is one of each.
     *
     * The cost is that the runtime is no longer inside the binary. It is copied
     * beside the output and has to stay there — `runtimeImage` in the result
     * says where it landed. This is `/MD` against `/MT`, and the trade is the
     * same one.
     */
    readonly runtime?: "static" | "shared";

    /** Target triple. Defaults to the host. */
    readonly target?: string;
    readonly optLevel?: OptLevel;
    /** Runtime liveness checks. */
    readonly checked?: boolean;
    readonly debugInfo?: boolean;

    /** Where objects and other intermediates go. */
    readonly outDir?: string;
    readonly emit?: {
        readonly ir?: boolean;
        readonly header?: boolean;
        readonly declarations?: boolean;
    };

    readonly incremental?: boolean;

    /**
     * Panic inside the backend on an internal error rather than returning a
     * diagnostic. REWRITE-PLAN §8: a compiler crash must not be able to read as
     * a clean rejection. The test harness turns this on.
     */
    readonly strictInternalErrors?: boolean;
}

export interface CompileResult {
    readonly ok: boolean;
    readonly diagnostics: readonly Diagnostic[];
    /** Absolute path of the artifact, when one was produced. */
    readonly output?: string;
    /** Absolute paths of every object file written. */
    readonly objects: readonly string[];
    /** The exact linker command, so a link failure can be reproduced by hand. */
    readonly linkCommand?: string;
    /** Where the MIR was written, when `emit.ir` asked for it. */
    readonly irPath?: string;
    /** Where the C header was written, for a library target. */
    readonly headerPath?: string;
    /**
     * The import library beside a Windows `shared-lib`.
     *
     * Windows has no equivalent of linking straight against a `.so`: a consumer
     * links this stub instead. Absent on every other platform, and absent for
     * every other target kind.
     */
    readonly importLibrary?: string;
    /**
     * The Goblin runtime archive a consumer of a `static-lib` must also link.
     *
     * A Goblin archive carries only its own objects, so that two of them in one
     * program do not each bring a copy of `gf_string_free`. That makes this the
     * consumer's job, and leaving it to be discovered from a linker error would
     * be unkind.
     */
    readonly runtimeLibrary?: string;
    /**
     * The shared runtime copied beside the output, for `runtime: "shared"`.
     *
     * It has to stay there: the artefact finds it by looking next to itself.
     * Reported rather than merely done, because "which files do I ship?" now
     * has two answers and only one of them is the output path.
     */
    readonly runtimeImage?: string;
}

/**
 * Compile a Goblin program.
 *
 * Holds nothing between calls. {@link Compiler} is the re-entrant version and
 * is what `watch` will use; this is the one-shot convenience over it.
 */
export async function compile(options: CompileOptions): Promise<CompileResult> {
    return new Compiler(options).build();
}

/**
 * A compiler with a retained `ts.Program`.
 *
 * Build twice and the second build reuses everything tsc did not have to redo.
 */
export class Compiler {
    readonly #options: CompileOptions;
    readonly #root: string;
    readonly #checker: Checker;
    readonly #backend: Backend;

    constructor(options: CompileOptions) {
        this.#options = options;
        this.#root = resolve(options.root ?? process.cwd());

        checkBindingsMatchAddon();

        this.#checker = new Checker({
            tsconfig: this.#resolve(options.tsconfig),
            rootNames: [this.#resolve(options.entry)],
        });

        const backendOptions: BackendOptions = {
            optLevel: options.optLevel ?? "speed",
            debugInfo: options.debugInfo ?? true,
            checked: options.checked ?? false,
            ...(options.target !== undefined ? {target: options.target} : {}),
            ...(options.strictInternalErrors !== undefined
                ? {strictInternalErrors: options.strictInternalErrors}
                : {}),
        };
        this.#backend = new Backend(backendOptions);
    }

    async build(): Promise<CompileResult> {
        const diagnostics: Diagnostic[] = [];

        // 1. tsc. Its verdict is final: nothing downstream runs if it says no.
        const checked = this.#checker.check();
        diagnostics.push(...checked.diagnostics);
        diagnostics.push(...checkPreludeIsVisibleToEditors(checked.config));
        if (hasErrors(diagnostics)) {
            return failed(diagnostics);
        }

        // 2. Lower the checked AST to MIR.
        const moduleName = basenameWithoutExtension(this.#resolve(this.#options.entry));
        const kind = this.#options.type ?? "bin";
        const lowered = lower(checked.program, checked.checker, moduleName, {
            requireMain: kind === "bin",
            root: this.#root,
            entry: this.#resolve(this.#options.entry),
        });
        diagnostics.push(...lowered.diagnostics);
        if (lowered.module === undefined || hasErrors(diagnostics)) {
            return failed(diagnostics);
        }

        // 2a. Place the drops. A pass over the finished CFG, from the
        // initialisedness of each local at each point — never spliced in by the
        // lowerer, and never derived from a scope-depth counter (REWRITE-PLAN §5.1).
        elaborateDrops(lowered.module);

        const outDir = this.#resolve(this.#options.outDir ?? "build");

        // 2b. `emit.ir` writes the MIR out. REWRITE-PLAN §9 asks for golden MIR on
        // a handful of programs, because drop placement is the thing most likely to
        // regress invisibly and a golden file makes a change to it visible in
        // review.
        let irPath: string | undefined;
        if (this.#options.emit?.ir === true) {
            irPath = join(outDir, `${moduleName}.mir`);
            mkdirSync(outDir, {recursive: true});
            writeFileSync(irPath, printModule(lowered.module), "utf8");
        }

        // 3. Across the boundary: one buffer, one call.
        const objectPath = join(outDir, `${moduleName}.o`);
        const artifact = this.#backend.compileModule(encodeModule(lowered.module), objectPath);
        diagnostics.push(...artifact.diagnostics.map(fromBackend));
        if (!artifact.ok || artifact.objectPath === undefined) {
            return {...failed(diagnostics), ...(irPath !== undefined ? {irPath} : {})};
        }

        // 4. A C header, for a library somebody else has to be able to call.
        let headerPath: string | undefined;
        if (kind !== "bin" && (this.#options.emit?.header ?? true)) {
            headerPath = join(outDir, `${moduleName}.h`);
            try {
                writeFileSync(
                    headerPath,
                    emitHeader(lowered.module, {
                        name: moduleName,
                        // `kind` is not `bin` here, and the two library kinds
                        // want opposite advice about linking the runtime.
                        kind: kind === "shared-lib" ? "shared-lib" : "static-lib",
                        runtime: this.#options.runtime ?? "static",
                    }),
                );
            } catch (error) {
                if (!(error instanceof HeaderError)) {
                    throw error;
                }
                // The ABI classifier is meant to reject anything with no C spelling
                // before this is asked, so the two disagreeing is a compiler bug.
                diagnostics.push({
                    severity: "error",
                    code: "GF9006",
                    source: "goblin",
                    message: `could not write a C header for \`${moduleName}\`: ${error.message}`,
                });
                return {...failed(diagnostics), objects: [artifact.objectPath]};
            }
        }

        // 5. Link, against the runtime and whatever it needs.
        //
        // A `static-lib` is *archived* rather than linked, and gets neither the
        // runtime nor any native library: an archive carries only its own objects,
        // so that two Goblin libraries in one program do not each bring a copy of
        // `gf_string_free`. Its consumer links the runtime once, at the executable
        // — which is why `runtimeLibrary` comes back in the result.
        const output = this.#outputPath(kind);
        const runtime = buildRuntime(this.#options.target);
        const selfContained = kind !== "static-lib";

        // `shared` links the import stub instead of the archive, so that this
        // artefact and any other one in the same process resolve `gf_*` to the
        // same module — one heap, one live-allocation counter. A `static-lib`
        // is archived rather than linked and gets neither, so the choice does
        // not reach it: its consumer picks, at the executable.
        const shared = this.#options.runtime === "shared" && selfContained;
        if (shared && runtime.shared === undefined) {
            diagnostics.push({
                severity: "error",
                code: "GF0005",
                source: "goblin",
                message:
                    `\`runtime: "shared"\` was asked for, but the runtime crate did not ` +
                    `produce a shared library for this target. Its manifest asks for ` +
                    `\`crate-type = ["staticlib", "cdylib"]\`; a target whose toolchain ` +
                    `cannot produce a cdylib can only be linked \`runtime: "static"\`.`,
            });
            return {...failed(diagnostics), objects: [artifact.objectPath]};
        }
        const runtimeLink = shared && runtime.shared !== undefined
            ? runtime.shared.link
            : runtime.library;

        const report = this.#backend.link({
            kind,
            objects: [artifact.objectPath],
            archives: selfContained
                ? [
                    ...(this.#options.nativeLibs ?? []).map((path) => this.#resolve(path)),
                    runtimeLink,
                ]
                : [],
            systemLibs: selfContained ? [...runtime.systemLibs] : [],
            output,
            // Only matters when something shared has to be found beside the
            // artefact, and only on the platforms that bake a search path in.
            rpathOrigin: shared,
            // Only Windows needs these, and only for a DLL: an ELF shared object
            // publishes every default-visibility symbol on its own.
            //
            // The module's own defines are not the whole list. When a `string`
            // crosses, the generated header also declares `gf_string_free` and
            // its two companions for the consumer to call — and a header that
            // names a symbol the library does not export is a consumer who
            // cannot link. The runtime is *inside* this DLL in that case, so
            // this is the only thing that has a definition to publish.
            //
            // Linked shared it has an import rather than a definition, and the
            // consumer links the runtime's own import library instead. Not
            // because re-exporting would fail — `link.exe` accepts an imported
            // symbol in a `.def` quite happily and emits a forwarder, which was
            // checked rather than assumed. Because it would make the platforms
            // disagree: ELF records an import as an undefined entry rather than
            // a definition, so a consumer there has to link the runtime whether
            // this list names it or not. One rule for both is worth more than
            // one fewer import library on one of them.
            exports: kind === "shared-lib"
                ? [
                    ...artifact.defines,
                    ...(shared ? [] : runtimeSymbols(lowered.module)),
                ]
                : [],
        });
        diagnostics.push(...report.diagnostics.map(fromBackend));
        if (!report.ok || report.output === undefined) {
            return {...failed(diagnostics), objects: [artifact.objectPath]};
        }

        // The shared runtime, put where the artefact will look for it. Copied
        // rather than left in the crate's target directory, because "it worked
        // on the machine that built it" is exactly what a bare `-rpath` into a
        // build tree buys, and the failure lands on whoever runs the binary.
        let runtimeImage: string | undefined;
        if (shared && runtime.shared !== undefined) {
            runtimeImage = join(dirname(report.output), basename(runtime.shared.image));
            try {
                copyFileSync(runtime.shared.image, runtimeImage);
            } catch (error) {
                diagnostics.push({
                    severity: "error",
                    code: "GF9005",
                    source: "goblin",
                    message:
                        `linked against the shared runtime, but could not copy it to ` +
                        `${runtimeImage}: ${(error as Error).message}`,
                });
                return {...failed(diagnostics), objects: [artifact.objectPath]};
            }
        }

        return {
            ok: true,
            diagnostics,
            output: report.output,
            objects: [artifact.objectPath],
            ...(runtimeImage !== undefined ? {runtimeImage} : {}),
            ...(irPath !== undefined ? {irPath} : {}),
            ...(headerPath !== undefined ? {headerPath} : {}),
            ...(report.command !== undefined ? {linkCommand: report.command} : {}),
            ...(kind === "static-lib" ? {runtimeLibrary: runtime.library} : {}),
            ...(kind === "shared-lib" && outputExtension("shared-lib") === "dll"
                ? {importLibrary: output.replace(/\.dll$/i, ".lib")}
                : {}),
        };
    }

    #outputPath(kind: OutputKind): string {
        const base = this.#resolve(this.#options.output);
        const extension = outputExtension(kind);
        if (extension === "") {
            return base;
        }
        return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
    }

    #resolve(path: string): string {
        return isAbsolute(path) ? path : resolve(this.#root, path);
    }
}

function failed(diagnostics: readonly Diagnostic[]): CompileResult {
    return {ok: false, diagnostics, objects: []};
}

/** A backend diagnostic, given the shape everything else uses. */
function fromBackend(diagnostic: {
    severity: string;
    code: string;
    message: string;
}): Diagnostic {
    return {
        severity:
            diagnostic.severity === "warning"
                ? "warning"
                : diagnostic.severity === "note"
                    ? "note"
                    : "error",
        code: diagnostic.code,
        message: diagnostic.message,
        source: "goblin",
    };
}

function basenameWithoutExtension(path: string): string {
    const base = path.slice(dirname(path).length + 1);
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? base : base.slice(0, dot);
}
