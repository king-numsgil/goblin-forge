/**
 * Differential testing against real C++.
 *
 * REWRITE-PLAN §9.1, and the reason it exists: if the semantics are meant to be
 * C++'s, then C++ is the oracle. Each case in `tests/oracle/cases/` is written
 * twice — `<name>.cpp` and `<name>.gf.ts` — and both print a trace of every
 * allocation and release interleaved with the program's own output. The two
 * traces are required to be identical.
 *
 * This is worth more than any number of hand-written expectations, because the
 * question "what *should* this print?" stops being a judgement call. It is also
 * the thing that turns "C++-like" from an intention into a checked property.
 *
 * Where the two are *meant* to differ, the difference is written down here as
 * an explicit expected divergence, so every intentional departure from C++ is
 * documented and checked rather than remembered. See {@link DIVERGENCES}.
 *
 * The C++ side is built with CMake, which finds the compiler itself — no
 * probing of Visual Studio paths and no Developer Command Prompt.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileSource } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORACLE = join(HERE, "oracle");
const BUILD = join(ORACLE, "build");

/**
 * Cases where Goblin is meant to differ from C++, and why.
 *
 * An entry here is a *decision*, not a bug. Empty is the healthy state.
 */
const DIVERGENCES: Readonly<Record<string, string>> = {};

/** Configure and build the C++ oracle once per test process. */
let built: { ok: true; bin: string } | { ok: false; reason: string } | undefined;

function buildOracle(): typeof built & object {
    if (built !== undefined) {
        return built;
    }

    const cmake = spawnSync("cmake", ["-S", ORACLE, "-B", BUILD], {encoding: "utf8"});
    if (cmake.error !== undefined || cmake.status !== 0) {
        built = {
            ok: false,
            reason:
                cmake.error?.message ??
                `cmake configure failed:\n${cmake.stdout ?? ""}${cmake.stderr ?? ""}`,
        };
        return built;
    }

    const build = spawnSync("cmake", ["--build", BUILD, "--config", "Release"], {
        encoding: "utf8",
    });
    if (build.error !== undefined || build.status !== 0) {
        built = {
            ok: false,
            reason: `cmake build failed:\n${build.stdout ?? ""}${build.stderr ?? ""}`,
        };
        return built;
    }

    mkdirSync(join(BUILD, "bin"), {recursive: true});
    built = {ok: true, bin: join(BUILD, "bin")};
    return built;
}

/** Every case, by name, as the pair of files that make it up. */
function cases(): string[] {
    return readdirSync(join(ORACLE, "cases"))
        .filter((file) => file.endsWith(".cpp"))
        .map((file) => file.slice(0, -".cpp".length))
        .sort();
}

/** Run a built executable with tracing on, and return its stdout. */
function traceOf(executable: string): string {
    const result = spawnSync(executable, [], {
        encoding: "utf8",
        env: {...process.env, GOBLIN_TRACE_ALLOC: "1"},
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${executable} exited ${result.status}:\n${result.stderr ?? ""}`);
    }
    // C stdio opens stdout in text mode on Windows, so the C++ side writes CRLF
    // while the Rust runtime writes a bare LF. That is a property of two C
    // runtimes, not of the two languages' semantics, and comparing it would make
    // every case fail for a reason the suite is not about.
    return (result.stdout ?? "").replace(/\r\n/g, "\n");
}

const oracle = buildOracle();

describe("the C++ oracle", () => {
    test("the oracle builds", () => {
        // A failure here is a missing toolchain, not a compiler bug — and it is
        // reported as one, rather than as every case failing mysteriously.
        expect(oracle.ok ? "built" : oracle.reason).toBe("built");
    });

    for (const name of cases()) {
        const divergence = DIVERGENCES[name];

        test(`${name} matches C++${divergence ? " (with a stated divergence)" : ""}`, async () => {
            if (!oracle.ok) {
                throw new Error(oracle.reason);
            }

            const executable = findExecutable(oracle.bin, name);
            const expected = traceOf(executable);

            const source = readFileSync(join(ORACLE, "cases", `${name}.gf.ts`), "utf8");
            const {result} = await compileSource(`oracle-${name}`, source);
            if (!result.ok || result.output === undefined) {
                throw new Error(
                    `the Goblin half of \`${name}\` did not compile:\n\n` +
                    result.diagnostics.map((d) => `${d.severity}[${d.code}]: ${d.message}`).join("\n"),
                );
            }
            const actual = traceOf(result.output);

            if (divergence !== undefined) {
                expect(actual).not.toBe(expected);
                return;
            }
            expect(actual).toBe(expected);
        });
    }

    test("every stated divergence names a real case", () => {
        // A divergence entry for a case that no longer exists is a note about a
        // decision nobody can check any more.
        const known = new Set(cases());
        for (const name of Object.keys(DIVERGENCES)) {
            expect({name, known: known.has(name)}).toEqual({name, known: true});
        }
    });
});

function findExecutable(bin: string, name: string): string {
    for (const candidate of [
        join(bin, `${name}.exe`),
        join(bin, name),
        join(bin, "Release", `${name}.exe`),
        join(bin, "Debug", `${name}.exe`),
    ]) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`the C++ half of \`${name}\` was not built into ${bin}`);
}
