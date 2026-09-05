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
import { describe, expect, test as bunTest } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileSource, expectRejected } from "./harness.ts";

/** Codes raised by the specimens above, recorded as each one is declared. */
const RAISED = new Set<string>();

/**
 * The suite's own `test`, which records a specimen's code from its name.
 *
 * The list this replaces was hand-kept beside the tests, and nothing checked
 * it against them: delete a specimen and its code stayed listed — still
 * "accounted for" while nothing raised it — and a rewritten one kept the code
 * it no longer provoked. Recording here, at declaration, ties the two
 * together — the record cannot outlive the test that made it — and each
 * body's own `expectRejected` is what proves the code still fires.
 *
 * Only names that *start* with a code are specimens; the registry tests at the
 * bottom use this same wrapper and record nothing.
 */
function test(name: string, body: () => void | Promise<void>, timeout?: number): void {
    const code = /^(GF\d{4})/.exec(name)?.[1];
    if (code !== undefined) {
        RAISED.add(code);
    }
    bunTest(name, body, timeout);
}

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
        // A top-level `let`: valid TypeScript, meant to be valid Goblin, and
        // nothing lowers one. It is deliberately something with no near-term
        // plan to land, because this test's specimen becoming *implemented* is
        // how it keeps breaking — the previous one was a generic function, and
        // GENERICS-PLAN stage 1 landed it.
        await expectRejected(
            "diag-0001",
            `let counter: i32 = 0;

       export function main(): i32 {
         return counter;
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

    test("GF0006 — a tool the build needs is not installed", async () => {
        // Pointed at nothing rather than emptying `PATH`, because this runs
        // in-process alongside every other test in the file and `GOBLIN_CLANG`
        // is the surgical version of the same question. The program is valid:
        // what is being provoked is the machine, not the source.
        const saved = process.env["GOBLIN_CLANG"];
        process.env["GOBLIN_CLANG"] = join(tmpdir(), "goblin-no-such-clang");
        try {
            await expectRejected(
                "diag-0006",
                `export function main(): i32 {
         return 0;
       }\n`,
                "GF0006",
            );
        } finally {
            if (saved === undefined) {
                delete process.env["GOBLIN_CLANG"];
            } else {
                process.env["GOBLIN_CLANG"] = saved;
            }
        }
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

    test("GF0238 — moving out of a capture", async () => {
        await expectRejected(
            "diag-0238",
            `function apply(f: LocalFn<() => void>): void { f(); }

       export function main(): i32 {
         const s: string = "a" + "b";
         apply(() => { const t: string = move(s); });
         return 0;
       }\n`,
            "GF0238",
        );
    });

    test("GF0239 — a `LocalFn` that would outlive its frame", async () => {
        await expectRejected(
            "diag-0239",
            `function make(): LocalFn<(x: i32) => i32> {
         return (x) => x;
       }

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0239",
        );
    });

    test("GF0240 — writing through a `readonly` array", async () => {
        await expectRejected(
            "diag-0240",
            // `take` is the only write tsc cannot see: it is declared as a read
            // and puts the type's default back into the slot afterwards.
            `function drain(xs: readonly string[]): string { return take(xs[0]); }

       export function main(): i32 {
         const xs: string[] = ["a"];
         console.log(drain(xs));
         return 0;
       }\n`,
            "GF0240",
        );
    });

    test("GF0241 — a constructor that is not inherited", async () => {
        await expectRejected(
            "diag-0241",
            // tsc reads this as a call to `Base`'s constructor and checks the
            // argument against it; there is no constructor here to call.
            `class Base { constructor(public x: i32) {} }
       class Derived extends Base {}

       export function main(): i32 {
         const d = new Derived(4);
         return d.x;
       }\n`,
            "GF0241",
        );
    });

    test("GF0242 — the read-only borrow written the wrong way", async () => {
        await expectRejected(
            "diag-0242",
            // Refuses a field and not a method, and converts to a mutable
            // reference at the first call. `ConstReference<T>` is the spelling.
            `interface S { a: i32; }

       function read(s: Reference<Readonly<S>>): i32 { return s.a; }

       export function main(): i32 {
         const s: S = {a: 1};
         return read(s);
       }\n`,
            "GF0242",
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

    test("GF0307 — a value that contains itself", async () => {
        // Written as an `extern`'s parameter because there is no way to *build*
        // one: tsc has nothing to put in the innermost `self`, so a program that
        // constructed the value would be rejected by tsc first and this rule
        // would never be the thing that answered.
        const diagnostic = await expectRejected(
            "diag-0307",
            `interface Cell {
         value: i32;
         self: Cell;
       }

       declare function c_take(cell: Cell): i32;

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0307",
        );
        expect(diagnostic.message).toContain("Pointer<Cell>");
    });

    test("GF0308 — two types cross under one C name", async () => {
        const diagnostic = await expectRejected(
            "diag-0308",
            `import type { Pair as Wide } from "./other.ts";

       interface Pair { a: i32; b: i32; }

       export function takeNarrow(p: Pair): i32 { return p.a + p.b; }
       export function takeWide(p: Wide): u8 { return cast<u8>(p.a + p.b); }\n`,
            "GF0308",
            {
                type: "static-lib",
                files: {"other.ts": "export interface Pair { a: u8; b: u8; }\n"},
            },
        );
        expect(diagnostic.message).toContain("`Pair`");
    });

    // -- Generics and instantiation ------------------------------------------
    //
    // `tests/generics.test.ts` is where these are tested properly, against
    // running programs. They are here as well because this file's contract is
    // that every code in the registry is raised from a real program *by it*.

    test("GF0402 — instantiation that never ends", async () => {
        const diagnostic = await expectRejected(
            "diag-0402",
            `interface Wrap<T> { inner: T; }

       function grow<T>(x: T): void {
         const w: Wrap<T> = { inner: x };
         grow<Wrap<T>>(w);
       }

       export function main(): i32 {
         grow<i32>(1);
         return 0;
       }\n`,
            "GF0402",
        );
        expect(diagnostic.message).toContain("deep so far");
    });

    test("GF0403 — a generic with no body", async () => {
        await expectRejected(
            "diag-0403",
            `declare function c_generic<T>(x: T): void;

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0403",
        );
    });

    test("GF0404 — a generic call that determines nothing", async () => {
        // `T` is in no argument, so inference has nothing to read it from.
        // `identity(1)` is deliberately *not* the specimen: that determines `T`
        // as the literal type `1`, and its complaint is GF0161's.
        await expectRejected(
            "diag-0404",
            `function sizeOfIt<T>(): usize { return sizeOf<T>(); }

       export function main(): i32 {
         return cast<i32>(sizeOfIt());
       }\n`,
            "GF0404",
        );
    });

    test("GF0405 — a type with no hash", async () => {
        // A class, which is the arrival that matters: it has a vtable and slices
        // when it is copied, so there is no structural answer to fall back on.
        const diagnostic = await expectRejected(
            "diag-0405",
            `class Plain {
         x: i32;
         constructor(x: i32) { this.x = x; }
       }

       export function main(): i32 {
         return cast<i32>(hashOf<Plain>(new Plain(1)));
       }\n`,
            "GF0405",
        );
        expect(diagnostic.message).toContain("hash(): u64");
    });

    test("GF0406 — a type with no equality", async () => {
        // The same class, asked the other half of the question. It declares
        // `hash` and not `equals`, so this is the shape a half-done key has.
        await expectRejected(
            "diag-0406",
            `class HalfDone {
         x: i32;
         constructor(x: i32) { this.x = x; }
         hash(): u64 { return hashOf<i32>(this.x); }
       }

       export function main(): i32 {
         return equalsOf<HalfDone>(new HalfDone(1), new HalfDone(1)) ? 1 : 0;
       }\n`,
            "GF0406",
        );
    });

    test("GF0407 — a float is not a key", async () => {
        const diagnostic = await expectRejected(
            "diag-0407",
            `export function main(): i32 {
         const x: f64 = 1.5;
         return cast<i32>(hashOf<f64>(x));
       }\n`,
            "GF0407",
        );
        expect(diagnostic.message).toContain("-0.0");
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
        // `RAISED` is recorded by the specimen tests themselves — see its
        // declaration — so the accounting cannot drift from what actually ran.
        const unaccounted = Object.keys(CODES).filter(
            (code) => !RAISED.has(code) && UNREACHABLE[code] === undefined,
        );
        expect(unaccounted).toEqual([]);

        // And nothing claims to raise a code the registry has never heard of:
        // a mistyped code in a specimen's name would otherwise pass as its own
        // account.
        const unknown = [...RAISED].filter((code) => !(code in CODES));
        expect(unknown).toEqual([]);
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
