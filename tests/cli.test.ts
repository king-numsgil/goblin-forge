/**
 * The single-file executable.
 *
 * `bun build --compile` puts the compiler, the Bun runtime, the native backend
 * and the language's own files into one binary. What that mostly tests is
 * whether the things the compiler reads off disk can still be found when there
 * is no disk to read them from:
 *
 * * the **native addon** — napi's loader searches the filesystem beside itself
 *   and there is no "beside itself", so the CLI replaces that search;
 * * the **prelude** — tsc reads it, and it has to still be called `global.d.ts`,
 *   because a file that is not a declaration file stops being skipped by the
 *   lowerer and every `declare function` in it becomes an `extern "C"` import;
 * * the **runtime crate** — cargo is handed a directory and wants a real one.
 *
 * These tests build the executable once and then drive it as a user would, from
 * a directory that knows nothing about this repository.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EXE = join(REPO, "bin", process.platform === "win32" ? "goblin-forge.exe" : "goblin-forge");

/** Compiling a real program through cargo and a linker is not quick. */
const TIMEOUT = 300_000;

let workspace: string;

beforeAll(() => {
    const build = spawnSync("bun", ["run", join(REPO, "packages", "cli", "build.ts")], {
        cwd: REPO,
        encoding: "utf8",
        shell: process.platform === "win32",
    });
    if (build.status !== 0) {
        throw new Error(`could not build the executable:\n${build.stdout ?? ""}${build.stderr ?? ""}`);
    }
    workspace = mkdtempSync(join(tmpdir(), "goblin-cli-"));
}, TIMEOUT);

afterAll(() => {
    rmSync(workspace, {recursive: true, force: true});
});

/** Run the executable in a directory, and report everything it did. */
function run(cwd: string, ...args: string[]) {
    const result = spawnSync(EXE, args, {cwd, encoding: "utf8"});
    if (result.error) {
        throw result.error;
    }
    return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        status: result.status ?? -1,
    };
}

/** A fresh project directory, outside this repository. */
function project(name: string): string {
    const dir = join(workspace, name);
    mkdirSync(dir, {recursive: true});
    return dir;
}

describe("the executable", () => {
    test("reports a version and a usage message", () => {
        expect(run(workspace, "--version").stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);

        const help = run(workspace, "--help");
        expect(help.status).toBe(0);
        expect(help.stdout).toContain("export default");
    });

    test("says so when there is no build script, rather than doing nothing", () => {
        const result = run(project("empty"));
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("no build script");
    });
});

describe("`init`", () => {
    let dir: string;

    beforeAll(() => {
        dir = project("init");
        const result = run(dir, "init");
        expect(result.status).toBe(0);
    });

    test("writes the language's own files into the project", () => {
        // For the editor rather than the compiler: tsserver reads the project's
        // tsconfig and nothing else, so a prelude that exists only inside the
        // executable leaves `i32` underlined while the build succeeds.
        expect(existsSync(join(dir, ".goblin", "global.d.ts"))).toBe(true);
        expect(existsSync(join(dir, ".goblin", "tsconfig.base.json"))).toBe(true);
        expect(readFileSync(join(dir, ".goblin", "global.d.ts"), "utf8")).toContain("declare function move");
    });

    test("the prelude it writes is the one this repository ships", () => {
        expect(readFileSync(join(dir, ".goblin", "global.d.ts"), "utf8")).toBe(
            readFileSync(join(REPO, "packages", "runtime", "global.d.ts"), "utf8"),
        );
    });

    test("seeds a project that builds without being edited", () => {
        const result = run(dir);
        expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});
        expect(result.stdout).toContain("built");
    }, TIMEOUT);

    test("a stale project prelude is refreshed by a build, not obeyed", () => {
        // The project's copy is the compiler's file rather than the user's, and it
        // wins over the embedded one so that the editor and the build agree. That
        // makes a stale copy silently shadow an upgrade: the build would fail on a
        // global the executable knows about, with a message from tsc about a
        // language it is no longer describing.
        writeFileSync(join(dir, ".goblin", "global.d.ts"), "// stale\n", "utf8");
        const result = run(dir);
        expect(result.status).toBe(0);
        expect(readFileSync(join(dir, ".goblin", "global.d.ts"), "utf8")).toContain(
            "declare function alloc",
        );
    }, TIMEOUT);

    test("does not overwrite what is already there", () => {
        writeFileSync(join(dir, "src", "main.ts"), "// mine\nexport function main(): i32 { return 7; }\n");
        run(dir, "init");
        expect(readFileSync(join(dir, "src", "main.ts"), "utf8")).toContain("// mine");
    });
});

describe("building", () => {
    let dir: string;

    beforeAll(() => {
        dir = project("build");
        run(dir, "init");
    });

    test("a program compiles and the binary runs", () => {
        writeFileSync(
            join(dir, "src", "main.ts"),
            `class Greeter {
         name: string = "world";
         static shout(s: string): string { return s + "!"; }
         greet(): string { return \`hello, \${this.name}\`; }
       }

       export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         xs.push(4);
         const g = new Greeter();
         console.log(Greeter.shout(g.greet()));
         console.log(\`\${xs.length} items, last = \${xs.pop()}\`);
         return 0;
       }\n`,
        );

        const built = run(dir, "build.ts");
        expect({status: built.status, stderr: built.stderr}).toEqual({status: 0, stderr: ""});

        const exe = join(dir, "bin", process.platform === "win32" ? "app.exe" : "app");
        const program = spawnSync(exe, [], {encoding: "utf8"});
        expect(program.stdout).toBe("hello, world!\n4 items, last = 4\n");
        expect(program.status).toBe(0);
    }, TIMEOUT);

    test("a program that does not compile is an error, with a caret", () => {
        writeFileSync(
            join(dir, "src", "main.ts"),
            `export function main(): i32 {
         const a: i32 = 1;
         const b: u32 = 2;
         return a + b;
       }\n`,
        );

        const result = run(dir, "build.ts");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("GF0161");
        expect(result.stderr).toContain("src/main.ts");
    }, TIMEOUT);

    test("relative paths resolve against the script, not the working directory", () => {
        // The footgun the `export default` shape removes. Run from the parent, and
        // the output still lands beside the script rather than beside the shell.
        writeFileSync(
            join(dir, "src", "main.ts"),
            `export function main(): i32 { return 3; }\n`,
        );
        const result = run(workspace, join(dir, "build.ts"));
        expect(result.status).toBe(0);
        expect(existsSync(join(dir, "bin"))).toBe(true);
    }, TIMEOUT);

    test("a script may export a function, evaluated for its config", () => {
        const dynamic = project("dynamic");
        run(dynamic, "init");
        writeFileSync(
            join(dynamic, "build.ts"),
            `export default () => ({
         entry: "./src/main.ts",
         output: "./bin/dynamic",
         type: "bin",
       });\n`,
        );
        const result = run(dynamic, "build.ts");
        expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});
        expect(result.stdout).toContain("dynamic");
    }, TIMEOUT);

    test("a script with no default export says what the shape is", () => {
        const bad = project("no-default");
        run(bad, "init");
        writeFileSync(join(bad, "build.ts"), `export const config = { entry: "./src/main.ts" };\n`);
        const result = run(bad, "build.ts");
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("no default export");
        expect(result.stderr).toContain("export default");
    });

    test("a script exporting something that is not a config says so", () => {
        const bad = project("not-a-config");
        run(bad, "init");
        writeFileSync(join(bad, "build.ts"), `export default 42;\n`);
        const result = run(bad, "build.ts");
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("entry");
    });
});
