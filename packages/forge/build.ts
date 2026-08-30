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
 * - the std modules that are real Goblin source, which the tsconfig base's
 *   `paths` entry points at and tsc opens the same way a checkout does;
 * - the runtime crate, which cargo builds for the *user's* target on demand and
 *   therefore cannot be a prebuilt artefact.
 *
 * Shipping the bundle and not the other five is the mistake this file exists to
 * stop repeating: each of them fails somewhere far from here — a `TS6053` about
 * a missing declaration file, an `extends` that resolves to nothing, a cargo
 * invocation on a directory with no `Cargo.toml`.
 *
 * It repeated anyway. `std/` was added to `paths.ts`, to `packaged.ts` and to
 * the CLI's embedder, and missed here, so `0.2.1` shipped a package whose
 * tsconfig `paths` entry named a directory that was not in it — `SHIPPED`
 * below is what makes that a failed build rather than a released one.
 */

import type { RuntimeFiles } from "@goblin-forge/runtime/paths";
import { dts } from "bun-dts";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

/**
 * What has to land in `dist`, keyed by the accessor that will go looking.
 *
 * `packaged.ts` computes these same names from its own directory, and this is
 * the other half of that agreement — typed against `RuntimeFiles` so that
 * adding a member there stops *this* file from compiling until something puts
 * the file here. A comment asking the next person to remember is what was in
 * place before, and it did not work.
 */
const SHIPPED = {
    globalDeclarations: "global.d.ts",
    tsconfigBase: "tsconfig.base.json",
    stdLibrary: "std",
    runtimeCrate: "native",
} as const satisfies Record<keyof RuntimeFiles, string>;

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

// The manifest a consumer's package manager reads. Generated, because the copy
// that used to sit in `dist` by hand was still claiming `0.1.0` after the
// package had been versioned `0.2.0` — and `dist` is gitignored, so nothing
// showed a stale file in a diff. The version has one place to be written now,
// and it is the manifest above this one.
const own: unknown = await Bun.file("./package.json").json();
if (typeof own !== "object" || own === null || !("name" in own) || !("version" in own) || !("license" in own)) {
    console.error("packages/forge/package.json declares no name, version or license.");
    process.exit(1);
}
const {name, version, license} = own;
if (typeof name !== "string" || typeof version !== "string" || typeof license !== "string") {
    console.error("packages/forge/package.json: name, version and license must be strings.");
    process.exit(1);
}
await Bun.write(
    join(dist, "package.json"),
    `${JSON.stringify({name, version, license, type: "module", main: "./index.js", types: "./index.d.ts"}, null, 4)}\n`,
);

const addon = (await readdir(backendDir)).find((file) => file.endsWith(".node"));
if (addon === undefined) {
    console.error("no built addon in packages/backend. Run `bun run build:backend` first.");
    process.exit(1);
}
await copyFile(join(backendDir, addon), join(dist, addon));

await copyFile(join(runtimeDir, "global.d.ts"), join(dist, SHIPPED.globalDeclarations));
await copyFile(join(runtimeDir, "tsconfig.base.json"), join(dist, SHIPPED.tsconfigBase));

// The std modules that are real Goblin source, beside the tsconfig base whose
// `paths` entry names them — `"std/collection": ["./std/collection.ts"]` is
// resolved relative to the config, so the two have to travel together.
//
// Enumerated rather than listed, for the reason the CLI's embedder gives: a
// hand-written list is a second copy of a directory's contents that nothing
// keeps honest, and a file added and not listed would resolve in a checkout and
// be missing here.
const stdSource = join(runtimeDir, "std");
const stdTarget = join(dist, SHIPPED.stdLibrary);
await mkdir(stdTarget, {recursive: true});
for (const file of (await readdir(stdSource)).filter((name) => name.endsWith(".ts"))) {
    await copyFile(join(stdSource, file), join(stdTarget, file));
}

// The crate's sources and nothing else — `native/` in the checkout also holds
// `target/`, which is a build of the runtime for whoever built it last and has
// no business in a package built for someone else's machine.
const crate = join(dist, SHIPPED.runtimeCrate);
await mkdir(join(crate, "src"), {recursive: true});
for (const file of ["Cargo.toml", "Cargo.lock"]) {
    await copyFile(join(runtimeDir, "native", file), join(crate, file));
}
await copyFile(join(runtimeDir, "native", "src", "lib.rs"), join(crate, "src", "lib.rs"));

// Every name `packaged.ts` will hand to `useRuntimeFiles`, checked to be here
// before this reports success. Cheap, and the alternative is finding out from
// somebody else's build — which is how this file came to have a `SHIPPED` at
// all.
const absent = Object.entries(SHIPPED).filter(([, name]) => !existsSync(join(dist, name)));
if (absent.length > 0) {
    for (const [member, name] of absent) {
        console.error(`${dist}/${name} is missing — \`${member}\` would resolve to nothing.`);
    }
    process.exit(1);
}

console.log(`packaged ${dist} (addon: ${addon})`);
