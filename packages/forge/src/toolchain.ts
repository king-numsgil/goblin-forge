/**
 * What a build needs on the machine, checked before it needs it.
 *
 * This compiler produces native code by driving native tools: clang turns the
 * IR the backend emits into an object, cargo builds the runtime for the target
 * — with clang again, under its `clang-cl` name, for the C that runtime
 * depends on when the target is MSVC — and the platform's own linker or
 * archiver assembles the result. None of them are optional and none of them
 * ship inside this compiler.
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

import { locateLinker } from "@goblin-forge/backend";
import type { Diagnostic } from "@goblin-forge/checker";
import { msvcClang } from "@goblin-forge/runtime/build";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

import type { OutputKind } from "./compile.ts";

/** One thing a build runs, and whether it is there. */
interface Tool {
    /** What it is called, in the terms it was looked for. */
    readonly name: string;

    /** What it does, for somebody who has just been told to install it. */
    readonly what: string;

    readonly found: boolean;

    /** How the looking failed, when it did. */
    readonly missing: string;

    /** What to do about it, where the answer is more specific than "install it". */
    readonly remedy?: string;
}

/**
 * The tools this build will run, in the order it will run them.
 *
 * Ordered that way so the message reads as the build would have gone, which is
 * also roughly the order somebody would install them in.
 */
function required(kind: OutputKind): readonly Tool[] {
    // One probe, asked once and passed on. It answers two questions — where
    // the linker is, and whether this is an MSVC toolchain at all — and asking
    // twice would be two chances to get a different answer.
    const probe = locateLinker(kind);

    return [
        onPath(
            process.env["GOBLIN_CLANG"] ?? "clang",
            "compiles the LLVM IR the backend emits",
            "GOBLIN_CLANG",
        ),
        // The same clang under the name `cc` wants, and only where it is used:
        // C dependencies of the runtime are built with it on MSVC, because
        // `cl` miscompiles mimalloc at `/O1` (DECISIONS §28). Usually free —
        // `clang-cl` is `clang` with a different name on it — but a machine
        // that has one without the other should be told here rather than
        // inside cargo, which reports it as a `cc` error about a build script.
        ...(probe.probed
            ? [onPath(msvcClang(), "compiles the C in the runtime's dependencies")]
            : []),
        onPath("cargo", "builds the Goblin runtime for your target"),
        linker(kind, probe),
    ];
}

/** A tool found by name on `PATH`, or at the path a variable named. */
function onPath(name: string, what: string, override?: string): Tool {
    return {
        name,
        what,
        found: found(name),
        // A name that is already a path was given by whoever set the variable, so
        // "not on PATH" would be answering a question they did not ask.
        missing: isPath(name) ? "no such file" : "not on PATH",
        ...(override === undefined ? {} : {remedy: `\`${override}\` names a specific one`}),
    };
}

/**
 * The linker, or the archiver — and whichever route this platform finds it by.
 *
 * The backend is asked rather than guessed at. On MSVC it answers from the same
 * registry probe the link step itself runs, which is the only thing that can
 * answer: those tools are not on `PATH` even when they are installed, so a walk
 * would report a missing linker on a machine that links fine. Everywhere else —
 * every Unix, and MinGW on Windows — it says so, and `PATH` is the question.
 *
 * An archive is not a link: nothing is resolved and no runtime is pulled in, so
 * a `static-lib` wants `ar` (or `lib.exe`) and a machine with no linker can
 * still build one.
 */
function linker(kind: OutputKind, probe: ReturnType<typeof locateLinker>): Tool {
    const archiving = kind === "static-lib";
    const what = archiving ? "bundles the objects into an archive" : "links the artefact";

    if (!probe.probed) {
        return archiving
            ? onPath(process.env["AR"] ?? "ar", what, "AR")
            // The platform C compiler rather than `ld`, because it is the thing
            // that knows where the CRT startup files live.
            : onPath(process.env["CC"] ?? "cc", what, "CC");
    }

    return {
        name: archiving ? "lib.exe" : "link.exe",
        what,
        found: probe.path !== undefined,
        missing: "the Visual Studio registry probe found none",
        remedy:
            "install the Visual Studio Build Tools with the " +
            "\"Desktop development with C++\" workload",
    };
}

/**
 * Diagnostics for every tool this build needs and cannot find.
 *
 * All of them, not the first: a machine that is missing clang is usually
 * missing cargo too, and finding that out one build at a time is a worse
 * afternoon than being told once.
 *
 * **The linker is not always a `PATH` question**, and this does not guess which
 * case it is in. On MSVC, `link.exe` and `lib.exe` are found by probing the
 * registry — they work without a Developer Command Prompt and without being on
 * `PATH`, so a walk would call them missing on a machine where the build then
 * succeeds. `locateLinker` is the backend answering with the same lookup the
 * link step itself performs, so the check and the thing it checks cannot
 * disagree; it says `probed: false` where `PATH` really is the right question,
 * which is every Unix and MinGW.
 */
export function checkToolchain(kind: OutputKind): Diagnostic[] {
    const missing = required(kind).filter((tool) => !tool.found);
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
    const remedy = tool.remedy === undefined ? "" : `; ${tool.remedy}`;
    return `  ${tool.name} (${tool.missing}) — ${tool.what}${remedy}`;
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
