/**
 * The backend, end to end, on the shapes the rest of the suite reaches only
 * incidentally.
 *
 * Written during the LLVM port (LLVM-PORT stage 3) as the checkpoint that real
 * programs compiled and ran, and kept because the cases are worth having named:
 * arithmetic, a loop, a struct by value, a struct returned through a hidden
 * pointer, a literal through the runtime, and float comparison. Every other
 * suite exercises these too; this one says so out loud.
 */

import {describe, expect, test} from "bun:test";

import {run} from "./harness.ts";

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
        );
        expect(result.exitCode).toBe(7);
    });
});
