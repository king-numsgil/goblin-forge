/**
 * Golden MIR.
 *
 * REWRITE-PLAN §9: "Snapshot the MIR for a handful of programs. Drop placement
 * is the thing most likely to regress invisibly, and a golden MIR file makes a
 * change to it visible in review."
 *
 * At milestone 4 nothing in the language owns anything, so there are no `drop`
 * lines to see yet. What these pin down is the *shape* the drop pass reads:
 * where `StorageLive` and `StorageDead` land on every path out of a scope,
 * including the early exits that cost v1 a double free. When milestone 5 makes
 * `string` owning, `drop` lines appear in these files and the diff is the
 * review.
 *
 * Snapshots are written with `bun test --update-snapshots`. Read the diff
 * before accepting one: a changed golden file is the point of having it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { compileSource } from "./harness.ts";

/** Compile a program and return its MIR, rendered. */
async function mirOf(name: string, source: string): Promise<string> {
    const {result} = await compileSource(name, source, {emitIr: true});
    if (result.irPath === undefined) {
        throw new Error(
            `expected \`${name}\` to emit MIR, but it did not compile:\n\n${result.diagnostics
                .map((d) => `${d.severity}[${d.code}]: ${d.message}`)
                .join("\n")}`,
        );
    }
    return readFileSync(result.irPath, "utf8");
}

describe("golden MIR", () => {
    test("a straight-line function", async () => {
        expect(
            await mirOf(
                "mir-straight-line",
                `export function main(): i32 {
           const a: i32 = 6;
           const b: i32 = 7;
           return a * b;
         }\n`,
            ),
        ).toMatchSnapshot();
    });

    test("a branch, where the join is what drop flags are made of", async () => {
        expect(
            await mirOf(
                "mir-branch",
                `export function main(): i32 {
           const flag: boolean = true;
           if (flag) {
             const inner: i32 = 1;
             return inner;
           }
           return 0;
         }\n`,
            ),
        ).toMatchSnapshot();
    });

    test("a loop with `break` and `continue`", async () => {
        // The shape that matters: an early exit releases the scopes opened *inside*
        // the loop and not the one holding it. Getting that bound inclusive instead
        // of exclusive is v1's double free (REWRITE-PLAN §10), and it is visible
        // here as the set of `StorageDead` lines before each `goto`.
        expect(
            await mirOf(
                "mir-loop-exits",
                `export function main(): i32 {
           let total: i32 = 0;
           for (let i: i32 = 0; i < 10; i = i + 1) {
             const doubled: i32 = i * 2;
             if (doubled > 12) {
               break;
             }
             if (doubled === 4) {
               continue;
             }
             total = total + doubled;
           }
           return total;
         }\n`,
            ),
        ).toMatchSnapshot();
    });

    test("an early return unwinds every scope it is inside", async () => {
        expect(
            await mirOf(
                "mir-early-return",
                `export function main(): i32 {
           const outer: i32 = 1;
           {
             const middle: i32 = 2;
             {
               const inner: i32 = 3;
               return inner;
             }
           }
         }\n`,
            ),
        ).toMatchSnapshot();
    });

    test("short-circuiting is control flow, not an operator", async () => {
        expect(
            await mirOf(
                "mir-short-circuit",
                `export function main(): i32 {
           const a: i32 = 3;
           if (a > 1 && a < 5) {
             return 1;
           }
           return 0;
         }\n`,
            ),
        ).toMatchSnapshot();
    });

    test("a call is a terminator, and temporaries end with the statement", async () => {
        expect(
            await mirOf(
                "mir-call",
                `function twice(x: i32): i32 { return x + x; }

         export function main(): i32 {
           const result: i32 = twice(3) + twice(4);
           return result;
         }\n`,
            ),
        ).toMatchSnapshot();
    });

    test("a class: construction, virtual dispatch, and the generated destructor", async () => {
        // Four things to read in the diff when this changes:
        //
        // * `Derived$~drop` releases its **own** field and then calls `Base$~drop` —
        //   own fields only, or every inherited field is released twice;
        // * `virtual#N` at each call site — a shifted slot is the regression this
        //   file exists to catch, and it is invisible in program output whenever
        //   two methods happen to have compatible signatures;
        // * `default` before the constructor call, which is what installs the
        //   vtable pointer and makes a half-built object safe to drop;
        // * `drop(_n)` on the object locals, placed by the pass rather than by the
        //   lowerer.
        expect(
            await mirOf(
                "mir-class",
                `class Base {
           tag: string;
           constructor(tag: string) { this.tag = tag; }
           describe(): string { return this.tag; }
         }
         class Derived extends Base {
           extra: string;
           constructor(tag: string, extra: string) { super(tag); this.extra = extra; }
           override describe(): string { return this.extra; }
         }

         export function main(): i32 {
           const d = new Derived("a", "b");
           console.log(d.describe());
           return 0;
         }\n`,
            ),
        ).toMatchSnapshot();
    });
    test("a contract: the conversion and the itab dispatch", async () => {
        // Two things to read in the diff:
        //
        // * `(Speaker) _n` — the conversion, built into a temporary. It takes the
        //   *static* class, so the itab is chosen at compile time and nothing is
        //   looked up;
        // * `itab#N` at the call, with the slot from the interface's name-sorted
        //   method set. A shifted slot here calls a different body, and two methods
        //   with compatible signatures would print plausible values rather than
        //   crash.
        expect(
            await mirOf(
                "mir-interface",
                `interface Speaker { speak(): string; }
         class Cat {
           sound: string;
           constructor(sound: string) { this.sound = sound; }
           speak(): string { return this.sound; }
         }

         function announce(who: Reference<Speaker>): void {
           console.log(who.speak());
         }

         export function main(): i32 {
           announce(new Cat("mew"));
           return 0;
         }\n`,
            ),
        ).toMatchSnapshot();
    });
});

describe("what the drop pass sees", () => {
    test("every local that is made live is also made dead", async () => {
        // The invariant drop elaboration depends on. A `StorageLive` with no
        // matching `StorageDead` on some path is a local the pass will never
        // consider destroying, and at milestone 5 that is a leak rather than a
        // crash — which is exactly the kind that survives.
        const mir = await mirOf(
            "mir-balanced",
            `export function main(): i32 {
         let total: i32 = 0;
         for (let i: i32 = 0; i < 4; i = i + 1) {
           const step: i32 = i;
           if (step === 2) {
             continue;
           }
           total = total + step;
         }
         return total;
       }\n`,
        );

        const live = countOf(mir, /StorageLive\(_(\d+)\)/g);
        const dead = countOf(mir, /StorageDead\(_(\d+)\)/g);
        for (const [local, liveCount] of live) {
            expect({local, liveCount, deadCount: dead.get(local) ?? 0}).toEqual({
                local,
                liveCount,
                // Not equal counts — one `StorageLive` in a loop body pairs with one
                // `StorageDead` per exit path — but never zero.
                deadCount: dead.get(local) ?? 0,
            });
            expect(dead.get(local) ?? 0).toBeGreaterThan(0);
        }
        expect(live.size).toBeGreaterThan(0);
    });
});

function countOf(text: string, pattern: RegExp): Map<string, number> {
    const counts = new Map<string, number>();
    for (const match of text.matchAll(pattern)) {
        const local = match[1]!;
        counts.set(local, (counts.get(local) ?? 0) + 1);
    }
    return counts;
}
