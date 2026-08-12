/**
 * A build script, which is the whole user-facing interface.
 *
 * There is no CLI to learn: `compile` is a function, the options are an object,
 * and a program that does not compile comes back as a *result* rather than an
 * exception. Run it with `bun run examples/hello/build.ts`.
 */

import { compile, formatAll } from "goblin-forge";

const result = await compile({
  entry: "./src/main.ts",
  tsconfig: "./tsconfig.json",

  type: "bin",
  output: "./bin/hello",

  optLevel: "speed",
  debugInfo: true,

  outDir: "./build",

  // Relative paths resolve against this rather than the working directory, so
  // the script behaves the same wherever it is run from.
  root: import.meta.dir,
});

if (!result.ok) {
  console.error(formatAll(result.diagnostics, { color: true, cwd: import.meta.dir }));
  process.exit(1);
}

console.log(`built ${result.output}`);
