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
    compile,
    Compiler,
    type CompileOptions,
    type CompileResult,
    type OptLevel,
    type OutputKind,
} from "./compile.ts";

export { lower, type LowerResult } from "./lower.ts";

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
