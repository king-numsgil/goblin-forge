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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile, type CompileResult, type Diagnostic, formatAll } from "goblin-forge";
import { GLOBAL_DECLARATIONS, TSCONFIG_BASE } from "@goblin-forge/runtime/paths";

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
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
    cleaned = true;
  }
  return SCRATCH;
}

let counter = 0;

export interface ProjectOptions {
  /** Extra `.ts` files beside the entry, keyed by file name. */
  readonly files?: Readonly<Record<string, string>>;
  readonly checked?: boolean;
  readonly optLevel?: "none" | "speed" | "size";
  readonly debugInfo?: boolean;
  /** Write the MIR out, for the golden snapshots. */
  readonly emitIr?: boolean;
  /** Static libraries to link, for the struct-ABI suite. */
  readonly nativeLibs?: readonly string[];
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
  mkdirSync(join(dir, "src"), { recursive: true });

  const entry = join(dir, "src", "main.ts");
  writeFileSync(entry, source, "utf8");

  const extraFiles = Object.entries(options.files ?? {});
  for (const [file, contents] of extraFiles) {
    const path = join(dir, "src", file);
    mkdirSync(dirname(path), { recursive: true });
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
        extends: posix(TSCONFIG_BASE),
        files: [
          posix(GLOBAL_DECLARATIONS),
          "src/main.ts",
          ...extraFiles.map(([file]) => `src/${file}`),
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { dir, entry, tsconfig, output: join(dir, "bin", "app") };
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
    type: "bin",
    optLevel: options.optLevel ?? "none",
    debugInfo: options.debugInfo ?? false,
    checked: options.checked ?? false,
    emit: { ir: options.emitIr ?? false },
    ...(options.nativeLibs !== undefined ? { nativeLibs: [...options.nativeLibs] } : {}),
    // The whole point of §8's hard rule. A backend error must be a loud crash,
    // not something a test can read as the compiler correctly saying no.
    strictInternalErrors: true,
  });
  return { project, result };
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
  const { result } = await compileSource(name, source, options);
  if (!result.ok || result.output === undefined) {
    throw new Error(
      `expected \`${name}\` to compile, but it did not:\n\n${formatAll(result.diagnostics)}`,
    );
  }
  if (!existsSync(result.output)) {
    throw new Error(`the compiler reported success but ${result.output} does not exist`);
  }

  const child = spawnSync(result.output, [], {
    encoding: "utf8",
    // The runtime prints its live-allocation count on exit when this is set.
    env: { ...process.env, GOBLIN_LEAK_CHECK: "1" },
  });
  if (child.error) throw child.error;

  const { stderr, leaked } = takeLeakReport(child.stderr ?? "");

  // REWRITE-PLAN §9 calls this non-negotiable, and v1's experience is the
  // reason: the automatic check "found more real bugs than every deliberate
  // assertion combined". It runs on every single run test, without anyone
  // having to remember to ask for it.
  if (leaked !== undefined && leaked !== 0) {
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
    ...(leaked !== undefined ? { leaked } : {}),
  };
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
    // The runtime registers its reporter on the first allocation. A program
    // that never allocated never registered one — and never leaked either.
    return { stderr, leaked: 0 };
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
  const { result } = await compileSource(name, source, options);
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
