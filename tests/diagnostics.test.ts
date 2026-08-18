/**
 * Every diagnostic code, raised by a real program.
 *
 * `packages/checker/test/codes.test.ts` checks the registry against the string
 * literals in the source: it proves no code is *emitted* without being
 * documented. It cannot prove the opposite — that a documented code is still
 * reachable — because a code whose rule has been overtaken by a stricter check
 * somewhere earlier keeps its literal and its table entry and stops firing.
 *
 * This file closes that direction. Each user-facing code gets a program that
 * provokes it, and the two codes that have no such program are named at the
 * bottom with the reason, so that "unreachable" is a claim the suite makes
 * rather than something nobody noticed.
 */

import { CODES } from "@goblin-forge/checker";
// noinspection ES6UnusedImports
import { describe, expect, test } from "bun:test";

import { compileSource, expectRejected } from "./harness.ts";

/** Codes no program can currently reach, and why. */
const UNREACHABLE: Partial<Record<string, string>> = {
    GF0163:
        "`cast<T extends number>(value: number)` — tsc rejects every argument " +
        "that is not already a number, so the lowerer's own conversion check is " +
        "never the thing that says no.",
    GF0227:
        "the diagnostic is about a `Pointer<T>` used where a `T` is expected, and " +
        "`Pointer<T>` cannot be written as a type yet (GF0001).",
    GF0005:
        "`runtime: \"shared\"` needs the runtime crate to have produced a cdylib, " +
        "and its manifest asks for one on every target this suite can build for. " +
        "Reaching it needs a triple whose toolchain cannot make a shared library " +
        "at all, which is not something a test can arrange on the host.",
    GF9001: "the frontend and the backend are built from one MIR definition.",
    GF9002: "requires an addon built from a different MIR definition.",
    GF9003: "the backend panics under `strictInternalErrors`, which every test uses.",
    GF9006: "requires the ABI classifier and the header generator to disagree.",
};

describe("codes raised by a program", () => {
    test("GF0001 — a construct the compiler cannot lower yet", async () => {
        await expectRejected(
            "diag-0001",
            `export function main(): i32 {
         const s: string = "abc";
         return cast<i32>(s.indexOf("b"));
       }\n`,
            "GF0001",
        );
    });

    test("GF0002 — a construct that is not part of the language", async () => {
        const diagnostic = await expectRejected(
            "diag-0002",
            `export function main(): i32 {
         const n: i32 = 1;
         if (n) { return 1; }
         return 0;
       }\n`,
            "GF0002",
        );
        expect(diagnostic.message).toContain("truthiness");
    });

    test("GF0003 — a tsconfig that overrides a setting the language depends on", async () => {
        const diagnostic = await expectRejected(
            "diag-0003",
            `export function main(): i32 {
         return 0;
       }\n`,
            "GF0003",
            {compilerOptions: {noLib: false}},
        );
        expect(diagnostic.message).toContain("noLib");
    });

    test("GF0004 — a `bin` with no `main`", async () => {
        await expectRejected(
            "diag-0004",
            `export function notMain(): i32 {
         return 0;
       }\n`,
            "GF0004",
        );
    });

    test("GF0160 — arithmetic narrowing into a declared width", async () => {
        await expectRejected(
            "diag-0160",
            `export function main(): i32 {
         const wide: i32 = 1000;
         const narrow: i8 = wide * 2;
         return 0;
       }\n`,
            "GF0160",
        );
    });

    test("GF0161 — two operands with no common type", async () => {
        await expectRejected(
            "diag-0161",
            `export function main(): i32 {
         const a: i32 = 1;
         const b: u32 = 2;
         const sum: i64 = a + b;
         return 0;
       }\n`,
            "GF0161",
        );
    });

    test("GF0162 — an integer-only operator on a float", async () => {
        await expectRejected(
            "diag-0162",
            `export function main(): i32 {
         const a: f64 = 5;
         const b: f64 = a % 2;
         return 0;
       }\n`,
            "GF0162",
        );
    });

    test("GF0164 — a literal out of range for its width", async () => {
        const diagnostic = await expectRejected(
            "diag-0164",
            `export function main(): i32 {
         const a: i8 = 255;
         return 0;
       }\n`,
            "GF0164",
        );
        expect(diagnostic.message).toContain("-128");
    });

    test("GF0165 — unary minus on an unsigned type", async () => {
        await expectRejected(
            "diag-0165",
            `export function main(): i32 {
         const a: u8 = 1;
         const b: u8 = -a;
         return 0;
       }\n`,
            "GF0165",
        );
    });

    test("GF0234 — a reference borrowing a temporary", async () => {
        await expectRejected(
            "diag-0234",
            `export function main(): i32 {
         const c: CString = cstring("a" + "b");
         return 0;
       }\n`,
            "GF0234",
        );
    });

    test("GF0235 — reading a moved-from value", async () => {
        await expectRejected(
            "diag-0235",
            `export function main(): i32 {
         const a: string = "a" + "b";
         const b: string = move(a);
         console.log(a);
         return 0;
       }\n`,
            "GF0235",
        );
    });

    test("GF0236 — moving out of a by-value parameter", async () => {
        await expectRejected(
            "diag-0236",
            `function take(s: string): string {
         return move(s);
       }

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0236",
        );
    });

    test("GF0301 — a type that cannot cross the C boundary", async () => {
        await expectRejected(
            "diag-0301",
            // A bare `string` crosses — it is a valid `char *` and its ownership
            // becomes documentation. One buried in a struct has nothing to document.
            `interface Named { id: i32; name: string; }

       export function label(n: Named): i32 { return n.id; }

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0301",
        );
    });

    test("GF0302 — an operation needing a layout the build does not have", async () => {
        await expectRejected(
            "diag-0302",
            // An opaque handle can be passed and returned all day. What it cannot do
            // is arithmetic, because there is no stride to do it with.
            `declare class FILE { private _opaque: never }
       declare function fopen(p: CString, m: CString): Pointer<FILE>;

       export function main(): i32 {
         const f = fopen(cstring("never-opened"), cstring("r"));
         return cast<i32>(f.offset(1).address);
       }\n`,
            "GF0302",
        );
    });

    test("GF0166 — an enum whose underlying type is not an integer width", async () => {
        await expectRejected(
            "diag-0166",
            // The one legal place to write a C enum's underlying type, naming
            // something that cannot be one.
            `enum Level { Low = 1 }
       declare namespace Level { type Underlying = f64 }

       export function main(): i32 {
         return cast<i32>(Level.Low);
       }\n`,
            "GF0166",
        );
    });

    test("GF0303 — a union member that owns something", async () => {
        await expectRejected(
            "diag-0303",
            // The members share their storage, so nothing in the bytes says which one
            // is live — and so nothing could say which one to release.
            `interface Bad extends Union { tag: u32; name: string; }

       export function main(): i32 {
         const b = zeroed<Bad>();
         return cast<i32>(b.tag);
       }\n`,
            "GF0303",
        );
    });

    test("GF0304 — an object literal for a union", async () => {
        await expectRejected(
            "diag-0304",
            // tsc asks for every member because it sees an ordinary interface. A
            // union has room for one.
            `interface Word extends Union { whole: u32; low: u8; }

       export function main(): i32 {
         const w: Word = { whole: 1, low: 2 };
         return cast<i32>(w.low);
       }\n`,
            "GF0304",
        );
    });

    test("GF0237 — a null of a type that has none", async () => {
        await expectRejected(
            "diag-0237",
            // One machine word, like a pointer — but an owning one, so a null would
            // reach the drop pass and be released like any other.
            `export function main(): i32 {
         const s: string | null = null;
         return s === null ? 1 : 0;
       }\n`,
            "GF0237",
        );
    });

    test("GF0305 — an operation that needs what an erased pointer threw away", async () => {
        await expectRejected(
            "diag-0305",
            // `void` has a layout — nought bytes, aligned to one — so this does not
            // refuse itself. It would hand the allocator a size of zero.
            `export function main(): i32 {
         const p = alloc<i32>();
         const raw: Pointer<unknown> = p;
         raw.free();
         return 0;
       }\n`,
            "GF0305",
        );
    });

    test("GF0306 — reifying a pointer that never lost its type", async () => {
        await expectRejected(
            "diag-0306",
            // `reify` is declared on `CorePointer<T>`, so tsc allows it on any
            // pointer at all. The rule that there is no unchecked cast between two
            // concrete pointee types is the compiler's to keep.
            `class Rect { w: i32; }
       class Circle { r: i32; }

       export function main(): i32 {
         const p = alloc(Rect);
         const c = p.reify<Circle>();
         p.free();
         return c.r;
       }\n`,
            "GF0306",
        );
    });

    test("GF9004 — an output kind the backend does not know", async () => {
        const {result} = await compileSource(
            "diag-9004",
            `export function main(): i32 {
         return 0;
       }\n`,
            // Deliberately outside `OutputKind`: the point is that the build API and
            // the backend disagreeing produces a diagnostic rather than a crash.
            {type: "wasm" as "bin"},
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics.map((d) => d.code)).toContain("GF9004");
    });

    test("GF9005 — a symbol no library defines", async () => {
        await expectRejected(
            "diag-9005",
            `declare function c_nothing_defines_this(v: i32): i32;

       export function main(): i32 {
         return c_nothing_defines_this(1);
       }\n`,
            "GF9005",
        );
    });
});

describe("the registry and the suite agree", () => {
    test("every code is either raised above or listed as unreachable, with a reason", () => {
        // The list of codes this file raises, kept as data so the two halves cannot
        // drift: a new code with neither a test nor an entry fails here.
        const raised = new Set([
            "GF0001",
            "GF0002",
            "GF0003",
            "GF0004",
            "GF0160",
            "GF0161",
            "GF0162",
            "GF0164",
            "GF0165",
            "GF0166",
            "GF0234",
            "GF0235",
            "GF0236",
            "GF0237",
            "GF0301",
            "GF0302",
            "GF0303",
            "GF0304",
            "GF0305",
            "GF0306",
            "GF9004",
            "GF9005",
        ]);

        const unaccounted = Object.keys(CODES).filter(
            (code) => !raised.has(code) && UNREACHABLE[code] === undefined,
        );
        expect(unaccounted).toEqual([]);
    });

    test("nothing is claimed unreachable that is not in the registry", () => {
        const stale = Object.keys(UNREACHABLE).filter((code) => !(code in CODES));
        expect(stale).toEqual([]);
    });

    test("every unreachable code says why", () => {
        for (const [code, reason] of Object.entries(UNREACHABLE)) {
            expect({code, explained: (reason ?? "").length > 30}).toEqual({code, explained: true});
        }
    });
});
