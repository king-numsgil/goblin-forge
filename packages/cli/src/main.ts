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

import { compile, type CompileOptions, formatAll, useRuntimeFiles } from "goblin-forge";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { materialise } from "./assets.ts";

const VERSION = "0.1.0";

/**
 * What a build script exports.
 *
 * `CompileOptions` minus the two the tool supplies: `root`, which is the
 * script's own directory, and `tsconfig`, which defaults to the one beside it.
 */
export type BuildConfig = Omit<CompileOptions, "root"> & {
    readonly root?: string;
};

/** A build script may export the config, or a function that produces it. */
type BuildModule = {
    default?: BuildConfig | (() => BuildConfig | Promise<BuildConfig>);
};

const HELP = `goblin-forge ${VERSION} — a TypeScript subset, compiled to native code

USAGE
  goblin-forge [script]        build using a script's default export
  goblin-forge init [dir]      start a project here
  goblin-forge --help          this
  goblin-forge --version       print the version

The script defaults to ./build.ts. Paths inside it resolve against the script's
own directory, not the working directory.

EXAMPLE
  // build.ts
  export default {
    entry: "./src/main.ts",
    output: "./bin/app",
    type: "bin",              // or "static-lib" / "shared-lib"
    optLevel: "speed",        // "none" | "speed" | "size"
  };
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
 * Where extracted files live.
 *
 * Per user rather than per project: the runtime crate is the same for every
 * project this binary builds, and a `target/` directory per project would
 * rebuild the runtime for each one.
 */
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
    const result = await compile({
        ...config,
        root,
        // A project's tsconfig sits beside its build script unless it says
        // otherwise, which is true of every layout anybody actually writes.
        tsconfig: config.tsconfig ?? join(root, "tsconfig.json"),
    });

    if (!result.ok) {
        process.stderr.write(formatAll(result.diagnostics, {color: true, cwd: root}));
        return 1;
    }
    process.stdout.write(`built ${result.output}\n`);
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
    const written: string[] = [`${PROJECT_DIR}/global.d.ts`, `${PROJECT_DIR}/tsconfig.base.json`];

    const seed = (relative: string, contents: string): void => {
        const path = join(root, relative);
        if (existsSync(path)) {
            return;
        }
        mkdirSync(dirname(path), {recursive: true});
        writeFileSync(path, contents, "utf8");
        written.push(relative);
    };

    seed(
        "tsconfig.json",
        `${JSON.stringify(
            {
                extends: `./${PROJECT_DIR}/tsconfig.base.json`,
                // Both named explicitly, and `files` rather than `include`: the prelude
                // has to be *in* the program for the globals to resolve, and the editor
                // reads this file and nothing else.
                files: [`./${PROJECT_DIR}/global.d.ts`, "./src/main.ts"],
            },
            null,
            2,
        )}\n`,
    );

    seed(
        "build.ts",
        `export default {
    entry: "./src/main.ts",
    output: "./bin/app",
    type: "bin",
    optLevel: "speed",
};
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
