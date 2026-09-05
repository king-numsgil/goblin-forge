/// <reference path="../../runtime/build-config.d.ts" />

/**
 * `goblin-forge` — the compiler as one executable.
 *
 * A build is still a script and the options are still an object; what changes
 * is who calls `compile`. Instead of importing it and invoking it, a build
 * script *exports* what it wants built:
 *
 * ```ts
 * // build.ts
 * export default {
 *   entry: "./src/main.ts",
 *   output: "./bin/app",
 * };
 * ```
 *
 * ```console
 * $ goblin-forge build.ts
 * built ./bin/app.exe
 * ```
 *
 * Two things fall out of the config being data rather than a call. Relative
 * paths resolve against the **script**, because the tool knows where the script
 * is and the script no longer has to say `root: import.meta.dir` — which was a
 * footgun, since omitting it silently resolved against the working directory.
 * And a script can be read without being trusted to do the right thing with the
 * result: there is one place that reports diagnostics and sets the exit code.
 */

import { $ } from "bun";
import {
    type BuildEvent,
    compile,
    type CompileOptions,
    formatAll,
    systemLib,
    useRuntimeFiles,
} from "goblin-forge";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { materialise } from "./assets.ts";

const VERSION = "0.3.0";

/**
 * What a build script exports.
 *
 * `CompileOptions` minus what the tool supplies: `root` is the script's own
 * directory, `tsconfig` defaults to the one beside it, and `onProgress` is the
 * CLI's — it is overwritten below unless `--quiet`, so advertising it would be
 * a lie.
 */
export type BuildConfig = Omit<CompileOptions, "root" | "tsconfig" | "onProgress"> & {
    readonly root?: string;
    readonly tsconfig?: string;

    /**
     * What to run before the compiler, in order.
     *
     * The thing a build script could not say. `compile` is a function, so a
     * script that calls it can do whatever it likes on either side of the call;
     * a script that *exports* a config had nowhere to put that, and the answer
     * was to shell out from the script's top level — which ran on load, before
     * the tool had decided whether the config was even valid.
     */
    readonly before?: BuildStep | readonly BuildStep[];

    /** What to run after a build that produced something, in order. */
    readonly after?: AfterStep | readonly AfterStep[];
};

/**
 * One thing to run around a build: a command line, or a function.
 *
 * A string goes to **Bun's own shell**, not the platform's. That is what makes
 * `&&`, a pipe, a glob and `$VAR` mean the same thing on every machine this
 * compiler runs on, and it is the only choice that holds for a single-file
 * executable — the shell is inside the binary, so a step does not depend on
 * what `sh` the machine has, or on `cmd.exe` reading the line differently.
 *
 * A function is called in this process. It is the form for a step that is a few
 * lines of TypeScript rather than a program somebody already wrote, and it is
 * why `before`/`after` are the tool's fields rather than the compiler's:
 * `compile` is a library and does not run other people's code.
 */
export type BuildStep = string | (() => void | Promise<void>);

/**
 * The same, for a step that runs once the artefact exists.
 *
 * Handed the absolute path of what was built — as an argument to a function,
 * and as `$GOBLIN_OUTPUT` to a command. That path is the one thing a post-build
 * step reliably wants and the one thing the config cannot spell: `output` there
 * carries no extension, and which one gets added is the target's business and
 * the platform's.
 */
export type AfterStep = string | ((output: string) => void | Promise<void>);

/**
 * The editor's copy of that type and this one are the same shape.
 *
 * `packages/runtime/build-config.d.ts` declares `GoblinBuild`, which is written
 * into a project's `.goblin/` and is what a build script's `satisfies` names.
 * It is a hand-written mirror of the type above, so the only thing stopping the
 * two from drifting is this check — a field added to `CompileOptions` and not
 * to the declaration, or a value spelled differently in one, fails
 * `bun run typecheck` rather than silently leaving the editor describing a
 * compiler that no longer exists.
 *
 * Keys *and* assignability, because they catch different mistakes: an added
 * field shows up in the key comparison, and a changed union — a new `optLevel`,
 * say — shows up in the other.
 */
type Assert<T extends true> = T;
type _BuildConfigKeysMatch = Assert<
    [Exclude<keyof BuildConfig, keyof GoblinBuild>] extends [never]
        ? [Exclude<keyof GoblinBuild, keyof BuildConfig>] extends [never]
            ? true
            : false
        : false
>;
type _BuildConfigShapesMatch = Assert<
    GoblinBuild extends BuildConfig ? (BuildConfig extends GoblinBuild ? true : false) : false
>;

/**
 * And the same for the one *value* the declaration promises.
 *
 * `systemLib` is a global as far as a build script is concerned, so the editor
 * learns it from the same hand-written file — and a global that is declared and
 * not injected, or injected with a different signature, is a build script that
 * type-checks and then fails at run time. The import shadows the global inside
 * this module, which is what makes the two nameable in one expression.
 */
type _SystemLibShapeMatches = Assert<
    typeof systemLib extends typeof globalThis.systemLib
        ? typeof globalThis.systemLib extends typeof systemLib
            ? true
            : false
        : false
>;

/** A build script may export the config, or a function that produces it. */
type BuildModule = {
    default?: BuildConfig | (() => BuildConfig | Promise<BuildConfig>);
};

const HELP = `goblin-forge ${VERSION} — a TypeScript subset, compiled to native code

USAGE
  goblin-forge [script]        build using a script's default export
  goblin-forge init [dir]      start a project here
  goblin-forge --quiet         build without the per-phase progress
  goblin-forge --help          this
  goblin-forge --version       print the version

The script defaults to ./build.ts. Paths inside it resolve against the script's
own directory, not the working directory.

EXAMPLE
  // build.ts
  /// <reference path="./.goblin/build.d.ts" />
  export default {
    entry: "./src/main.ts",
    output: "./bin/app",
    type: "bin",              // or "static-lib" / "shared-lib"
    optLevel: "O2",           // "O0" | "O1" | "O2" | "O3" | "Os" | "Oz"

    before: "bun run codegen",          // a command, or a function
    after: (output) => strip(output),   // and either may be a list
  } satisfies GoblinBuild;

\`systemLib("SDL3")\` is available to a build script without an import, and gives
\`nativeLibs\` the path to a library the machine already has — asking pkg-config
and the C compiler before guessing at directories, and spelling the file the way
the platform spells it.

A \`before\` step runs before the compiler and a failing one stops the build; an
\`after\` step runs once the artefact exists and is handed its absolute path, as
an argument to a function and as \`$GOBLIN_OUTPUT\` to a command. Commands go to
Bun's own shell, so a pipe, a glob and \`&&\` mean the same thing everywhere.

The reference line and the \`satisfies\` are optional — a build script without
them builds the same. They are what gives an editor completion on the fields and
their values; \`.goblin/build.d.ts\` is written by \`init\` and refreshed by every
build, so it always describes the compiler that is about to run.
`;

/**
 * Where a project keeps its copy of the language.
 *
 * `init` writes the prelude and the tsconfig base here, and the reason is the
 * editor rather than the compiler: tsserver reads the project's tsconfig and
 * nothing else, so a prelude that exists only inside this executable leaves
 * `i32` underlined in red while the build succeeds. An editor that disagrees
 * with the compiler is worse than no editor support.
 *
 * When it exists the compiler uses *these* copies rather than its own, so the
 * two cannot drift — and so that the program does not end up with two preludes
 * declaring the same globals.
 */
const PROJECT_DIR = ".goblin";

/**
 * How a build script reaches its own type.
 *
 * A reference line rather than an import, because a build script is not part of
 * the project's tsconfig — that covers `src/`, and a build script is not source
 * — so there is no program for a module import to resolve inside. A reference
 * pulls the declaration in on its own, which works in a bare editor with no
 * configuration at all.
 */
const BUILD_REFERENCE = `/// <reference path="./${PROJECT_DIR}/build.d.ts" />`;

/**
 * Where extracted files live.
 *
 * Per user rather than per project: the runtime crate is the same for every
 * project this binary builds, and a `target/` directory per project would
 * rebuild the runtime for each one.
 */
/**
 * A duration, in the unit a person would have used.
 *
 * Milliseconds up to a second, then seconds — because "1400 ms" and "1.4 s" are
 * the same number and only one of them is read at a glance.
 */
function duration(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** What a phase is called, for somebody watching rather than reading the source. */
function phaseLabel(event: BuildEvent): string {
    switch (event.phase) {
        case "check":
            return "checking types";
        case "lower":
            return "lowering to MIR";
        case "codegen":
            return "generating code";
        case "header":
            return "writing the C header";
        case "runtime":
            // Worth distinguishing: the shared one is the build that leaves a
            // second file behind, and seeing it here is the first hint of that.
            return event.detail === "shared"
                ? "building the shared runtime"
                : "building the runtime";
        case "link":
            // An archive is genuinely not a link — nothing is resolved and no
            // runtime is pulled in — and this is the one moment somebody is
            // watching to find out what happened, so it says which it was.
            if (event.detail === "static-lib") {
                return "archiving";
            }
            return event.detail === "shared-lib" ? "linking the shared library" : "linking";
    }
}

/**
 * One line per phase: the name before the work, the duration after it.
 *
 * The name goes out *unterminated*, so the wait a phase causes happens under
 * its own label rather than before it. A cold cache spends a minute inside
 * `building the runtime`, and that minute is the whole reason this exists —
 * silence there is indistinguishable from a hang.
 *
 * No cursor movement and no redrawing, so this reads the same in a terminal, in
 * a pipe and in CI. `compile` guarantees an `end` for every `begin`, including
 * one that throws, so the line is always closed before anything else prints.
 */
function reportProgress(event: BuildEvent): void {
    if (event.kind === "begin") {
        process.stdout.write(`  ${phaseLabel(event)}…`);
    } else {
        process.stdout.write(` ${duration(event.ms)}\n`);
    }
}

/**
 * Run what a build script asked for around the build, and say whether to go on.
 *
 * Sequential, because a list written in a file reads as an order: codegen and
 * the command that consumes what it wrote is the ordinary case, and starting
 * both at once is a race that usually wins. A step that fails ends the run —
 * `before` because compiling sources that a step did not finish producing is
 * worse than not compiling, `after` because a post-build step that failed is a
 * build that did not finish, whatever is sitting on disk.
 *
 * `BuildStep` is assignable to `AfterStep` — a function of no arguments takes a
 * path perfectly well — so one implementation serves both, and `before` is the
 * case where there is no path to give.
 */
async function runSteps(
    when: "before" | "after",
    steps: AfterStep | readonly AfterStep[] | undefined,
    root: string,
    output: string | undefined,
    quiet: boolean,
): Promise<boolean> {
    const list: readonly AfterStep[] =
        steps === undefined
            ? []
            : typeof steps === "string" || typeof steps === "function"
                ? [steps]
                : steps;

    for (const step of list) {
        // Terminated, unlike a phase label, because what follows is the step's
        // own output rather than a wait: a command inherits this terminal and
        // writes to it, and a duration printed after that would be attached to
        // whatever the step happened to say last. The total on the result line
        // covers `before`, which is the number that was worth having.
        if (!quiet) {
            process.stdout.write(`  ${when} ${describe(step)}…\n`);
        }

        const failure = await runStep(step, root, output);
        if (failure !== undefined) {
            process.stderr.write(`goblin-forge: the ${when} step ${describe(step)} ${failure}\n`);
            if (when === "before") {
                // Said out loud: the compiler printed nothing, and silence from
                // it here means it never ran rather than that it had nothing to
                // say.
                process.stderr.write("Nothing was compiled.\n");
            }
            return false;
        }
    }
    return true;
}

/** Run one step, and describe how it failed if it did. */
async function runStep(
    step: AfterStep,
    root: string,
    output: string | undefined,
): Promise<string | undefined> {
    try {
        if (typeof step === "string") {
            const result = await $`${{raw: step}}`
                .cwd(root)
                .env({
                    ...process.env,
                    // Absent rather than empty for a `before` step: a command
                    // that reads it would otherwise be handed "" and act on it,
                    // and there is genuinely no artefact yet.
                    ...(output === undefined ? {} : {GOBLIN_OUTPUT: output}),
                })
                .nothrow();
            return result.exitCode === 0 ? undefined : `exited ${result.exitCode}`;
        }
        await step(output ?? "");
        return undefined;
    } catch (error) {
        // The stack, not just the message: a step is the user's own code, and
        // this is the only place it is reported.
        return `threw\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    }
}

/** What a step is called, for somebody reading the line rather than parsing it. */
function describe(step: AfterStep): string {
    // Backticks around a command, so the line reads as a quotation rather than
    // as this tool's own words when the command contains a sentence's worth of
    // shell.
    if (typeof step === "string") {
        return `\`${step}\``;
    }
    // An arrow written straight into the config has no name at all, and `()` on
    // its own reads worse than saying what it is.
    return step.name === "" ? "an inline function" : `${step.name}()`;
}

/**
 * Which config the *program* is checked against, when the script does not say.
 *
 * `src/tsconfig.json` first, because that is where `init` puts it and why: a
 * build script and a Goblin program cannot share one config, an editor gives a
 * file the nearest `tsconfig.json` above it, and so the root has to belong to
 * the build script.
 *
 * The root is still the answer when there is nothing under `src/` — a project
 * written before that was true keeps building, and one whose sources are
 * somewhere else names its config itself.
 */
function defaultTsconfig(root: string): string {
    const beside = join(root, "src", "tsconfig.json");
    return existsSync(beside) ? beside : join(root, "tsconfig.json");
}

function cacheRoot(): string {
    const base =
        process.env["GOBLIN_CACHE"] ??
        (process.platform === "win32"
            ? (process.env["LOCALAPPDATA"] ?? tmpdir())
            : join(homedir(), ".cache"));
    const root = join(base, "goblin-forge", VERSION);
    mkdirSync(root, {recursive: true});
    return root;
}

async function main(argv: readonly string[]): Promise<number> {
    const args = argv.filter((arg) => arg !== "--");
    if (args.includes("--help") || args.includes("-h")) {
        process.stdout.write(HELP);
        return 0;
    }
    if (args.includes("--version") || args.includes("-v")) {
        process.stdout.write(`${VERSION}\n`);
        return 0;
    }

    // Progress is on by default: the slowest phase is a cargo build that can
    // run for a minute on a cold cache, and a tool that says nothing through it
    // is a tool you assume has hung. `--quiet` is for a script that wants only
    // the result line.
    const quiet = args.includes("--quiet") || args.includes("-q");

    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (positional[0] === "init") {
        return init(resolve(positional[1] ?? "."));
    }

    if (positional.length > 1) {
        process.stderr.write(`goblin-forge: expected one build script, got ${positional.length}\n`);
        return 2;
    }

    const script = resolve(positional[0] ?? "build.ts");
    if (!existsSync(script)) {
        process.stderr.write(
            `goblin-forge: no build script at ${script}\n` +
            `Write one, or name a different file. \`goblin-forge --help\` shows the shape.\n`,
        );
        return 2;
    }

    const config = await load(script);
    if (config === undefined) {
        return 2;
    }

    const root = config.root ?? dirname(script);

    // The compiler's own files are inside this binary, not on disk beside it —
    // except where the project has its own copies, which `init` writes and the
    // editor reads. Preferring those is not a nicety: adding a second prelude to
    // the program would declare every global twice.
    const local = join(root, PROJECT_DIR);
    if (existsSync(join(local, "global.d.ts"))) {
        // **Refreshed, not just read.** The project's copy is the compiler's file
        // rather than the user's, and a stale one silently shadows an upgrade: the
        // build fails on a global that the executable does in fact know about, with
        // a message from tsc about a language it is no longer describing. Writing
        // it back costs nothing — `materialise` only touches what differs.
        const files = materialise(local);
        useRuntimeFiles({...files, runtimeCrate: materialise(cacheRoot()).runtimeCrate});
    } else {
        useRuntimeFiles(materialise(cacheRoot()));
    }
    // The two fields the compiler is not given: `compile` writes nothing and
    // runs nothing, and these are the tool's job precisely because of that.
    const {before, after, ...options} = config;

    // Started before the `before` steps rather than after them, because the
    // number on the result line is how long the invocation took and a codegen
    // step that takes four seconds is four seconds somebody waited.
    const started = performance.now();

    // Before the compiler rather than merely before the link: the ordinary
    // `before` step writes a source file, and a source file that appears after
    // the typecheck is a source file nothing checked.
    if (!(await runSteps("before", before, root, undefined, quiet))) {
        return 1;
    }

    const result = await compile({
        ...options,
        root,
        tsconfig: config.tsconfig ?? defaultTsconfig(root),
        ...(quiet ? {} : {onProgress: reportProgress}),
    });

    if (!result.ok) {
        // Terminated here rather than by the formatter: `formatAll` returns text
        // and lets the caller decide, which is right for a library and leaves
        // the shell prompt on the same line as the last caret if nobody does it.
        process.stderr.write(`${formatAll(result.diagnostics, {color: true, cwd: root})}\n`);
        return 1;
    }
    process.stdout.write(`built ${result.output} in ${duration(performance.now() - started)}\n`);
    // Said out loud, because it is the one build where the output path is not
    // the whole answer to "what do I ship?".
    if (result.runtimeImage !== undefined) {
        process.stdout.write(`  with ${result.runtimeImage}, which has to stay beside it\n`);
    }
    // Not needed to *run* — needed to link against, which is a different
    // audience and worth a different sentence.
    if (result.runtimeImportLibrary !== undefined) {
        process.stdout.write(`  and ${result.runtimeImportLibrary}, which a consumer links\n`);
    }

    // After the result line, not before it: what the artefact is and where it
    // landed is the answer somebody is waiting for, and an `after` step that
    // prints a page of its own should print it under that answer rather than
    // push it off the screen. A step that fails here does not unsay the line —
    // the artefact really was built — it only means the build did not finish.
    if (!(await runSteps("after", after, root, result.output, quiet))) {
        return 1;
    }
    return 0;
}

/**
 * Start a project: the language's own files, and the three a project needs.
 *
 * Nothing already there is overwritten. `init` in a directory that has a
 * `src/main.ts` should refresh the prelude and leave the program alone.
 */
function init(root: string): number {
    const files = materialise(join(root, PROJECT_DIR));
    const written: string[] = [
        `${PROJECT_DIR}/global.d.ts`,
        `${PROJECT_DIR}/build.d.ts`,
        `${PROJECT_DIR}/tsconfig.base.json`,
    ];

    const seed = (relative: string, contents: string): void => {
        const path = join(root, relative);
        if (existsSync(path)) {
            return;
        }
        mkdirSync(dirname(path), {recursive: true});
        writeFileSync(path, contents, "utf8");
        written.push(relative);
    };

    // **The program's config lives under `src/`, not at the root**, and the
    // reason is the file that is *not* a Goblin program: the build script.
    //
    // An editor picks a file's config by walking up from the file, and it does
    // not look for anything but `tsconfig.json`. With one config at the root it
    // is the only answer for both files, and it cannot be right for both: the
    // program is checked under `noLib` against the Goblin prelude, and a build
    // script is ordinary TypeScript that may import `node:path`. A root config
    // that suits the program leaves a build script's imports underlined, which
    // is the same "editor disagrees with the compiler" failure `.goblin/` exists
    // to prevent, arrived at from the other side.
    //
    // Two configs, each owning the directory it is in, is the arrangement that
    // needs no editor feature — no project references, no solution file — and
    // therefore works in every editor rather than in the ones that implement
    // that part of the protocol.
    seed(
        join("src", "tsconfig.json"),
        `${JSON.stringify(
            {
                extends: `../${PROJECT_DIR}/tsconfig.base.json`,
                // The prelude in `files`, unconditionally: it is not reached by any
                // import, so `include` alone would never find it and the globals would
                // go unresolved in the editor. `include` covers the rest — every file
                // beside it, not just the entry point — so a helper module gets
                // tsserver coverage as soon as it exists, not only once `main.ts`
                // imports it.
                files: [
                    `../${PROJECT_DIR}/global.d.ts`,
                ],
                include: [
                    "**/*.ts",
                ],
            },
            null,
            4,
        )}\n`,
    );

    seed(
        "tsconfig.json",
        `${JSON.stringify(
            {
                "//": [
                    "For the build script, which is ordinary TypeScript rather than",
                    "Goblin — the program's own config is src/tsconfig.json.",
                    "",
                    "A build script that uses Bun or node APIs needs their types:",
                    "  bun add -d @types/bun",
                    "and then add \"types\": [\"bun\"] below. Without that line the",
                    "types are not picked up even once they are installed.",
                    "",
                    "`systemLib` needs neither — it is declared by .goblin/build.d.ts",
                    "and provided by the compiler itself.",
                ],
                compilerOptions: {
                    target: "esnext",
                    lib: ["esnext"],
                    module: "preserve",
                    moduleResolution: "bundler",
                    moduleDetection: "force",
                    strict: true,
                    allowImportingTsExtensions: true,
                    skipLibCheck: true,
                    noEmit: true,
                },
                include: [
                    "*.ts",
                ],
            },
            null,
            4,
        )}\n`,
    );

    seed(
        "build.ts",
        `${BUILD_REFERENCE}
export default {
    entry: "./src/main.ts",
    output: "./bin/app",
    type: "bin",
    optLevel: "O2",
} satisfies GoblinBuild;
`,
    );

    seed(
        join("src", "main.ts"),
        `export function main(): i32 {
    console.log("hello from goblin-forge");
    return 0;
}
`,
    );

    process.stdout.write(
        `${written.map((file) => `  ${file}`).join("\n")}\n\n` +
        `Build it with \`goblin-forge\` in ${root === process.cwd() ? "this directory" : root}.\n`,
    );
    void files;
    return 0;
}

/** Import a build script and take its default export. */
async function load(script: string): Promise<BuildConfig | undefined> {
    // What a build script may reach for, put where it can reach it. There is no
    // `node_modules` in a project — this executable is the toolchain — so an
    // import would have nothing to resolve against, and a global is what
    // `.goblin/build.d.ts` already describes to the editor.
    //
    // Before the import rather than after: a config is often computed at the
    // script's top level, and `nativeLibs: [systemLib("SDL3")]` runs there.
    globalThis.systemLib = systemLib;

    let module: BuildModule;
    try {
        module = (await import(pathToFileURL(script).href)) as BuildModule;
    } catch (error) {
        process.stderr.write(
            `goblin-forge: could not load ${script}\n${error instanceof Error ? error.message : String(error)}\n`,
        );
        return undefined;
    }

    const exported = module.default;
    if (exported === undefined) {
        process.stderr.write(
            `goblin-forge: ${script} has no default export.\n` +
            `A build script exports what it wants built:\n\n` +
            `  export default { entry: "./src/main.ts", output: "./bin/app" };\n`,
        );
        return undefined;
    }

    const config = typeof exported === "function" ? await exported() : exported;
    if (typeof config !== "object" || config === null || typeof config.entry !== "string") {
        process.stderr.write(
            `goblin-forge: ${script} exported something that is not a build config.\n` +
            `It needs at least an \`entry\`.\n`,
        );
        return undefined;
    }
    return config;
}

/** Absolute paths are left alone; everything else is the script's business. */
export function resolveAgainst(root: string, path: string): string {
    return isAbsolute(path) ? path : join(root, path);
}

process.exitCode = await main(process.argv.slice(2));
