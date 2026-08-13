/**
 * Where the language's own files are.
 *
 * Three things ship with the compiler and are read at compile time rather than
 * compiled in: the ambient prelude, the tsconfig every project extends, and the
 * runtime crate that every program links.
 *
 * Normally they are found relative to this module, so the answer is the same
 * from a checkout or a `node_modules` install. Inside a **single-file
 * executable** there is no such directory: the files are embedded in the
 * binary and reached by paths the bundler chose. {@link useRuntimeFiles} is how
 * that entry point says where they went.
 *
 * Functions rather than constants for exactly that reason. A constant is
 * computed when the module is first evaluated, which in a bundle is before any
 * entry point has had a chance to say anything.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where the compiler should look for the files that ship with it. */
export interface RuntimeFiles {
  /** The ambient prelude — `global.d.ts`. */
  readonly globalDeclarations: string;
  /** The tsconfig every project extends. */
  readonly tsconfigBase: string;
  /** A directory holding the runtime crate: `Cargo.toml` and `src/`. */
  readonly runtimeCrate: string;
}

let override: RuntimeFiles | undefined;

/**
 * Point the compiler at the files it ships with, when they are not on disk
 * beside it.
 *
 * Called once, before anything compiles. A single-file executable embeds the
 * three and calls this with wherever they ended up.
 */
export function useRuntimeFiles(files: RuntimeFiles): void {
  override = files;
}

/**
 * The ambient prelude: the entire global surface of the language.
 *
 * Every Goblin program is checked against exactly this file and nothing else,
 * because the compiler runs tsc with `noLib` and no `typeRoots`.
 */
export function globalDeclarations(): string {
  return override?.globalDeclarations ?? join(packageRoot, "global.d.ts");
}

/** The tsconfig every Goblin project extends. */
export function tsconfigBase(): string {
  return override?.tsconfigBase ?? join(packageRoot, "tsconfig.base.json");
}

/**
 * The runtime crate, built for the user's target and linked into every program.
 *
 * A directory rather than a file, and it has to be a real one: cargo is given
 * this path. An embedded copy is extracted before it is named here.
 */
export function runtimeCrate(): string {
  return override?.runtimeCrate ?? join(packageRoot, "native");
}
