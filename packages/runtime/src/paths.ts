/**
 * Where the language's own files are on disk.
 *
 * Resolved from this module's location rather than from the working directory,
 * so it is the same answer whether the compiler is running from a checkout, a
 * `node_modules` install, or a bundled executable.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The ambient prelude: the entire global surface of the language.
 *
 * Every Goblin program is checked against exactly this file and nothing else,
 * because the compiler runs tsc with `noLib` and no `typeRoots`.
 */
export const GLOBAL_DECLARATIONS = join(packageRoot, "global.d.ts");

/** The tsconfig every Goblin project extends. */
export const TSCONFIG_BASE = join(packageRoot, "tsconfig.base.json");

/** The root of this package, for resolving anything else that ships with it. */
export const RUNTIME_ROOT = packageRoot;
