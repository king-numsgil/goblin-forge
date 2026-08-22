/**
 * `goblin-forge` — the build frontend.
 *
 * ```ts
 * import { compile, format } from "goblin-forge";
 *
 * const result = await compile({
 *   entry: "./src/main.ts",
 *   tsconfig: "./tsconfig.gf.json",
 *   type: "bin",
 *   output: "./bin/app",
 *   root: import.meta.dir,
 * });
 *
 * if (!result.ok) {
 *   for (const d of result.diagnostics) console.error(format(d));
 *   process.exit(1);
 * }
 * ```
 */

export {
    type BuildEvent,
    type BuildPhase,
    compile,
    Compiler,
    type CompileOptions,
    type CompileResult,
    type OptLevel,
    type OutputKind,
} from "./compile.ts";

export { lower, type LowerResult } from "./lower.ts";

// `nativeLibs` takes paths, so something has to turn "SDL3" into one. Here
// rather than in the CLI because a build script that calls `compile` has the
// same problem as one that exports a config, and the answer should not depend
// on which of the two it is.
export { systemLib, type SystemLibOptions } from "./system-lib.ts";

// Diagnostics are the checker's model, and re-exported here so that a build
// script needs one import rather than two.
export {
    allCodes,
    type Code,
    type CodeEntry,
    CODES,
    type Diagnostic,
    explain,
    format,
    formatAll,
    type FormatOptions,
    hasErrors,
    type Location,
    type Note,
    type Severity,
} from "@goblin-forge/checker";

export {
    globalDeclarations,
    type RuntimeFiles,
    tsconfigBase,
    useRuntimeFiles,
} from "@goblin-forge/runtime/paths";
