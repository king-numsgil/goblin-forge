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

/**
 * The language reference, shipped beside the bundle.
 *
 * Deliberately **not** a `RuntimeFiles` member. Every one of those exists because
 * the *compiler* reads it — even `stdLibrary`, which is there so the lowerer can
 * recognise the directory — and this is for whoever writes the code, or the agent
 * helping them. Putting it in that interface would make "where the compiler looks
 * for what it needs" mean something looser.
 *
 * It is copied and checked all the same, because a package whose reference is
 * missing is the same silent gap `SHIPPED` exists to close.
 */
const REFERENCE = "LANGUAGE.md";

/**
 * The token the reference's heading carries in place of a version.
 *
 * Substituted here rather than written into the file, for the reason
 * `dist/package.json` is generated: the copy that used to sit in `dist` by hand was
 * still claiming `0.1.0` after two releases, and `dist` is gitignored so no diff
 * showed it. A version in a document goes stale the same way and is read by more
 * people.
 */
const VERSION_TOKEN = "{{VERSION}}";

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

// **Every** addon, not the first one found. Two of them side by side is the
// feature this file's header describes — napi picks by triple at load time, so one
// package serves both machines — and `find` picked whichever sorted first, which
// on Windows is the *Linux* one. So a Windows package shipped no Windows addon,
// and a Linux addon dropped in beside it was overwritten by whatever
// `packages/backend` happened to hold.
//
// The same mistake `packages/cli/build.ts` had at 0.3.0, in its sibling, found
// the same way: by a release that had one stale artefact in it.
const addons = (await readdir(backendDir)).filter((file) => file.endsWith(".node"));
if (addons.length === 0) {
    console.error("no built addon in packages/backend. Run `bun run build:backend` first.");
    process.exit(1);
}
for (const addon of addons) {
    await copyFile(join(backendDir, addon), join(dist, addon));
}

await copyFile(join(runtimeDir, "global.d.ts"), join(dist, SHIPPED.globalDeclarations));
await copyFile(join(runtimeDir, "tsconfig.base.json"), join(dist, SHIPPED.tsconfigBase));

// The reference, with the version filled in. Refusing to ship it without the token
// is the half that matters: a document that quietly stopped being substituted would
// be a document claiming an old version, which is worse than one claiming none.
// Existence first, because reading a file that is not there throws out of Bun with
// a stack trace and no mention of what was wanted — the shape of failure this whole
// file is a reaction to.
if (!existsSync(`./${REFERENCE}`)) {
    console.error(
        `packages/forge/${REFERENCE} is missing. It is the language reference the ` +
        "package ships; put it back or remove the copy step.",
    );
    process.exit(1);
}
const reference = await Bun.file(`./${REFERENCE}`).text();
if (!reference.includes(VERSION_TOKEN)) {
    console.error(
        `packages/forge/${REFERENCE} has no \`${VERSION_TOKEN}\` in it. The version is ` +
        "substituted at package time; a hand-written one goes stale on the next release.",
    );
    process.exit(1);
}
await Bun.write(join(dist, REFERENCE), reference.replaceAll(VERSION_TOKEN, version));

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
// Checked beside them rather than with them, because what goes wrong is different:
// nothing *resolves* to the reference, so a missing one is a package that documents
// nothing rather than a build that fails somewhere else.
if (!existsSync(join(dist, REFERENCE))) {
    console.error(`${dist}/${REFERENCE} is missing — the package would ship no reference.`);
    process.exit(1);
}

// Every addon named, because "which addons did this package get" is the question a
// release has to answer and the one a single name answered wrongly.
console.log(`packaged ${dist} (addons: ${addons.join(", ")})`);
