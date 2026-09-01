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
    // The script path is quoted for the Windows shell, which joins arguments
    // with spaces and no quoting of its own — a checkout under a path with a
    // space in it would otherwise hand build.ts to bun cut in half. See
    // `forShell` in `packages/runtime/src/build.ts` for the same reasoning in
    // the runtime build.
    const script = join(REPO, "packages", "cli", "build.ts");
    const args = process.platform === "win32" && /\s/.test(script) ? [`"${script}"`] : [script];
    const build = spawnSync("bun", ["run", ...args], {
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
        // Not merely *a* version: the one the package claims. `main.ts` holds
        // its own `VERSION` constant — the executable is bundled, so it cannot
        // read a `package.json` at run time — and a constant that duplicates a
        // manifest is a constant that drifts from it. It is also the name of
        // the on-disk cache directory, so a bump nobody made in both places
        // would keep serving the previous release's cache.
        const manifest: unknown = JSON.parse(
            readFileSync(join(REPO, "packages", "cli", "package.json"), "utf8"),
        );
        const version =
            typeof manifest === "object" && manifest !== null && "version" in manifest
                ? manifest.version
                : undefined;
        if (typeof version !== "string") {
            throw new Error("packages/cli/package.json declares no version");
        }
        const declared: string = version;
        expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
        expect(run(workspace, "--version").stdout.trim()).toBe(declared);

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

    /**
     * Two configs, because one cannot be right for both files.
     *
     * An editor gives a file the nearest `tsconfig.json` above it and looks for
     * nothing else, so a single config at the root is the answer for the program
     * *and* for the build script. The program is checked under `noLib` against
     * the Goblin prelude; a build script is ordinary TypeScript. Sharing one
     * leaves whichever lost underlined in red while the build succeeds — the
     * failure `.goblin/` exists to prevent, arrived at from the other side.
     */
    test("the program and the build script each get a config that suits them", () => {
        const program = JSON.parse(readFileSync(join(dir, "src", "tsconfig.json"), "utf8"));
        expect(program.extends).toBe("../.goblin/tsconfig.base.json");
        // Named in `files`, not just `include`: nothing imports the prelude, so
        // `include` alone would never find it and every global would go
        // unresolved in the editor while the compiler added it anyway.
        expect(program.files).toEqual(["../.goblin/global.d.ts"]);

        const script = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8"));
        expect(script.compilerOptions.noLib).toBeUndefined();
        expect(script.include).toEqual(["*.ts"]);
        // The one thing a fresh project cannot do for itself: `@types/bun` is not
        // installed, and TypeScript does not pick it up without being told even
        // once it is. The note is the only place that says so.
        expect(JSON.stringify(script["//"])).toContain("@types/bun");
    });

    /**
     * A build script is the one file in a project tsserver otherwise knows
     * nothing about: the tsconfig covers `src/`, and a build script is not
     * source. So the type it is checked against has to arrive some other way,
     * and a reference line is the way that needs no configuration at all.
     */
    test("a build script gets its own type, and the seeded one uses it", () => {
        expect(readFileSync(join(dir, ".goblin", "build.d.ts"), "utf8")).toBe(
            readFileSync(join(REPO, "packages", "runtime", "build-config.d.ts"), "utf8"),
        );

        const script = readFileSync(join(dir, "build.ts"), "utf8");
        expect(script).toContain(`/// <reference path="./.goblin/build.d.ts" />`);
        // `satisfies` rather than an annotation: it checks the object without
        // widening it, so the literal keeps its exact types and an unknown key
        // is an error rather than being quietly ignored.
        expect(script).toContain("satisfies GoblinBuild;");
    });

    test("a build refreshes the build script's type, not just `init`", () => {
        // The same reason the prelude is rewritten every run: a stale copy
        // describes a compiler that is no longer the one about to run, and the
        // symptom is an editor disagreeing with a build that succeeds.
        const path = join(dir, ".goblin", "build.d.ts");
        writeFileSync(path, "declare type GoblinBuild = { stale: true };\n", "utf8");
        const result = run(dir);
        expect(result.status).toBe(0);
        expect(readFileSync(path, "utf8")).toBe(
            readFileSync(join(REPO, "packages", "runtime", "build-config.d.ts"), "utf8"),
        );
    }, TIMEOUT);

    test("seeds a project that builds without being edited", () => {
        const result = run(dir);
        expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});
        expect(result.stdout).toContain("built");
    }, TIMEOUT);

    test("a build says what it is doing while it does it", () => {
        // On stdout beside the result, not on stderr: a successful build says
        // nothing on stderr, which the assertions above rely on and which is what
        // makes stderr worth reading when something does go wrong.
        const result = run(dir);
        expect(result.stderr).toBe("");
        for (const phase of ["checking types", "lowering to MIR", "generating code", "linking"]) {
            expect(result.stdout).toContain(phase);
        }
        // The one that justifies the feature: a cold cache spends a minute here
        // compiling mimalloc, and silence through it reads as a hang.
        expect(result.stdout).toContain("building the runtime");
        // Each phase carries its own duration, and the result line the total.
        expect(result.stdout).toMatch(/checking types… \d+(\.\d+)? m?s/);
        expect(result.stdout).toMatch(/^built .* in \d+(\.\d+)? m?s$/m);
    }, TIMEOUT);

    test("`--quiet` leaves only the result", () => {
        const result = run(dir, "--quiet");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("built");
        expect(result.stdout).not.toContain("checking types");
        expect(result.stdout).not.toContain("building the runtime");
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

    test("a machine without the tools is told before anything is compiled", () => {
        // The whole point is the timing. Emptying `PATH` takes clang, cargo and
        // the linker away at once, and the build has to answer immediately
        // rather than after a type-check it cannot use.
        const result = spawnSync(EXE, ["build.ts"], {
            cwd: dir,
            encoding: "utf8",
            env: {...process.env, PATH: ""},
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("GF0006");
        expect(result.stderr).toContain("clang");
        // Not a phase that ran and failed — a build that never started.
        expect(result.stdout).not.toContain("checking types");
    });

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

    test("a project whose config is still at the root builds unchanged", () => {
        // The layout every project written before `src/tsconfig.json` existed
        // has. The default looks there first and falls back here, so an upgrade
        // does not require moving a file — and a project whose sources are not
        // under `src/` never has to.
        const old = project("old-layout");
        run(old, "init");
        rmSync(join(old, "src", "tsconfig.json"), {force: true});
        writeFileSync(
            join(old, "tsconfig.json"),
            `${JSON.stringify({
                extends: "./.goblin/tsconfig.base.json",
                files: ["./.goblin/global.d.ts"],
                include: ["src/**/*.ts"],
            })}\n`,
        );
        writeFileSync(join(old, "src", "main.ts"), "export function main(): i32 { return 5; }\n");

        const result = run(old, "build.ts");
        expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});
        const exe = join(old, "bin", process.platform === "win32" ? "app.exe" : "app");
        expect(spawnSync(exe, [], {encoding: "utf8"}).status).toBe(5);
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

/**
 * `systemLib`, from inside a build script.
 *
 * A global rather than an import, because a project has no `node_modules` for an
 * import to resolve against — the executable is the toolchain. The unit tests in
 * `system-lib.test.ts` cover what it finds; these two cover that a build script
 * can reach it at all, and that a failure to find something is reported as a
 * build script problem rather than as a crash.
 */
describe("`systemLib`", () => {
    test("a build script can call it, and it finds what is there", () => {
        const dir = project("system-lib");
        run(dir, "init");

        const shared = process.platform === "win32"
            ? "fake.lib"
            : process.platform === "darwin"
              ? "libfake.dylib"
              : "libfake.so";
        mkdirSync(join(dir, "libs"), {recursive: true});
        writeFileSync(join(dir, "libs", shared), "");

        // Written out rather than linked: an empty file is a library the linker
        // would reject, and what is being tested is the lookup rather than the
        // link.
        writeFileSync(
            join(dir, "build.ts"),
            `import { writeFileSync } from "node:fs";
       import { join } from "node:path";

       writeFileSync(
         join(import.meta.dir, "found.txt"),
         systemLib("fake", { search: [join(import.meta.dir, "libs")] }),
       );

       export default { entry: "./src/main.ts", output: "./bin/app" };\n`,
        );

        const result = run(dir, "build.ts");
        expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});
        expect(readFileSync(join(dir, "found.txt"), "utf8")).toBe(join(dir, "libs", shared));
    }, TIMEOUT);

    test("a library that is not there fails the build script, with what it tried", () => {
        const dir = project("system-lib-missing");
        run(dir, "init");
        writeFileSync(
            join(dir, "build.ts"),
            `export default {
         entry: "./src/main.ts",
         output: "./bin/app",
         nativeLibs: [systemLib("nonesuch-xyz")],
       };\n`,
        );

        const result = run(dir, "build.ts");
        // A config that cannot be built is a usage failure, not a compile one,
        // and the message has to be enough to fix it without reading the source.
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("nonesuch-xyz");
        expect(result.stderr).toContain("GOBLIN_LIB_PATH");
        expect(result.stdout).not.toContain("checking types");
    });
});

/**
 * What a build script could not say before.
 *
 * `compile` is a function, so a script that calls it can do what it likes on
 * either side of the call. A script that *exports* a config had nowhere to put
 * that, and the workaround — shelling out from the script's top level — ran on
 * load, before the tool had looked at the config at all.
 */
describe("`before` and `after`", () => {
    let dir: string;
    let exe: string;

    beforeAll(() => {
        dir = project("hooks");
        run(dir, "init");
        exe = join(dir, "bin", process.platform === "win32" ? "app.exe" : "app");

        // The entry imports a module that does not exist yet. That is the
        // assertion: `before` runs ahead of the *typecheck*, not merely ahead of
        // the link, so a generated source file is generated in time to be
        // checked rather than in time to be missed.
        writeFileSync(
            join(dir, "src", "main.ts"),
            `import { seven } from "./generated.ts";

       export function main(): i32 { return seven(); }\n`,
        );

        writeFileSync(
            join(dir, "build.ts"),
            `import { writeFileSync } from "node:fs";
       import { join } from "node:path";

       const here = import.meta.dir;

       function generate(): void {
         writeFileSync(join(here, "src", "generated.ts"), "export function seven(): i32 { return 7; }\\n");
         writeFileSync(join(here, "steps.txt"), "first\\n");
       }

       export default {
         entry: "./src/main.ts",
         output: "./bin/app",
         before: [generate, "echo second >> steps.txt"],
         after: [
           "echo $GOBLIN_OUTPUT > output.txt",
           (output: string) => { writeFileSync(join(here, "after.txt"), output); },
         ],
       };\n`,
        );
    });

    test("a step is a function or a command, and a list of them runs in order", () => {
        const result = run(dir, "build.ts");
        expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});

        // The generated module reached the compiler: the program returns what
        // only the `before` step could have written.
        expect(spawnSync(exe, [], {encoding: "utf8"}).status).toBe(7);

        // Sequential, not concurrent. A list in a file reads as an order, and
        // the ordinary case is a step that consumes what the one before it
        // wrote — the second command appends to a file the first one truncates,
        // so a race would show up as "second\n" alone.
        expect(readFileSync(join(dir, "steps.txt"), "utf8")).toBe("first\nsecond\n");
    }, TIMEOUT);

    test("`after` is handed the artefact's path, which the config cannot spell", () => {
        // `output` in the config is "./bin/app": no directory, no extension, and
        // which extension gets added is the platform's business. Both forms get
        // the real thing — a function as an argument, a command in its
        // environment.
        expect(readFileSync(join(dir, "output.txt"), "utf8").trim()).toBe(exe);
        expect(readFileSync(join(dir, "after.txt"), "utf8")).toBe(exe);
    });

    test("the steps are announced, and `after` runs under the result line", () => {
        const result = run(dir, "build.ts");
        // A named function is named; a command is quoted, so a line of shell
        // reads as a quotation rather than as the tool's own words.
        expect(result.stdout).toContain("before generate()…");
        expect(result.stdout).toContain("after `echo $GOBLIN_OUTPUT > output.txt`…");
        // Where the artefact landed is the answer somebody is waiting for, so it
        // is printed before an `after` step gets the chance to print a page of
        // its own.
        expect(result.stdout.indexOf("built ")).toBeLessThan(result.stdout.indexOf("after `"));
    }, TIMEOUT);

    test("`--quiet` drops the announcements, not the steps", () => {
        rmSync(join(dir, "output.txt"), {force: true});
        const result = run(dir, "build.ts", "--quiet");
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain("before generate()");
        // Quiet is about this tool's own narration. A step's output is the
        // user's own program talking, and suppressing it would be suppressing
        // the thing they asked for.
        expect(readFileSync(join(dir, "output.txt"), "utf8").trim()).toBe(exe);
    }, TIMEOUT);

    test("a failing `before` step stops the build before anything is compiled", () => {
        const failing = project("before-fails");
        run(failing, "init");
        writeFileSync(
            join(failing, "build.ts"),
            `export default {
         entry: "./src/main.ts",
         output: "./bin/app",
         before: "bun -e 'process.exit(3)'",
       };\n`,
        );

        const result = run(failing, "build.ts");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("exited 3");
        // The compiler printed nothing because it never ran, and silence there
        // is indistinguishable from a compiler that had nothing to say.
        expect(result.stderr).toContain("Nothing was compiled.");
        expect(result.stdout).not.toContain("checking types");
        expect(existsSync(join(failing, "bin"))).toBe(false);
    }, TIMEOUT);

    test("a failing `after` step leaves the artefact, and still fails the build", () => {
        const failing = project("after-fails");
        run(failing, "init");
        writeFileSync(
            join(failing, "build.ts"),
            `export default {
         entry: "./src/main.ts",
         output: "./bin/app",
         after: "bun -e 'process.exit(4)'",
       };\n`,
        );

        const result = run(failing, "build.ts");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("exited 4");
        // The file really was built, and saying otherwise would send somebody
        // looking for a compiler error that does not exist. What failed is the
        // build, not the compile.
        expect(result.stdout).toContain("built ");
        expect(
            existsSync(join(failing, "bin", process.platform === "win32" ? "app.exe" : "app")),
        ).toBe(true);
    }, TIMEOUT);
});
