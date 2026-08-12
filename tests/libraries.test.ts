/**
 * Library targets, checked by *being consumed*.
 *
 * REWRITE-PLAN §12.9. A `static-lib` nobody can link against is not a
 * deliverable, so these do not inspect the archive — they build a real C
 * program that `#include`s the generated header, link it against the archive,
 * run it, and compare what it printed.
 *
 * That direction is the opposite of `struct-abi.test.ts`, and deliberately so.
 * There, a C compiler decided the register assignment and this one had to
 * agree. Here this compiler decides, publishes a header saying so, and a C
 * compiler has to agree with *that*. A classification bug that happens to be
 * self-consistent survives the first suite and dies in this one.
 *
 * CMake drives the C build, for the same reason it drives the oracle: it finds
 * the toolchain itself, so nothing here probes Visual Studio's registry or
 * assumes a Developer Command Prompt.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { compileSource, expectRejected } from "./harness.ts";

/**
 * Configuring and building a CMake project is slow, and slower the first time
 * on a cold toolchain. The default per-test budget is nowhere near enough.
 */
const CMAKE_TIMEOUT = 120_000;

/** Build a Goblin static library, then a C program that uses it. */
function buildConsumer(options: {
  readonly dir: string;
  readonly library: string;
  readonly header: string;
  readonly runtime: string;
  readonly main: string;
}): string {
  const consumer = join(options.dir, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "main.c"), options.main);

  // Paths are written into the CMakeLists rather than passed as cache
  // variables so that a failure can be reproduced by running cmake by hand on
  // exactly the directory the test left behind.
  const cmake = [
    "cmake_minimum_required(VERSION 3.20)",
    "project(goblin_consumer C)",
    "set(CMAKE_C_STANDARD 11)",
    "add_executable(consumer main.c)",
    `target_include_directories(consumer PRIVATE "${forward(dirname(options.header))}")`,
    // The Goblin archive first, then the runtime it needs. Order matters to a
    // Unix linker, which resolves left to right and will not go back.
    `target_link_libraries(consumer PRIVATE "${forward(options.library)}" "${forward(
      options.runtime,
    )}")`,
    // The runtime is a Rust staticlib and wants the platform's own libraries.
    "if(WIN32)",
    "  target_link_libraries(consumer PRIVATE ws2_32 userenv ntdll bcrypt advapi32)",
    "else()",
    "  target_link_libraries(consumer PRIVATE pthread dl m)",
    "endif()",
  ].join("\n");
  writeFileSync(join(consumer, "CMakeLists.txt"), cmake + "\n");

  const build = join(consumer, "build");
  const configure = spawnSync("cmake", ["-S", consumer, "-B", build], { encoding: "utf8" });
  if (configure.error !== undefined || configure.status !== 0) {
    throw new Error(
      `cmake configure failed in ${consumer}:\n${configure.stdout ?? ""}${
        configure.stderr ?? ""
      }`,
    );
  }
  const compiled = spawnSync("cmake", ["--build", build, "--config", "Release"], {
    encoding: "utf8",
  });
  if (compiled.error !== undefined || compiled.status !== 0) {
    throw new Error(
      `cmake build failed in ${consumer}:\n${compiled.stdout ?? ""}${compiled.stderr ?? ""}`,
    );
  }

  for (const candidate of [
    join(build, "consumer.exe"),
    join(build, "Release", "consumer.exe"),
    join(build, "Debug", "consumer.exe"),
    join(build, "consumer"),
  ]) {
    const run = spawnSync(candidate, [], { encoding: "utf8" });
    if (run.error === undefined) {
      if (run.status !== 0) {
        throw new Error(`${candidate} exited ${run.status}:\n${run.stderr ?? ""}`);
      }
      return (run.stdout ?? "").replaceAll("\r\n", "\n");
    }
  }
  throw new Error(`no consumer executable was produced in ${build}`);
}

/** CMake wants forward slashes even on Windows. */
function forward(path: string): string {
  return path.replaceAll("\\", "/");
}

async function library(name: string, source: string) {
  const { project, result } = await compileSource(name, source, { type: "static-lib" });
  if (!result.ok || result.output === undefined || result.headerPath === undefined) {
    throw new Error(
      `expected \`${name}\` to build:\n${result.diagnostics
        .map((d) => `${d.severity}[${d.code}]: ${d.message}`)
        .join("\n")}`,
    );
  }
  return {
    dir: project.dir,
    library: result.output,
    header: result.headerPath,
    runtime: result.runtimeLibrary!,
    headerText: readFileSync(result.headerPath, "utf8"),
  };
}

describe("static libraries", () => {
  test("a C program links against one and calls it", async () => {
    const lib = await library(
      "lib-scalars",
      `export function add(a: i32, b: i32): i32 { return a + b; }
       export function halve(x: f64): f64 { return x / 2; }
       export function negate(flag: boolean): boolean { return !flag; }\n`,
    );

    const stdout = buildConsumer({
      ...lib,
      main: `#include <stdio.h>
#include "main.h"

int main(void) {
  printf("%d\\n", add(19, 23));
  printf("%.2f\\n", halve(7.0));
  printf("%d\\n", (int) negate(false));
  return 0;
}
`,
    });
    expect(stdout).toBe("42\n3.50\n1\n");
  });

  test("structs cross the boundary with the layout the header declares", async () => {
    // The header is generated from the MIR, so the `Point` the C compiler lays
    // out is the one the backend laid out. If those disagreed the numbers
    // would come back plausible and wrong, which is why this checks values
    // rather than that it linked.
    const lib = await library(
      "lib-structs",
      `interface Point { x: i32; y: i32; }
       interface Line { from: Point; to: Point; }

       export function midpoint(l: Line): Point {
         return { x: (l.from.x + l.to.x) / 2, y: (l.from.y + l.to.y) / 2 };
       }
       export function manhattan(a: Point, b: Point): i32 {
         const dx: i32 = a.x - b.x;
         const dy: i32 = a.y - b.y;
         return (dx < 0 ? 0 - dx : dx) + (dy < 0 ? 0 - dy : dy);
       }\n`,
    );

    expect(lib.headerText).toContain("typedef struct Point");
    // Nested aggregates are inline, so `Line` holds two `Point`s by value and
    // `Point` has to be defined before it.
    expect(lib.headerText.indexOf("} Point;")).toBeLessThan(
      lib.headerText.indexOf("typedef struct Line"),
    );

    const stdout = buildConsumer({
      ...lib,
      main: `#include <stdio.h>
#include "main.h"

int main(void) {
  Line l = { { 0, 0 }, { 10, 4 } };
  Point m = midpoint(l);
  printf("%d,%d\\n", m.x, m.y);
  printf("%d\\n", manhattan(l.from, l.to));
  printf("%zu %zu\\n", sizeof(Point), sizeof(Line));
  return 0;
}
`,
    });
    expect(stdout).toBe("5,2\n14\n8 16\n");
  });

  test("a `string` crosses as a `const char *`, and C releases it", async () => {
    // A Goblin `string` is a pointer to nul-terminated bytes, so C reads one
    // with no conversion — `printf("%s")` and `strlen` both work. What C must
    // not do is `free` it: the allocation starts sixteen bytes earlier, behind
    // a length header, so the call is `gf_string_free`.
    //
    // Ownership at this boundary is documentation, exactly as it is in any C
    // API that hands out memory. `shout` returns a fresh string the caller
    // owns; `measure` borrows one and frees nothing. The header says so.
    const lib = await library(
      "lib-strings",
      `export function shout(text: string): string { return \`\${text}!\`; }
       export function measure(text: string): usize { return text.length; }\n`,
    );

    // A typedef rather than `const char *`, because the two directions are not
    // symmetric and the name is the only warning C can be given.
    expect(lib.headerText).toContain("GoblinString shout(GoblinString p0);");
    // The header has to hand the consumer both halves, or "do not use free" and
    // "do not pass a literal" are advice with no alternative attached.
    expect(lib.headerText).toContain("void gf_string_free(GoblinString s);");
    expect(lib.headerText).toContain("GoblinString gf_string_from_cstr(const char* bytes);");

    const stdout = buildConsumer({
      ...lib,
      main: `#include <stdio.h>
#include <string.h>
#include "main.h"

int main(void) {
  /* A C literal is *not* a GoblinString: the length header lives behind the
     pointer, so one has to be built. This copies. */
  GoblinString hello = gf_string_from_cstr("hello");
  printf("%zu\\n", (size_t) measure(hello));

  /* Coming back the other way it really is just a const char *. */
  GoblinString loud = shout(hello);
  printf("%s %zu\\n", loud, strlen(loud));

  gf_string_free(loud);
  gf_string_free(hello);
  return 0;
}
`,
    });
    expect(stdout).toBe("5\nhello! 6\n");
  }, CMAKE_TIMEOUT);

  test("the header guards, and is C++-safe", async () => {
    const lib = await library(
      "lib-header-shape",
      `export function one(): i32 { return 1; }\n`,
    );
    expect(lib.headerText).toContain("#ifndef GOBLIN_MAIN_H");
    expect(lib.headerText).toContain('extern "C" {');
    // No arguments must be `(void)`, not `()`. In C the second declares a
    // function that takes *unspecified* arguments, which silences exactly the
    // checking this header exists to provide.
    expect(lib.headerText).toContain("int32_t one(void);");
  });

  test("only exported functions appear", async () => {
    const lib = await library(
      "lib-internal",
      `function hidden(x: i32): i32 { return x; }
       export function shown(x: i32): i32 { return hidden(x); }\n`,
    );
    expect(lib.headerText).toContain("int32_t shown(int32_t p0);");
    // An internal function is classified however is fastest and has no stable
    // shape to publish, so declaring it would be a lie about its ABI. Matched
    // as a declaration rather than as the bare word, which also appears in the
    // banner's prose about hidden return pointers.
    expect(lib.headerText).not.toContain("hidden(");
  });
});

describe("library targets", () => {
  test("a library needs no `main`", async () => {
    const { result } = await compileSource(
      "lib-no-main",
      `export function only(): i32 { return 1; }\n`,
      { type: "static-lib" },
    );
    expect(result.ok).toBe(true);
  });

  test("a `bin` without `main` is rejected with a file and a line", async () => {
    // Without this the failure is an unresolved-external from the linker, with
    // no file and no line — the shape of error REWRITE-PLAN §8 exists to stop.
    const diagnostic = await expectRejected(
      "bin-no-main",
      `export function only(): i32 { return 1; }\n`,
      "GF0004",
    );
    expect(diagnostic.message).toContain("static-lib");
  });

  test("a shared library builds, and brings its import library on Windows", async () => {
    const { result } = await compileSource(
      "lib-shared",
      `export function answer(): i32 { return 42; }\n`,
      { type: "shared-lib" },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/\.(dll|so)$/);
    if (result.output?.endsWith(".dll") === true) {
      // Windows cannot link against a DLL directly; the consumer links this
      // stub, which turns a call into a jump through the import address table.
      expect(result.importLibrary).toMatch(/\.lib$/);
    }
  });
});
