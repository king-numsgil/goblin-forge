/**
 * Finding a system library.
 *
 * `nativeLibs` takes paths, so a build script that wants SDL has to turn the
 * name into one — and the answer differs per platform, per distribution and per
 * package manager. These tests cover the part that is decidable without a
 * machine: the spellings tried, the order they are tried in, and that the
 * override wins over everything.
 *
 * What a real `/usr/lib` holds is not decidable here, so nothing below asserts
 * that any particular library is installed. The one that was checked by hand is
 * in LINKING.md: `systemLib("SDL3")` against Arch's `sdl3` package, which is a
 * pkg-config answer rather than a guessed directory.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { systemLib } from "goblin-forge";

/** What the platform calls a shared library, and what it calls an archive. */
const SHARED = process.platform === "win32"
    ? "fake.lib"
    : process.platform === "darwin"
      ? "libfake.dylib"
      : "libfake.so";
const ARCHIVE = process.platform === "win32" ? "fake.lib" : "libfake.a";

const workspaces: string[] = [];

/** A directory holding the named library files, and nothing else. */
function libdir(...files: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "goblin-lib-"));
    workspaces.push(dir);
    mkdirSync(dir, {recursive: true});
    for (const file of files) {
        writeFileSync(join(dir, file), "");
    }
    return dir;
}

afterEach(() => {
    delete process.env["GOBLIN_LIB_PATH"];
    for (const dir of workspaces.splice(0)) {
        rmSync(dir, {recursive: true, force: true});
    }
});

describe("systemLib", () => {
    test("takes the library's own name and adds the platform's decoration", () => {
        // The point of the helper: `SDL3` is what the build script says on every
        // platform, and `libSDL3.so` / `libSDL3.dylib` / `SDL3.lib` is this
        // function's problem rather than the script's.
        const dir = libdir(SHARED);
        expect(systemLib("fake", {search: [dir]})).toBe(join(dir, SHARED));
    });

    test("prefers the shared library, because that is what a package manager installs", () => {
        const dir = libdir(SHARED, ARCHIVE);
        expect(systemLib("fake", {search: [dir]})).toBe(join(dir, SHARED));
    });

    test("`prefer: \"static\"` flips that, for an artefact that should carry the library", () => {
        const dir = libdir(SHARED, ARCHIVE);
        const found = systemLib("fake", {search: [dir], prefer: "static"});
        // One file serves both roles on MSVC and there is nothing to choose
        // between, which is worth saying rather than asserting a difference that
        // cannot exist there.
        expect(found).toBe(join(dir, process.platform === "win32" ? SHARED : ARCHIVE));
    });

    test("falls back to the other spelling when only one is installed", () => {
        const dir = libdir(ARCHIVE);
        expect(systemLib("fake", {search: [dir]})).toBe(join(dir, ARCHIVE));
    });

    test("`search` is looked in before anywhere else", () => {
        const first = libdir(SHARED);
        const second = libdir(SHARED);
        expect(systemLib("fake", {search: [first, second]})).toBe(join(first, SHARED));
    });

    test("GOBLIN_LIB_PATH is the override, and reads like PATH", () => {
        // The escape hatch an error message can name. A machine with the library
        // somewhere unusual has already had to answer this question once, and
        // this is the shape that answer normally takes.
        const dir = libdir(SHARED);
        process.env["GOBLIN_LIB_PATH"] = [join(dir, "nowhere"), dir].join(delimiter);
        expect(systemLib("fake")).toBe(join(dir, SHARED));
    });

    test("says what it looked for and where, rather than just failing", () => {
        const dir = libdir();
        // A build script that cannot find its library has no useful way to carry
        // on, so this throws — but the message has to be enough to fix it
        // without reading this file.
        expect(() => systemLib("nonesuch-xyz", {search: [dir]})).toThrow(/nonesuch-xyz/);
        expect(() => systemLib("nonesuch-xyz", {search: [dir]})).toThrow(/GOBLIN_LIB_PATH/);
        expect(() => systemLib("nonesuch-xyz", {search: [dir]})).toThrow(new RegExp(dir.replace(/\\/g, "\\\\")));
    });

    test("a relative directory is ignored rather than resolved against the cwd", () => {
        // Every other path in a build lands relative to the *script*, and this
        // function does not know where that is. Silently resolving against the
        // working directory is the footgun the whole build-script shape exists
        // to remove, so a relative entry is not a search path at all.
        expect(() => systemLib("fake", {search: ["./libs"]})).toThrow();
    });
});
