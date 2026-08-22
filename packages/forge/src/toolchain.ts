/**
 * What a build needs on the machine, checked before it needs it.
 *
 * This compiler produces native code by driving native tools: clang turns the
 * IR the backend emits into an object, cargo builds the runtime for the target,
 * and the platform's own linker or archiver assembles the result. None of them
 * are optional and none of them ship inside this compiler.
 *
 * Without this, a machine with no clang type-checks the whole program, lowers
 * it, and then fails inside the backend with an `InternalError` — a `GF90xx`,
 * which says "the compiler is broken" about a machine that is merely missing a
 * package. The category is wrong and the timing is worse: the answer arrives
 * after the wait rather than instead of it.
 *
 * So the tools are looked for first, all of them, and a build that cannot
 * finish says so before it starts. This is a `PATH` walk and a few `stat`s, not
 * a process per tool — running `clang --version` to find out whether clang
 * exists costs more than the check is worth on every build that was going to
 * work anyway.
 *
 * **Bun is not in the list**, because it cannot be missing: the executable *is*
 * Bun, and a build script run any other way is already running under it. Nor is
 * LLVM, which is not a separate dependency — the backend emits IR as text and
 * hands it to clang, which is the only piece of LLVM a build ever touches
 * (DECISIONS §17).
 */

import type { Diagnostic } from "@goblin-forge/checker";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

import type { OutputKind } from "./compile.ts";

/** One thing a build runs, and what it is for. */
interface Tool {
    /** What to look for: a bare name to find on `PATH`, or a path as given. */
    readonly name: string;

    /** What it does, for somebody who has just been told to install it. */
    readonly what: string;

    /** The variable that names a specific one, where there is one. */
    readonly override?: string;
}

/**
 * The tools this build will run, in the order it will run them.
 *
 * Ordered that way so the message reads as the build would have gone, which is
 * also roughly the order somebody would install them in.
 */
function required(kind: OutputKind): readonly Tool[] {
    const tools: Tool[] = [
        {
            name: process.env["GOBLIN_CLANG"] ?? "clang",
            what: "compiles the LLVM IR the backend emits",
            override: "GOBLIN_CLANG",
        },
        {
            name: "cargo",
            what: "builds the Goblin runtime for your target",
        },
    ];

    // An archive is not a link. Nothing is resolved and no runtime is pulled in,
    // so a `static-lib` never runs the linker and a machine without one can
    // still build it.
    tools.push(
        kind === "static-lib"
            ? {
                  name: process.env["AR"] ?? "ar",
                  what: "bundles the objects into an archive",
                  override: "AR",
              }
            : {
                  // The platform C compiler rather than `ld`, because it is the
                  // thing that knows where the CRT startup files live.
                  name: process.env["CC"] ?? "cc",
                  what: "links the artefact",
                  override: "CC",
              },
    );

    return tools;
}

/**
 * Diagnostics for every tool this build needs and cannot find.
 *
 * All of them, not the first: a machine that is missing clang is usually
 * missing cargo too, and finding that out one build at a time is a worse
 * afternoon than being told once.
 *
 * **Windows is checked less**, deliberately. `link.exe` and `lib.exe` are found
 * through the same registry probing cargo's `cc` crate uses, so they work
 * without a Developer Command Prompt and without being on `PATH` — a `PATH`
 * walk would report them missing on a machine where the build then succeeds,
 * and a check that cries wolf is worse than no check. clang and cargo are
 * ordinary `PATH` lookups there like everywhere else.
 */
export function checkToolchain(kind: OutputKind): Diagnostic[] {
    const missing = required(kind).filter(
        (tool) => !(process.platform === "win32" && isPlatformLinker(tool)) && !found(tool.name),
    );
    if (missing.length === 0) {
        return [];
    }

    const names = missing.map((tool) => `\`${tool.name}\``);
    const one = names.length === 1;
    const list = one
        ? names[0]
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

    return [
        {
            severity: "error",
            code: "GF0006",
            source: "goblin",
            message:
                `this build needs ${list}, and cannot find ${one ? "it" : "them"}:\n` +
                `${missing.map(describe).join("\n")}\n` +
                `Nothing has been compiled. The toolchain is checked before the ` +
                `type-check, so this is the whole failure rather than the first sign of one.`,
        },
    ];
}

/** One line per missing tool: what was looked for, what it is for, and the way out. */
function describe(tool: Tool): string {
    // A name that is already a path was given by whoever set the variable, so
    // "not on PATH" would be answering a question they did not ask.
    const where = isPath(tool.name) ? "no such file" : "not on PATH";
    const override = tool.override === undefined
        ? ""
        : `; \`${tool.override}\` names a specific one`;
    return `  ${tool.name} (${where}) — ${tool.what}${override}`;
}

/** The linker and the archiver, which Windows finds by a route `PATH` cannot see. */
function isPlatformLinker(tool: Tool): boolean {
    return tool.override === "CC" || tool.override === "AR";
}

/** Whether a tool can be run: a path as given, a bare name found on `PATH`. */
function found(name: string): boolean {
    if (isPath(name)) {
        return runnable(name);
    }
    for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
        if (directory === "") {
            continue;
        }
        for (const suffix of suffixes()) {
            if (runnable(join(directory, name + suffix))) {
                return true;
            }
        }
    }
    return false;
}

function isPath(name: string): boolean {
    return isAbsolute(name) || name.includes(sep) || name.includes("/");
}

/**
 * What a bare name can end in.
 *
 * Nothing, on a Unix. On Windows `PATHEXT` is how the shell decides what
 * `cargo` means, and both answers are real: rustup installs `cargo.exe`, and
 * plenty of tools arrive as a `.cmd` shim.
 */
function suffixes(): readonly string[] {
    if (process.platform !== "win32") {
        return [""];
    }
    return ["", ...(process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")];
}

function runnable(path: string): boolean {
    try {
        // `X_OK` is what separates a tool from a file that merely has its name;
        // on Windows it means the same thing as "exists", which is all that can
        // be asked there. A directory can carry the bit too, hence the `stat`.
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
    } catch {
        return false;
    }
}
