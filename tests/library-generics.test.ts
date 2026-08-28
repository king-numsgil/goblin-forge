/**
 * Generics across a Goblin library boundary.
 *
 * GENERICS-PLAN §6, and DECISIONS §25 for what it turned out to be. The claim
 * being tested is C++'s and Rust's: **a generic has no symbol, so it cannot be
 * handed over by a linker — its body travels with the library and is compiled
 * into whoever uses it.** Goblin to Goblin only, exactly as `std::vector<T>`
 * cannot be used from C.
 *
 * The mechanism is the one DECISIONS §11.8 already chose and needs no format of
 * its own: a Goblin module is TypeScript source, tsc resolves the imports, and
 * a generic imported from a library is compiled in the consumer's own
 * compilation like any other file. What crosses as a *symbol* is the
 * non-generic half, through the C ABI and the generated header, which is how a
 * Goblin library and a C one already meet.
 *
 * So these tests are about the seam between those two halves, and the two
 * properties that have to hold across it:
 *
 * * **the layouts agree** — a `Pair<i32>` built on one side and read on the
 *   other is the same bytes, which is what `layoutKey` is for; and
 * * **the heap agrees** — a `string` the library allocated is released by the
 *   consumer's scope, and the live-allocation count comes back to zero.
 *
 * The consumer imports the library's source by absolute path, which is what the
 * scratch layout allows. A real project would import it the way it imports
 * anything else — a relative path, or a package in `node_modules`. Nothing here
 * depends on which: it is one `ts.Program` either way.
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { compileSource, expectRejected, type Project, run, runBinary } from "./harness.ts";
import type { CompileResult } from "goblin-forge";

/** Build a `static-lib`, and fail loudly rather than at the consumer. */
async function library(
    name: string,
    source: string,
    files: Record<string, string>,
): Promise<{ project: Project; result: CompileResult; archive: string }> {
    const {project, result} = await compileSource(name, source, {type: "static-lib", files});
    if (!result.ok || result.output === undefined) {
        throw new Error(
            `expected \`${name}\` to build:\n${result.diagnostics
                .map((d) => `${d.severity}[${d.code}]: ${d.message}`)
                .join("\n")}`,
        );
    }
    return {project, result, archive: result.output};
}

/** The absolute path of one of a library's own source files, for importing. */
function sourceOf(project: Project, file: string): string {
    return join(dirname(project.entry), file).replaceAll("\\", "/");
}

describe("a Goblin library's boundary", () => {
    test("a Goblin program links one and calls it", async () => {
        // The baseline, and the thing everything else rests on: a Goblin
        // consumer declares an exported symbol the way it would a C one.
        const lib = await library(
            "gl-plain",
            "export function addI32(a: i32, b: i32): i32 { return a + b; }\n",
            {},
        );

        const {result} = await compileSource(
            "gl-plain-app",
            `declare function addI32(a: i32, b: i32): i32;

       export function main(): i32 { return addI32(19, 23); }\n`,
            {nativeLibs: [lib.archive]},
        );
        expect(result.ok).toBe(true);
        expect(runBinary("gl-plain-app", result.output!).exitCode).toBe(42);
    });

    test("a generic travels as source and is instantiated in the consumer", async () => {
        const lib = await library(
            "gl-source",
            "export function unused(): i32 { return 0; }\n",
            {"generic.ts": "export function first<T>(xs: T[]): T { return xs[0]; }\n"},
        );

        const {result} = await compileSource(
            "gl-source-app",
            `import { first } from "${sourceOf(lib.project, "generic.ts")}";

       export function main(): i32 {
         const numbers: i32[] = [7, 8];
         const words: string[] = ["from the library"];
         console.log(first<string>(words));
         return first<i32>(numbers);
       }\n`,
            {nativeLibs: [lib.archive]},
        );
        expect(result.ok).toBe(true);
        const ran = runBinary("gl-source-app", result.output!);
        expect(ran.stdout).toBe("from the library\n");
        expect(ran.exitCode).toBe(7);
        expect(ran.stderr).toBe("");
    });

    test("the same generic instantiated on both sides", async () => {
        // Each side compiles its own copy, and they do not collide: an
        // instantiation is internal, so the library's is not a symbol the
        // consumer could reach even if it wanted to. Duplicated, and correct.
        const lib = await library(
            "gl-both",
            `import { first } from "./generic.ts";

       export function firstOfTwo(a: i32, b: i32): i32 {
         const xs: i32[] = [a, b];
         return first<i32>(xs);
       }\n`,
            {"generic.ts": "export function first<T>(xs: T[]): T { return xs[0]; }\n"},
        );

        const {result} = await compileSource(
            "gl-both-app",
            `import { first } from "${sourceOf(lib.project, "generic.ts")}";

       declare function firstOfTwo(a: i32, b: i32): i32;

       export function main(): i32 {
         const xs: i32[] = [7, 8];
         return first<i32>(xs) + firstOfTwo(19, 23);
       }\n`,
            {nativeLibs: [lib.archive]},
        );
        expect(result.ok).toBe(true);
        expect(runBinary("gl-both-app", result.output!).exitCode).toBe(26);
    });

    test("a generic aggregate crosses by value with the same layout", async () => {
        // The correctness property that matters most here. Each side erases
        // `Pair<i32>` from its *own* `ts.Program`, and they have to agree about
        // the bytes — which they do because the layout is a function of the
        // field types and nothing else.
        const lib = await library(
            "gl-layout",
            `import type { Pair } from "./pair.ts";

       export function sum(p: Pair<i32>): i32 { return p.a + p.b; }
       export function widen(p: Pair<u8>): i32 {
         return cast<i32>(p.a) * 1000 + cast<i32>(p.b);
       }\n`,
            {"pair.ts": "export interface Pair<T> { a: T; b: T; }\n"},
        );

        const {result} = await compileSource(
            "gl-layout-app",
            `import type { Pair } from "${sourceOf(lib.project, "pair.ts")}";

       declare function sum(p: Pair<i32>): i32;
       declare function widen(p: Pair<u8>): i32;

       export function main(): i32 {
         const whole: Pair<i32> = { a: 19, b: 23 };
         const bytes: Pair<u8> = { a: 1, b: 2 };
         console.log(\`\${widen(bytes)}\`);
         return sum(whole);
       }\n`,
            {nativeLibs: [lib.archive]},
        );
        expect(result.ok).toBe(true);
        const ran = runBinary("gl-layout-app", result.output!);
        // 1002 rather than a large number: the `u8` pair really is two bytes on
        // both sides, so neither field picked up the other's.
        expect(ran.stdout).toBe("1002\n");
        expect(ran.exitCode).toBe(42);
    });

    test("a `string` the library made is released by the consumer", async () => {
        // One artefact, so one runtime and one heap — a `static-lib`'s objects
        // go into the executable and the consumer supplies the runtime once.
        // The live-allocation report is what proves it: a cross-heap free would
        // not come back to zero, and a missing report is a failure rather than
        // a zero (see `harness.ts`).
        const lib = await library(
            "gl-owned",
            `export function greeting(n: i32): string { return \`held \${n}\`; }\n`,
            {},
        );

        const {result} = await compileSource(
            "gl-owned-app",
            `declare function greeting(n: i32): string;

       export function main(): i32 {
         const s = greeting(7);
         console.log(s);
         return 0;
       }\n`,
            {nativeLibs: [lib.archive]},
        );
        expect(result.ok).toBe(true);
        const ran = runBinary("gl-owned-app", result.output!);
        expect(ran.stdout).toBe("held 7\n");
        expect(ran.leaked).toBe(0);
        expect(ran.stderr).toBe("");
    });

    test("a generic class travels as source too", async () => {
        const lib = await library(
            "gl-class",
            "export function unused(): i32 { return 0; }\n",
            {
                "box.ts": `export class Box<T> {
         constructor(private value: T) {}
         get(): T { return this.value; }
       }\n`,
            },
        );

        const {result} = await compileSource(
            "gl-class-app",
            `import { Box } from "${sourceOf(lib.project, "box.ts")}";

       export function main(): i32 {
         const n = new Box<i32>(5);
         const s = new Box<string>("boxed");
         console.log(s.get());
         return n.get();
       }\n`,
            {nativeLibs: [lib.archive]},
        );
        expect(result.ok).toBe(true);
        const ran = runBinary("gl-class-app", result.output!);
        expect(ran.stdout).toBe("boxed\n");
        expect(ran.exitCode).toBe(5);
        expect(ran.leaked).toBe(0);
    });

    test("a dynamic cast survives the boundary", async () => {
        // GENERICS-PLAN §6 predicted the opposite: that without folding the
        // instantiations, a class made on one side would carry a different
        // vtable from the consumer's and `tryCast` would answer no.
        //
        // It does not, and the reason is worth keeping. A value has exactly
        // **one** vtable — its maker's — and travels with it; the consumer
        // never installs a second. And the itab lookup is keyed by a *hash of
        // the interface's name* rather than by the address of a table, which is
        // the same thing that makes a C++ `dynamic_cast` work across a shared
        // object. So there is no identity to reconcile and nothing to fold.
        const lib = await library(
            "gl-dyncast",
            `import { Counter } from "./shared.ts";

       export function makeCounter(v: i32): Pointer<unknown> {
         const p = alloc(Counter, v);
         return p.erase();
       }
       export function dropCounter(p: Pointer<unknown>): void {
         p.reify<Counter>().free();
       }\n`,
            {
                "shared.ts": `export interface Getter { get(): i32; }
       export class Counter implements Getter {
         constructor(private value: i32) {}
         get(): i32 { return this.value; }
       }\n`,
            },
        );

        const {result} = await compileSource(
            "gl-dyncast-app",
            `import { Counter, type Getter } from "${sourceOf(lib.project, "shared.ts")}";

       declare function makeCounter(v: i32): Pointer<unknown>;
       declare function dropCounter(p: Pointer<unknown>): void;

       export function main(): i32 {
         const raw = makeCounter(9);
         const mine = raw.reify<Counter>();
         const direct = mine.get();
         const found = tryCast<Getter>(mine);
         const dynamic = found === null ? -1 : found.get();
         dropCounter(raw);
         return direct * 10 + dynamic;
       }\n`,
            {nativeLibs: [lib.archive]},
        );
        expect(result.ok).toBe(true);
        // 99, not 9 followed by a -1: the library's object answered a question
        // the consumer asked about an interface the library never converted to.
        expect(runBinary("gl-dyncast-app", result.output!).exitCode).toBe(99);
    });

    describe("what does not cross", () => {
        test("an exported generic is absent from the header, and that is not an error", async () => {
            // It has no symbol to declare. A C consumer cannot instantiate
            // anything, so there is nothing to say — exactly as a C header says
            // nothing about `std::vector<T>`.
            const {result} = await compileSource(
                "gl-header-generic",
                `export function first<T>(xs: T[]): T { return xs[0]; }
       export function firstI32(a: i32): i32 {
         const xs: i32[] = [a];
         return first<i32>(xs);
       }\n`,
                {type: "static-lib"},
            );
            expect(result.ok).toBe(true);
            const header = await Bun.file(result.headerPath!).text();
            expect(header).toContain("int32_t firstI32(int32_t p0);");
            expect(header).not.toContain("first<");
            expect(header).not.toContain("T ");
        });

        test("a generic class cannot cross as a value", async () => {
            // For the reason any class cannot: it carries a vtable pointer that
            // only means something inside one build. Being generic is not what
            // stops it.
            const diagnostic = await expectRejected(
                "gl-class-boundary",
                `class Box<T> { constructor(public value: T) {} }

       export function take(b: Box<i32>): i32 { return b.value; }\n`,
                "GF0301",
                {type: "static-lib"},
            );
            expect(diagnostic.message).toContain("vtable");
        });
    });

    test("one compilation is still one compilation", async () => {
        // The control. A library consumed purely as *source* has no boundary at
        // all — it is one `ts.Program`, and the generic instantiates as if it
        // had been written in the consumer. Nothing here needs a linker.
        const result = await run(
            "gl-source-only",
            `import { first } from "./vendor.ts";

       export function main(): i32 {
         const xs: i32[] = [42, 1];
         return first<i32>(xs);
       }\n`,
            {files: {"vendor.ts": "export function first<T>(xs: T[]): T { return xs[0]; }\n"}},
        );
        expect(result.exitCode).toBe(42);
    });
});
