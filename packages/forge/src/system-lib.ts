/**
 * Finding a system library on a machine you did not configure.
 *
 * `nativeLibs` takes paths and nothing else — there is no `-l` and no `-L`,
 * because the link line is assembled rather than handed to a shell (LINKING.md,
 * "The escape hatch"). That is fine on one machine and a problem on two:
 * `libSDL3.so` is in `/usr/lib` on Arch, under a multiarch triple on Debian,
 * under Homebrew's prefix on macOS, and on Windows it is not called that at all.
 *
 * So this is the one piece of "ask the machine" a build script should not have
 * to write. Nothing here is clever. It asks the tools that already know — the
 * package's own `.pc` file, the C compiler driver — and then looks where the
 * platform keeps libraries, in that order, and returns the first path that
 * exists.
 *
 * **It is a helper, not a policy.** It returns a path, which is the same thing
 * you would have typed; a build that needs something this does not find says so
 * with `search`, or with `GOBLIN_LIB_PATH`, and nothing here has to change.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

export interface SystemLibOptions {
    /**
     * The pkg-config package name, when it is not the library's own.
     *
     * SDL3's is `sdl3` and the default lowercasing finds it. OpenSSL's library
     * is `ssl` and its package is `libssl`, which no rule would have guessed.
     */
    readonly pkgConfig?: string;

    /** Directories to look in before anywhere else. */
    readonly search?: readonly string[];

    /**
     * Which spelling wins where a machine has both. Defaults to `"shared"`.
     *
     * Shared, because that is what a package manager installs and what a distro
     * expects to be linked — a static build of something like SDL is usually
     * not installed at all, and where it is, it drags in a dependency list that
     * has to be linked by hand. `"static"` for the case LINKING.md prefers,
     * where the artefact should carry the library rather than find it at load.
     */
    readonly prefer?: "shared" | "static";
}

/**
 * The path to a system library, for `nativeLibs`.
 *
 * ```ts
 * export default {
 *     entry: "./src/main.ts",
 *     output: "./bin/game",
 *     nativeLibs: [systemLib("SDL3")],
 * };
 * ```
 *
 * The name is the library's, spelled as the linker would spell it without any
 * platform decoration: `SDL3`, not `libSDL3.so` and not `SDL3.lib`. Throws when
 * nothing matches, with the names and the directories it tried — a build script
 * that cannot find its library has no useful way to carry on, and the failure
 * is worth having at the top of the build rather than as a link error at the
 * bottom of it.
 */
export function systemLib(name: string, options: SystemLibOptions = {}): string {
    const names = fileNames(name, options.prefer ?? "shared");
    const searched: string[] = [];

    for (const directory of directories(name, options, searched)) {
        for (const file of names) {
            const path = join(directory, file);
            if (existsSync(path)) {
                return path;
            }
        }
    }

    // The compiler driver knows where its own libraries live, including the
    // multiarch directory this list would otherwise have to guess at. Asked
    // last, because it answers for one name at a time and costs a process each
    // time — and because it lies: a driver that finds nothing echoes the name
    // back unchanged, so an answer with no separator in it means "no".
    for (const file of names) {
        const answered = printFileName(file);
        if (answered !== undefined) {
            return answered;
        }
    }

    throw new Error(
        `could not find a system library called \`${name}\`.\n` +
        `Looked for ${names.join(", ")} in:\n` +
        `${searched.map((directory) => `  ${directory}`).join("\n")}\n` +
        `Point at it with GOBLIN_LIB_PATH=${["/path/to/lib", "..."].join(delimiter)}, ` +
        `or name the directory in \`search\`.`,
    );
}

/**
 * What the file is called, in the order worth trying.
 *
 * Windows is the odd one and is odd twice. `SDL3.lib` is MSVC's spelling for
 * *both* roles — an import library for a DLL and a static archive — and which
 * one a given file is cannot be told from its name, so there is nothing for
 * `prefer` to choose between. MinGW spells the same two `libSDL3.dll.a` and
 * `libSDL3.a`, which is why all three are tried rather than the toolchain being
 * detected: a wrong guess about the toolchain would be a confusing miss, and
 * trying all three costs a `stat` each.
 */
function fileNames(name: string, prefer: "shared" | "static"): readonly string[] {
    if (process.platform === "win32") {
        return [`${name}.lib`, `lib${name}.dll.a`, `lib${name}.a`];
    }
    const shared = process.platform === "darwin" ? `lib${name}.dylib` : `lib${name}.so`;
    const archive = `lib${name}.a`;
    return prefer === "static" ? [archive, shared] : [shared, archive];
}

/** Where to look, most specific first, recording what was tried for the error. */
function directories(
    name: string,
    options: SystemLibOptions,
    searched: string[],
): readonly string[] {
    const dirs: string[] = [];
    const add = (directory: string | undefined): void => {
        if (directory !== undefined && directory !== "" && isAbsolute(directory)) {
            dirs.push(directory);
            searched.push(directory);
        }
    };

    for (const directory of options.search ?? []) {
        add(directory);
    }

    // The override that always works, and the one an error message can name.
    // Spelled like `PATH` because it is one, and because a machine with a
    // library in two places has already had to answer this question once.
    for (const directory of (process.env["GOBLIN_LIB_PATH"] ?? "").split(delimiter)) {
        add(directory);
    }

    add(pkgConfigLibdir(options.pkgConfig ?? name.toLowerCase()));

    if (process.platform === "win32") {
        // `LIB` is the list a Developer Command Prompt sets, and it is the
        // closest thing Windows has to a system library path. It is not always
        // set — `link.rs` finds the toolchain through the registry rather than
        // requiring that prompt — so it is a bonus rather than the answer.
        for (const directory of (process.env["LIB"] ?? "").split(delimiter)) {
            add(directory);
        }
        const vcpkg = process.env["VCPKG_ROOT"];
        if (vcpkg !== undefined && vcpkg !== "") {
            add(join(vcpkg, "installed", `${process.arch === "arm64" ? "arm64" : "x64"}-windows`, "lib"));
        }
    } else if (process.platform === "darwin") {
        const brew = process.env["HOMEBREW_PREFIX"];
        add(brew === undefined || brew === "" ? undefined : join(brew, "lib"));
        // Where Homebrew puts itself on Apple silicon and on Intel. Named rather
        // than derived, because a machine with no `HOMEBREW_PREFIX` set is the
        // common one — the variable comes from `brew shellenv`, which a build
        // running outside an interactive shell has not sourced.
        add("/opt/homebrew/lib");
        add("/usr/local/lib");
        add("/usr/lib");
    } else {
        add("/usr/local/lib");
        add("/usr/lib");
        add("/usr/lib64");
        // Debian and Ubuntu put everything under a triple. `cc` knows the real
        // one and is asked when this list fails; this is the guess that saves a
        // process on the common case.
        add(`/usr/lib/${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux-gnu`);
    }

    return dirs;
}

/** What pkg-config says the package's libraries are in, if it knows. */
function pkgConfigLibdir(pkg: string): string | undefined {
    return output("pkg-config", ["--variable=libdir", pkg]);
}

/**
 * Ask the C compiler driver for a library's full path.
 *
 * `$CC` first, because that is the driver `link.rs` will actually run and
 * therefore the one whose search path is the one that matters.
 */
function printFileName(file: string): string | undefined {
    if (process.platform === "win32") {
        return undefined;
    }
    const answer = output(process.env["CC"] ?? "cc", [`--print-file-name=${file}`]);
    // "Echoed the name back" is how this driver says no. A separator is the
    // difference between an answer and a shrug.
    if (answer === undefined || !answer.includes(sep) || !existsSync(answer)) {
        return undefined;
    }
    return answer;
}

/** Run a tool for one line of stdout, and treat every failure as "it did not say". */
function output(command: string, args: readonly string[]): string | undefined {
    let result;
    try {
        result = spawnSync(command, [...args], {encoding: "utf8"});
    } catch {
        return undefined;
    }
    if (result.error !== undefined || result.status !== 0) {
        return undefined;
    }
    const said = (result.stdout ?? "").trim();
    return said === "" ? undefined : said;
}
