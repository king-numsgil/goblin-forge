/**
 * The rule that the backend never reports a user error, checked.
 *
 * REWRITE-PLAN §8 and the README both state it: any failure reachable from
 * source that tsc accepted is a **missing frontend check**, and the backend
 * panics rather than returning politely so that a test cannot mistake a
 * compiler crash for the compiler correctly saying no.
 *
 * That design only pays for itself if something checks it, and nothing did: a
 * panic inside the addon aborts the whole process, so a test written the
 * ordinary way takes the test runner down with it and the other files never
 * run. {@link compileOutOfProcess} moves the compile into a child process so
 * the abort can be observed instead of suffered.
 *
 * Each program below is valid TypeScript that tsc accepts. Every one of them
 * should end at a `GF####` with a file and a line. The ones marked failing end
 * at a panic in `crates/goblin-codegen/src/llvm/func.rs` instead.
 */

import { describe, expect, test } from "bun:test";

import { compileOutOfProcess } from "./harness.ts";

/**
 * Compile out of process and describe the outcome, so a failure message says
 * what happened rather than just which boolean was wrong.
 */
function verdictOf(name: string, source: string): string {
    const result = compileOutOfProcess(name, source);
    if (!result.survived) {
        const panic = /goblin backend: (.*)/.exec(result.stderr);
        return `the compiler aborted: ${panic?.[1] ?? result.stderr.split("\n")[1] ?? "no message"}`;
    }
    if (result.ok === true) {
        return "compiled";
    }
    return `rejected with ${result.codes?.join(", ")}`;
}

const RETURNS_ZERO = "  return 0;";

/** A `main` whose body is the thing under test. */
const program = (body: string, prelude = ""): string =>
    `${prelude}export function main(): i32 {\n${body}\n}\n`;

describe("the frontend rejects what the backend cannot lower", () => {
    test("a program the compiler is happy with survives, so the check has teeth", () => {
        expect(verdictOf("bc-control", program(RETURNS_ZERO))).toBe("compiled");
    });

    test("a program the frontend rejects survives too", () => {
        expect(
            verdictOf(
                "bc-control-rejected",
                program("  const a: i32 = 1;\n  const b: u32 = 2;\n  return a + b;"),
            ),
        ).toBe("rejected with GF0161");
    });

    for (const [operator, name] of [
        ["<", "lt"],
        [">", "gt"],
        ["<=", "le"],
        [">=", "ge"],
    ] as const) {
        test(`\`${operator}\` on two strings is GF0001, not a panic`, () => {
            // tsc allows relational operators on strings — that is what they mean in
            // TypeScript. `#binaryWidth` read the operator out of `OPERATOR_TOKENS`,
            // saw a comparison and answered `bool` without asking whether the operand
            // type had an ordering, so the backend was handed `Lt` on a `string`.
            //
            // A gap rather than a rule: two strings *do* have an order, it just needs
            // a lexicographic comparison in the runtime that does not exist yet.
            expect(
                verdictOf(
                    `bc-string-${name}`,
                    program(`  const a: string = "a";\n  if (a ${operator} a) { return 1; }\n  return 0;`),
                ),
            ).toBe("rejected with GF0001");
        });
    }

    for (const [operator, name] of [
        ["===", "eq"],
        ["!==", "ne"],
    ] as const) {
        test(`\`${operator}\` on two structs is GF0002, not a panic`, () => {
            // A rule rather than a gap, and the rule is the value model. In
            // TypeScript this asks whether two names refer to the same object; here
            // they are values, so there is nothing to ask.
            expect(
                verdictOf(
                    `bc-struct-${name}`,
                    program(
                        `  const x: S = { a: 1 };\n  const y: S = { a: 1 };\n  if (x ${operator} y) { return 1; }\n  return 0;`,
                        "interface S { a: i32; }\n",
                    ),
                ),
            ).toBe("rejected with GF0002");
        });
    }

    test("`===` on two class values is GF0002 too", () => {
        expect(
            verdictOf(
                "bc-class-eq",
                program(
                    "  const a = new C();\n  const b = new C();\n  if (a === b) { return 1; }\n  return 0;",
                    "class C { x: i32; }\n",
                ),
            ),
        ).toBe("rejected with GF0002");
    });

    test("`===` on two contract references is GF0002", () => {
        // Worth its own case because it is the one comparison that is *not* one
        // machine word: a `Reference<Speaker>` is an `(itab, data)` pair, so even
        // a comparison the hardware could do on an address has nothing to do here.
        expect(
            verdictOf(
                "bc-contract-eq",
                program(
                    "  const d = new Dog();\n" +
                    "  const a: Reference<Speaker> = d;\n" +
                    "  const b: Reference<Speaker> = d;\n" +
                    "  if (a === b) { return 1; }\n  return 0;",
                    "interface Speaker { speak(): string; }\n" +
                    "class Dog { speak(): string { return \"woof\"; } }\n",
                ),
            ),
        ).toBe("rejected with GF0002");
    });

    test("`!== null` on a `tryCast` result still works", () => {
        // The null test is a different question and takes a different path, so the
        // rule above must not have closed the only way to use `tryCast`.
        expect(
            verdictOf(
                "bc-null-test",
                program(
                    "  const d = new Dog();\n" +
                    "  const s = tryCast<Speaker>(d);\n" +
                    "  if (s !== null) { return 1; }\n  return 0;",
                    "interface Speaker { speak(): string; }\n" +
                    "class Dog implements Speaker { speak(): string { return \"woof\"; } }\n",
                ),
            ),
        ).toBe("compiled");
    });

    test("`===` on two fixed arrays is GF0002", () => {
        expect(
            verdictOf(
                "bc-array-eq",
                program(
                    "  const a: FixedArray<u8, 2> = fixedArray(2, 0);\n" +
                    "  const b: FixedArray<u8, 2> = fixedArray(2, 0);\n" +
                    "  if (a === b) { return 1; }\n  return 0;",
                ),
            ),
        ).toBe("rejected with GF0002");
    });

    test("`===` on two `CString`s is an address comparison, and is fine", () => {
        // The counterexample that says the rule is about *which* types have an
        // ordering rather than about `===` in general: a `CString` is one word, so
        // comparing two of them is a machine comparison with an obvious meaning.
        expect(
            verdictOf(
                "bc-cstring-eq",
                program("  const a: CString = cstring(\"x\");\n  const b: CString = cstring(\"y\");\n  if (a === b) { return 1; }\n  return 0;"),
            ),
        ).toBe("compiled");
    });

    test("`===` on two strings is a value comparison, and is fine", () => {
        expect(
            verdictOf(
                "bc-string-eq",
                program("  const a: string = \"a\";\n  if (a === a) { return 1; }\n  return 0;"),
            ),
        ).toBe("compiled");
    });

    test("`<` on two booleans is accepted by the frontend", () => {
        // tsc allows it, and it lowers as an integer comparison of 0 and 1. Worth
        // pinning down, because it is the same code path as the string case and it
        // is the reason the string case is not simply "no relational operators on
        // non-numbers".
        expect(
            verdictOf(
                "bc-bool-lt",
                program("  const a: boolean = true;\n  const b: boolean = false;\n  if (a < b) { return 1; }\n  return 0;"),
            ),
        ).toBe("compiled");
    });
});
