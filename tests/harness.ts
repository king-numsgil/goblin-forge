/**
 * The test harness: real source, real compiler, real binary, real output.
 *
 * REWRITE-PLAN §9 calls v1's harness the best part of the project and asks for
 * four holes to be closed. All four are closed:
 *
 * * **`expectRejected` requires a diagnostic code.** v1 matched only
 *   `error[CODE]`, so a backend panic and a clean rejection looked the same to
 *   the assertion — a compiler crash read as a passing test. Here the code is a
 *   required argument, and `strictInternalErrors` makes the backend panic
 *   rather than return, so the two cannot be confused.
 * * **stderr is asserted**, not just stdout. v1 checked it in exactly one test.
 * * **The scratch directory is cleaned.** v1's accumulated over a thousand
 *   throwaway projects, which makes inspecting a real failure miserable.
 *
 * * **The automatic live-allocation check on every run test.** Non-negotiable,
 *   per §9, and the reason is v1's experience: it "found more real bugs than
 *   every deliberate assertion combined". Nobody has to ask for it, which is
 *   the entire point — see {@link run}.
 */

import { globalDeclarations, tsconfigBase } from "@goblin-forge/runtime/paths";

import {
    type BuildEvent,
    compile,
    type CompileResult,
    type Diagnostic,
    formatAll,
} from "goblin-forge";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, ".scratch");

/**
 * Wipe the scratch directory once per test process.
 *
 * Once, not per test: a test that fails should leave its project behind for
 * inspection, and the next *run* is what clears it.
 */
let cleaned = false;

function scratchRoot(): string {
    if (!cleaned) {
        rmSync(SCRATCH, {recursive: true, force: true});
        mkdirSync(SCRATCH, {recursive: true});
        cleaned = true;
    }
    return SCRATCH;
}

/**
 * An absolute path inside the scratch directory, for a test whose program has
 * to touch a real file.
 *
 * **Forward slashes on every platform, deliberately.** The result is pasted
 * into Goblin source as a string literal, and a Windows path written with
 * backslashes would be read as escape sequences rather than separators —
 * `C:\temp\gf` carries a tab and a form feed. Every C runtime accepts `/`,
 * including the MSVC one, so the separator is the portable half of the problem
 * and the drive letter takes care of itself.
 *
 * It lives here rather than in a test because `.scratch` is the harness's
 * directory: it is wiped once per test process, so a file written into it is
 * cleaned on the next run like everything else.
 */
export function scratchPath(name: string): string {
    return posix(join(scratchRoot(), name));
}

let counter = 0;

/**
 * What the suite compiles at unless a test says otherwise.
 *
 * `O0`, and deliberately: at `-O0` LLVM does not run `mem2reg`, so every local
 * really does live in the stack slot the lowerer gave it and the emitted IR is
 * the lowering rather than what the optimiser made of it. That is what makes a
 * golden MIR test and a `.ll` worth reading.
 *
 * It is also the level the runtime is now built at for these tests, which
 * `preload.ts` warms — so this constant is shared rather than written twice.
 */
export const HARNESS_OPT_LEVEL = "O0" as const;

export interface ProjectOptions {
    /** Extra `.ts` files beside the entry, keyed by file name. */
    readonly files?: Readonly<Record<string, string>>;
    readonly checked?: boolean;
    readonly optLevel?: "O0" | "O1" | "O2" | "O3" | "Os" | "Oz";
    readonly debugInfo?: boolean;
    /** Write the MIR out, for the golden snapshots. */
    readonly emitIr?: boolean;
    /** Static libraries to link, for the struct-ABI suite. */
    readonly nativeLibs?: readonly string[];
    /** What to build. Defaults to `bin`, which is what most tests want. */
    readonly type?: "bin" | "static-lib" | "shared-lib";
    /**
     * How the runtime is linked. Defaults to `static`, as a build does.
     *
     * `shared` is what the two-artefacts-in-one-process suite needs, and the
     * compiler copies the runtime beside the output — so a test runs the binary
     * the same way either way.
     */
    readonly runtime?: "static" | "shared";
    /**
     * Phase events, for the suite that watches a build report on itself.
     *
     * Off unless a test asks, exactly as it is for any other caller: `compile`
     * reports only when given somewhere to report to.
     */
    readonly onProgress?: (event: BuildEvent) => void;
    /**
     * `compilerOptions` written into the project's tsconfig, over the base.
     *
     * Only `GF0003` needs this — the diagnostic exists precisely because a
     * project *can* extend the base and then override a setting the language
     * depends on, and there is no other way to build one that does.
     */
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
    /**
     * Arguments handed to the compiled program, for `main(args: string[])`.
     *
     * They arrive *after* `argv[0]`, which the platform supplies and the runtime
     * keeps — so a program given `["a"]` sees a two-element array.
     */
    readonly args?: readonly string[];
}

export interface Project {
    readonly dir: string;
    readonly entry: string;
    readonly tsconfig: string;
    readonly output: string;
}

/** Write a single-module project into the scratch directory. */
export function writeProject(name: string, source: string, options: ProjectOptions = {}): Project {
    counter += 1;
    const dir = join(scratchRoot(), `${sanitise(name)}-${counter}`);
    mkdirSync(join(dir, "src"), {recursive: true});

    const entry = join(dir, "src", "main.ts");
    writeFileSync(entry, source, "utf8");

    const extraFiles = Object.entries(options.files ?? {});
    for (const [file, contents] of extraFiles) {
        const path = join(dir, "src", file);
        mkdirSync(dirname(path), {recursive: true});
        writeFileSync(path, contents, "utf8");
    }

    // `files` rather than `include`, and the prelude named explicitly, so the
    // project is exactly what a user's editor would see. A harness that quietly
    // arranged something friendlier would stop testing the thing that matters.
    const tsconfig = join(dir, "tsconfig.json");
    writeFileSync(
        tsconfig,
        `${JSON.stringify(
            {
                extends: posix(tsconfigBase()),
                ...(options.compilerOptions !== undefined
                    ? {compilerOptions: options.compilerOptions}
                    : {}),
                files: [
                    posix(globalDeclarations()),
                    "src/main.ts",
                    ...extraFiles.map(([file]) => `src/${file}`),
                ],
            },
            null,
            2,
        )}\n`,
        "utf8",
    );

    return {dir, entry, tsconfig, output: join(dir, "bin", "app")};
}

/** Compile a program. Never throws for a program that simply does not compile. */
export async function compileSource(
    name: string,
    source: string,
    options: ProjectOptions = {},
): Promise<{ project: Project; result: CompileResult }> {
    const project = writeProject(name, source, options);
    const result = await compile({
        entry: project.entry,
        tsconfig: project.tsconfig,
        output: project.output,
        root: project.dir,
        outDir: join(project.dir, "build"),
        type: options.type ?? "bin",
        optLevel: options.optLevel ?? HARNESS_OPT_LEVEL,
        debugInfo: options.debugInfo ?? false,
        checked: options.checked ?? false,
        emit: {ir: options.emitIr ?? false},
        ...(options.nativeLibs !== undefined ? {nativeLibs: [...options.nativeLibs]} : {}),
        ...(options.runtime !== undefined ? {runtime: options.runtime} : {}),
        ...(options.onProgress !== undefined ? {onProgress: options.onProgress} : {}),
        // The whole point of §8's hard rule. A backend error must be a loud crash,
        // not something a test can read as the compiler correctly saying no.
        strictInternalErrors: true,
    });
    return {project, result};
}

export interface RunResult {
    readonly stdout: string;
    readonly stderr: string;
    /**
     * The process exit code, **as its low 8 bits**.
     *
     * Not a choice: POSIX `waitpid` gives 8 bits, and Bun truncates to 8 bits on
     * Windows too even though the OS carries a full 32-bit code there. A
     * compiled program returning 300 really does exit 300 — checked against
     * PowerShell's `$LASTEXITCODE` — and this field still says 44.
     *
     * So a test that wants to observe a value wider than a byte must not observe
     * it here. Compare it inside the program and return a small verdict, or once
     * milestone 5 brings `console.log`, print it and assert on {@link stdout},
     * which is what REWRITE-PLAN §9 wants the primary mechanism to be anyway.
     */
    readonly exitCode: number;
    /**
     * Live allocations left behind by the program.
     *
     * Asserted to be zero on every single run test, automatically. A test does
     * not opt in and cannot forget.
     */
    readonly leaked?: number;
}

/** Compile, run, and return everything the program did. */
export async function run(
    name: string,
    source: string,
    options: ProjectOptions = {},
): Promise<RunResult> {
    const {result} = await compileSource(name, source, options);
    if (!result.ok || result.output === undefined) {
        throw new Error(
            `expected \`${name}\` to compile, but it did not:\n\n${formatAll(result.diagnostics)}`,
        );
    }
    if (!existsSync(result.output)) {
        throw new Error(`the compiler reported success but ${result.output} does not exist`);
    }
    return runBinary(name, result.output, options);
}

/**
 * Run an already-compiled program, with the whole leak check.
 *
 * Split out of {@link run} for the suites that have something to do between
 * compiling and running — a second artefact to build, a library to put beside
 * the executable. Sharing this rather than spawning directly is what keeps the
 * automatic live-allocation check on *every* run test, which REWRITE-PLAN §9
 * calls non-negotiable and which a test cannot opt out of by accident.
 */
export function runBinary(
    name: string,
    binary: string,
    options: ProjectOptions = {},
): RunResult {
    const child = spawnSync(binary, [...(options.args ?? [])], {
        encoding: "utf8",
        // The runtime prints its live-allocation count on exit when this is set.
        env: {...process.env, GOBLIN_LEAK_CHECK: "1"},
    });
    if (child.error) {
        throw child.error;
    }

    const {stderr, leaked} = takeLeakReport(child.stderr ?? "");

    // A missing report means the program did not reach a normal exit.
    //
    // `gf_runtime_init` runs at the top of every `bin`'s `main` and registers the
    // reporter unconditionally, so the line is printed by every program that gets
    // as far as returning from `main` — including one that allocates nothing.
    // Absent, it did not: an abort, a fault, or a `_exit`.
    //
    // This is worth catching loudly rather than reading as zero, and the reason
    // is the shape of the failure it hides. A double free aborts the process, and
    // the exit code a test would see is eight bits of an NTSTATUS or a signal —
    // 116 for Windows' heap corruption, a number indistinguishable from one a
    // program computed. A crashed run used to score a clean leak check and a
    // plausible exit code at the same time.
    if (leaked === undefined) {
        throw new Error(
            `\`${name}\` did not exit normally — it produced no live-allocation ` +
            `report, which every program that returns from \`main\` does.\n\n` +
            `The exit status was ${describeExit(child)}. A crash inside the ` +
            `runtime — a double free, a use-after-free — looks like this, and the ` +
            `exit code is not a value the program computed.\n\n` +
            `stdout was:\n${child.stdout ?? ""}\nstderr was:\n${stderr}`,
        );
    }

    // REWRITE-PLAN §9 calls this non-negotiable, and v1's experience is the
    // reason: the automatic check "found more real bugs than every deliberate
    // assertion combined". It runs on every single run test, without anyone
    // having to remember to ask for it.
    if (leaked !== 0) {
        throw new Error(
            `\`${name}\` leaked ${leaked} allocation${leaked === 1 ? "" : "s"}.\n\n` +
            `Every value a Goblin program allocates is released by the scope that ` +
            `owns it, so a non-zero count is a missing or misplaced drop.\n\n` +
            `stdout was:\n${child.stdout ?? ""}`,
        );
    }

    return {
        stdout: child.stdout ?? "",
        stderr,
        exitCode: child.status ?? -1,
        ...(leaked !== undefined ? {leaked} : {}),
    };
}

/**
 * How a child process ended, in the terms that are actually available.
 *
 * On POSIX a crash arrives as a signal and the name says what happened. On
 * Windows there are no signals and the status is the low eight bits of an
 * NTSTATUS, so the hexadecimal is printed beside it — `0x74` is the tail of
 * `0xC0000374`, `STATUS_HEAP_CORRUPTION`, which is what a double free looks
 * like from out here.
 */
function describeExit(child: { status: number | null; signal: NodeJS.Signals | null }): string {
    if (child.signal !== null) {
        return `signal ${child.signal}`;
    }
    if (child.status === null) {
        return "unknown";
    }
    return `${child.status} (0x${child.status.toString(16)}, as its low eight bits)`;
}

/**
 * Split the runtime's leak report off the program's own stderr.
 *
 * The program's stderr is asserted by tests, so the report must not appear in
 * it — REWRITE-PLAN §9 asks for stderr to be checked, and a harness that
 * quietly appended a line to it would make every such assertion wrong.
 */
function takeLeakReport(stderr: string): { stderr: string; leaked?: number } {
    const marker = /^##goblin-live-allocations:(-?\d+)$/m;
    const match = marker.exec(stderr);
    if (match === null) {
        // No report at all, which {@link run} treats as abnormal termination —
        // `gf_runtime_init` registers the reporter from `main` whether or not the
        // program ever allocates, so the only way to be missing one is to not have
        // reached the end.
        return {stderr};
    }
    return {
        stderr: stderr.replace(marker, "").replace(/\n{2,}/g, "\n").replace(/^\n/, ""),
        leaked: Number(match[1]),
    };
}

/**
 * Assert that a program is rejected, with a specific diagnostic code.
 *
 * The code is required, and that is the point: without it, a backend panic and
 * a clean rejection are the same observation.
 */
export async function expectRejected(
    name: string,
    source: string,
    code: string,
    options: ProjectOptions = {},
): Promise<Diagnostic> {
    const {result} = await compileSource(name, source, options);
    if (result.ok) {
        throw new Error(`expected \`${name}\` to be rejected with ${code}, but it compiled`);
    }

    const match = result.diagnostics.find((d) => d.code === code && d.severity === "error");
    if (match === undefined) {
        const seen = result.diagnostics.map((d) => `${d.severity}[${d.code}]`).join(", ") || "none";
        throw new Error(
            `expected \`${name}\` to be rejected with ${code}, but the diagnostics were ` +
            `${seen}:\n\n${formatAll(result.diagnostics)}`,
        );
    }
    return match;
}

/**
 * What a compile did, watched from outside the process it ran in.
 *
 * `survived` is the interesting field: a backend panic aborts the process, so a
 * compile that did not get far enough to say anything is one the addon crashed
 * on. See {@link compileOutOfProcess}.
 */
export interface OutOfProcessResult {
    /** The compiler ran to a verdict rather than aborting. */
    readonly survived: boolean;
    /** The verdict, when there was one. */
    readonly ok?: boolean;
    /** Error codes, when there was a verdict. */
    readonly codes?: readonly string[];
    /** Whatever the process wrote to stderr — the panic message, if it panicked. */
    readonly stderr: string;
    readonly exitCode: number;
}

/**
 * Compile a program in a child process, and report whether the compiler lived.
 *
 * REWRITE-PLAN §8's hard rule is that the backend never reports a user error:
 * anything reachable from source tsc accepted is a missing *frontend* check,
 * and it panics rather than returning so that a test cannot read a compiler
 * crash as the compiler correctly saying no. The rule is only enforceable if
 * something can watch it, and a panic in the addon kills the runner — so the
 * watching is done from out here.
 */
export function compileOutOfProcess(
    name: string,
    source: string,
    options: ProjectOptions = {},
): OutOfProcessResult {
    const request = join(scratchRoot(), `${sanitise(name)}-request-${(counter += 1)}.json`);
    writeFileSync(
        request,
        JSON.stringify({
            name,
            source,
            ...(options.files !== undefined ? {files: options.files} : {}),
        }),
        "utf8",
    );

    const runner = join(HERE, "support", "compile-once.ts");
    const child = spawnSync(process.execPath, ["run", runner, request], {
        encoding: "utf8",
        cwd: resolve(HERE, ".."),
    });
    if (child.error) {
        throw child.error;
    }

    const marker = /^##goblin-compile-once:(.*)$/m.exec(child.stdout ?? "");
    const stderr = child.stderr ?? "";
    const exitCode = child.status ?? -1;
    if (marker === null) {
        return {survived: false, stderr, exitCode};
    }

    const verdict = JSON.parse(marker[1]!) as { ok: boolean; codes: string[] };
    return {survived: true, ok: verdict.ok, codes: verdict.codes, stderr, exitCode};
}

/** Every error code a compile produced, for asserting the whole set. */
export function errorCodes(result: CompileResult): string[] {
    return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

function sanitise(name: string): string {
    return name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
}

/** tsconfig wants forward slashes even on Windows. */
function posix(path: string): string {
    return resolve(path).replace(/\\/g, "/");
}
