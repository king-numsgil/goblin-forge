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

import { locateLinker } from "@goblin-forge/backend";

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

/**
 * How this machine finds its linker, asked the way the check asks.
 *
 * Not `process.platform`. MSVC and MinGW are both `win32` and want opposite
 * answers, so a suite that branched on the operating system would be forming
 * the second opinion the check exists to avoid — and would assert the Unix
 * answer on a Windows host, which is exactly how these tests were first
 * written and how they failed. The backend is the authority for the check, so
 * it is the authority here too; both halves are asserted below, and the half
 * that runs is the one that is true.
 */
const PROBE = locateLinker("bin");

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
        // The two an empty `PATH` always loses. The linker is the third tool a
        // build runs and it is deliberately not asserted here: whether `PATH`
        // is even the right question about it is the platform's to answer, and
        // that has a test of its own below.
        for (const tool of ["clang", "cargo"]) {
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

    /**
     * The one question a `PATH` walk cannot answer for itself.
     *
     * On MSVC the linker is found by probing the registry — installed and not
     * on `PATH` is the normal state there — so the backend answers with the
     * same lookup the link step runs, and the two cannot disagree. Everywhere
     * else, every Unix and MinGW alike, it says so, and `PATH` is the right
     * question.
     *
     * Each host can only be one of those, so each asserts its own half. The
     * halves are opposites rather than variations: one requires an empty `PATH`
     * to lose the linker, the other requires it not to.
     */
    test("the backend says how the linker is found, and the check takes its word", () => {
        process.env["PATH"] = "";
        const message = checkToolchain("bin")[0]?.message ?? "";

        if (!PROBE.probed) {
            expect(PROBE.path).toBeUndefined();
            expect(message).toMatch(/\bcc \(not on PATH\)/);
            return;
        }

        // MSVC: `link.exe` is not on `PATH` even on a machine that links fine,
        // so a check that walked `PATH` for it would fail every build here.
        // Emptying `PATH` must not shake it loose.
        expect(PROBE.path).toMatch(/[\\/]link\.exe$/i);
        expect(message).not.toContain("link.exe");
    });

    test("a static library wants the archiver, not the linker", () => {
        // An archive is not a link: nothing is resolved and no runtime is pulled
        // in, so a machine with no linker can still build one.
        process.env["PATH"] = "";
        const message = checkToolchain("static-lib")[0]?.message ?? "";

        if (!PROBE.probed) {
            expect(message).toMatch(/\bar \(not on PATH\)/);
            expect(message).not.toMatch(/\bcc \(/);
            return;
        }

        // On MSVC both tools are found, so neither is missing and the message
        // names neither — which leaves the kind itself as the thing to assert.
        // The check hands it straight to the probe, and `lib.exe` and
        // `link.exe` are different programs: an archiving build that reached
        // the linker would be asking after a tool it is never going to run.
        expect(locateLinker("static-lib").path).toMatch(/[\\/]lib\.exe$/i);
        expect(message).not.toContain("lib.exe");
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
