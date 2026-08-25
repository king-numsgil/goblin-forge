/**
 * Package `goblin-forge` for use outside this repo.
 *
 *   bun run --cwd packages/forge package
 *
 * `dist/` is the whole package, flat, and everything in it is there because
 * something reads it at *compile* time rather than at build time:
 *
 * - the bundle, `index.js`, entered through `src/packaged.ts` rather than
 *   `src/index.ts` — see that file for what the extra hop is for;
 * - the platform's addon beside it, because napi's loader resolves its `.node`
 *   relative to the file that requires it;
 * - the prelude and the tsconfig base, which tsc opens by name;
 * - the runtime crate, which cargo builds for the *user's* target on demand and
 *   therefore cannot be a prebuilt artefact.
 *
 * Shipping the bundle and not the other four is the mistake this file exists to
 * stop repeating: each of them fails somewhere far from here — a `TS6053` about
 * a missing declaration file, an `extends` that resolves to nothing, a cargo
 * invocation on a directory with no `Cargo.toml`.
 */

import { dts } from "bun-dts";
import { copyFile, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const dist = "./dist";
const backendDir = "../backend";
const runtimeDir = "../runtime";

// Overwritten rather than emptied first. `dist` is also where an addon built on
// *another* platform is dropped, so that one package serves both — napi picks by
// triple at load time, and a second `.node` sitting there is the feature. A
// wipe would take that with it, and the failure would be on the other machine.

const built = await Bun.build({
    entrypoints: ["./src/packaged.ts"],
    outdir: dist,
    target: "node",
    format: "esm",
    packages: "bundle",
    external: ["*.node"],
    plugins: [dts()],
});

if (!built.success) {
    for (const log of built.logs) {
        console.error(log);
    }
    process.exit(1);
}

// Named for the entry point, and the entry point is not called `index`. Renamed
// rather than asked for with `naming`, because that option is the bundler's and
// the declarations are the plugin's, and the two agreeing is not something this
// build should have to assume.
await rename(join(dist, "packaged.js"), join(dist, "index.js"));
await rename(join(dist, "packaged.d.ts"), join(dist, "index.d.ts"));

const addon = (await readdir(backendDir)).find((file) => file.endsWith(".node"));
if (addon === undefined) {
    console.error("no built addon in packages/backend. Run `bun run build:backend` first.");
    process.exit(1);
}
await copyFile(join(backendDir, addon), join(dist, addon));

await copyFile(join(runtimeDir, "global.d.ts"), join(dist, "global.d.ts"));
await copyFile(join(runtimeDir, "tsconfig.base.json"), join(dist, "tsconfig.base.json"));

// The crate's sources and nothing else — `native/` in the checkout also holds
// `target/`, which is a build of the runtime for whoever built it last and has
// no business in a package built for someone else's machine.
const crate = join(dist, "native");
await mkdir(join(crate, "src"), {recursive: true});
for (const file of ["Cargo.toml", "Cargo.lock"]) {
    await copyFile(join(runtimeDir, "native", file), join(crate, file));
}
await copyFile(join(runtimeDir, "native", "src", "lib.rs"), join(crate, "src", "lib.rs"));

console.log(`packaged ${dist} (addon: ${addon})`);
