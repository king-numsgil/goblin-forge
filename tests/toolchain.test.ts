/**
 * The tools a build runs, looked for before it runs them.
 *
 * The failure this prevents is not "the build fails" — it would have failed
 * anyway. It is *when* and *as what*: a missing clang used to be found by the
 * backend, after the whole program had been checked and lowered, and reported
 * as an internal error, which is the compiler claiming to be broken about a
 * machine that is only missing a package.
 *
 * These tests take the environment apart, so each one puts it back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkToolchain } from "../packages/forge/src/toolchain.ts";

const VARIABLES = ["PATH", "GOBLIN_CLANG", "CC", "AR"] as const;

let saved: Partial<Record<string, string>>;

beforeEach(() => {
    saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
});

afterEach(() => {
    for (const name of VARIABLES) {
        const value = saved[name];
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
});

/** A path that cannot exist, for pointing an override at nothing. */
const NOWHERE = join(tmpdir(), "goblin-no-such-tool");

describe("the toolchain check", () => {
    test("says nothing on a machine that can build", () => {
        // This suite compiles real programs, so a machine running it has the
        // tools by definition — which makes silence here the assertion that the
        // check does not cry wolf.
        expect(checkToolchain("bin")).toEqual([]);
    });

    test("names every missing tool at once, rather than the first", () => {
        // A machine missing clang is usually missing cargo too, and finding that
        // out one build at a time is a worse afternoon than being told once.
        process.env["PATH"] = "";
        const [diagnostic, ...rest] = checkToolchain("bin");
        expect(rest).toEqual([]);
        expect({code: diagnostic?.code, severity: diagnostic?.severity}).toEqual({
            code: "GF0006",
            severity: "error",
        });
        for (const tool of ["clang", "cargo", "cc"]) {
            expect(diagnostic?.message).toContain(tool);
        }
    });

    test("says what each tool is for, and how to point at one", () => {
        // The audience is somebody who has just been told to install something,
        // so the message says what it is for and names the variable that would
        // let them skip installing it.
        process.env["PATH"] = "";
        const message = checkToolchain("bin")[0]?.message ?? "";
        expect(message).toContain("compiles the LLVM IR");
        expect(message).toContain("GOBLIN_CLANG");
        expect(message).toContain("Nothing has been compiled");
    });

    test("a static library wants the archiver, not the linker", () => {
        // An archive is not a link: nothing is resolved and no runtime is pulled
        // in, so a machine with no linker can still build one.
        process.env["PATH"] = "";
        const message = checkToolchain("static-lib")[0]?.message ?? "";
        expect(message).toMatch(/\bar \(not on PATH\)/);
        expect(message).not.toMatch(/\bcc \(/);
    });

    test("an override that points at nothing is a missing file, not a missing PATH", () => {
        // Whoever set the variable said where the tool is. Answering "not on
        // PATH" would be answering a question they did not ask.
        process.env["GOBLIN_CLANG"] = NOWHERE;
        const message = checkToolchain("bin")[0]?.message ?? "";
        expect(message).toContain(`${NOWHERE} (no such file)`);
    });

    test("an override that points at a real tool satisfies the check", () => {
        // Whatever is running this test is an executable file, which is all the
        // check claims to know: it looks for something runnable under the name
        // it was given, and leaves the tool to say whether it is the right one.
        process.env["GOBLIN_CLANG"] = process.execPath;
        expect(checkToolchain("bin")).toEqual([]);
    });

    test("a directory on PATH is not a tool", () => {
        // A directory carries the executable bit too, so `access(X_OK)` alone
        // would accept `/tmp/clang/` as a compiler.
        process.env["PATH"] = tmpdir();
        process.env["GOBLIN_CLANG"] = tmpdir();
        expect(checkToolchain("bin")[0]?.message).toContain(tmpdir());
    });
});
