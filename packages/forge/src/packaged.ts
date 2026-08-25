/**
 * The entry point of the *packaged* compiler.
 *
 * [`index.ts`](./index.ts) is the API. This is that API plus the one thing a
 * checkout does not have to say, because in a checkout it is already true.
 *
 * `@goblin-forge/runtime/paths` finds the files the compiler ships with —
 * the prelude, the tsconfig base, the runtime crate — one directory above the
 * module doing the looking, which is where they sit relative to
 * `packages/runtime/src/paths.ts`. The package is flat: `index.js` *beside*
 * `global.d.ts`, not below it. So the same search lands a directory too high,
 * in `node_modules` itself, and the whole of the failure is tsc reporting that
 * the prelude is missing from a path nothing ever wrote to.
 *
 * Saying where they actually went is what {@link useRuntimeFiles} is for, and
 * `build.ts` puts them exactly here. The single-file executable has the same
 * problem and answers it the same way, from `packages/cli/src/main.ts`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { useRuntimeFiles } from "@goblin-forge/runtime/paths";

const here = dirname(fileURLToPath(import.meta.url));

// Before anything compiles, which is all that is required of it: `paths.ts`
// reads this override inside the accessors rather than when it is evaluated,
// so the re-export below having already run its module body is not a race.
useRuntimeFiles({
    globalDeclarations: join(here, "global.d.ts"),
    tsconfigBase: join(here, "tsconfig.base.json"),
    runtimeCrate: join(here, "native"),
});

export * from "./index.ts";
