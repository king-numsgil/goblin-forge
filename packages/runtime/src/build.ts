/**
 * Building the runtime static library, on demand.
 *
 * The runtime is compiled for the *user's* target, not the compiler's host, so
 * it cannot be a prebuilt artefact shipped beside the addon the way the backend
 * is. It is built with cargo the first time a program needs it, and cached for
 * the rest of the process.
 *
 * The system libraries it needs come from `--print native-static-libs` rather
 * than from a hardcoded list, which is the one detail here worth insisting on:
 * a hardcoded list is right on the day it is written and rots at the next
 * toolchain bump, and the failure is an unresolved symbol from inside the Rust
 * standard library that means nothing to whoever hits it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runtimeCrate } from "./paths.ts";

export interface RuntimeBuild {
  /** Absolute path to the static library. */
  readonly library: string;
  /** System libraries the linker needs, in the platform's spelling. */
  readonly systemLibs: readonly string[];
}

const cache = new Map<string, RuntimeBuild>();

/**
 * The crate directory.
 *
 * A function because a single-file executable extracts its embedded copy on
 * first use, so the answer is not known when this module is evaluated.
 */
export const RUNTIME_CRATE = (): string => runtimeCrate();

/**
 * Build the runtime for `target`, or the host when it is omitted.
 *
 * Cached per target for the life of the process. cargo is itself incremental,
 * so a cold cache in a new process is still fast — the cache is here to avoid
 * paying cargo's own startup on every one of a few hundred test compiles.
 */
export function buildRuntime(target?: string): RuntimeBuild {
  const key = target ?? "<host>";
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const args = ["rustc", "--release", "--quiet"];
  if (target !== undefined) args.push("--target", target);
  // `--print native-static-libs` reports what a staticlib needs on stderr, as
  // part of an ordinary build, so this is not a second compilation.
  args.push("--", "--print", "native-static-libs");

  const result = spawnSync("cargo", args, {
    cwd: RUNTIME_CRATE(),
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw new Error(
      `could not run cargo to build the Goblin runtime: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `building the Goblin runtime failed:\n${result.stderr ?? ""}${result.stdout ?? ""}`,
    );
  }

  const library = locateLibrary(target);
  if (library === undefined) {
    throw new Error(
      `the Goblin runtime built, but its static library was not where it was ` +
        `expected under ${join(RUNTIME_CRATE(), "target")}`,
    );
  }

  const build: RuntimeBuild = {
    library,
    systemLibs: parseNativeStaticLibs(result.stderr ?? ""),
  };
  cache.set(key, build);
  return build;
}

function locateLibrary(target?: string): string | undefined {
  const base = join(RUNTIME_CRATE(), "target", ...(target ? [target] : []), "release");
  for (const name of ["goblin_runtime.lib", "libgoblin_runtime.a"]) {
    const candidate = join(base, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Pull the library list out of rustc's report.
 *
 * The line looks like `native-static-libs: kernel32.lib ws2_32.lib …`, and
 * rustc prints it with a `note:` prefix on some versions and without on others,
 * so the marker is matched rather than the whole line.
 */
export function parseNativeStaticLibs(stderr: string): string[] {
  const marker = "native-static-libs:";
  const at = stderr.lastIndexOf(marker);
  if (at === -1) return [];
  const line = stderr.slice(at + marker.length).split(/\r?\n/, 1)[0] ?? "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of line.trim().split(/\s+/)) {
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}
