/**
 * What the LLVM backend can compile and run.
 *
 * LLVM-PORT stage 3. These select `backend: "llvm"` explicitly rather than
 * reading the environment, so the checkpoint holds whatever `GOBLIN_BACKEND`
 * says and a Cranelift regression cannot mask an LLVM one.
 *
 * The scope is the scalar core: locals, control flow, structs by value and by
 * hidden return pointer, direct calls, and a literal through the runtime.
 * Owning types — `string`, `T[]`, classes with destructors — and virtual and
 * interface dispatch are stage 3b, and each raises a named internal error
 * rather than emitting something plausible.
 */

import {describe, expect, test} from "bun:test";

import {type ProjectOptions, run} from "./harness.ts";

/** Selected per test, so the environment cannot decide what is being checked. */
const LLVM: ProjectOptions = {backend: "llvm"};

describe("the scalar core", () => {
    test("arithmetic and an exit code", async () => {
        const result = await run(
            "llvm-arith",
            `export function main(): i32 {
    const a: i32 = 6;
    const b: i32 = 7;
    return a * b;
}
`,
            LLVM,
        );
        expect(result.exitCode).toBe(42);
    });

    test("control flow", async () => {
        const result = await run(
            "llvm-loop",
            `export function main(): i32 {
    let total: i32 = 0;
    for (let i: i32 = 0; i < 10; i = i + 1) {
        if (i % 2 === 0) {
            total = total + i;
        }
    }
    return total;
}
`,
            LLVM,
        );
        expect(result.exitCode).toBe(20);
    });

    test("a call and a struct by value", async () => {
        const result = await run(
            "llvm-struct",
            `interface Point { x: i32; y: i32; }

function sum(p: Point): i32 {
    return p.x + p.y;
}

export function main(): i32 {
    const p: Point = {x: 17, y: 8};
    return sum(p);
}
`,
            LLVM,
        );
        expect(result.exitCode).toBe(25);
    });

    test("a struct returned into the caller's storage", async () => {
        const result = await run(
            "llvm-sret",
            `interface Point { x: i32; y: i32; }

function make(a: i32, b: i32): Point {
    return {x: a, y: b};
}

export function main(): i32 {
    const p: Point = make(30, 11);
    return p.x + p.y;
}
`,
            LLVM,
        );
        expect(result.exitCode).toBe(41);
    });

    test("printing a literal", async () => {
        const result = await run(
            "llvm-print",
            `export function main(): i32 {
    console.log("llvm runs");
    return 0;
}
`,
            LLVM,
        );
        expect(result.stdout.trim()).toBe("llvm runs");
    });

    test("floats and comparison", async () => {
        const result = await run(
            "llvm-float",
            `export function main(): i32 {
    const a: f64 = 1.5;
    const b: f64 = 2.5;
    const c: f64 = a * b;
    if (c > 3.0) {
        return 7;
    }
    return 1;
}
`,
            LLVM,
        );
        expect(result.exitCode).toBe(7);
    });
});
