/**
 * Module-level constants — a `const` at the top of a file.
 *
 * GLOBALS-PLAN. The rule is C++'s: the value is decided while the program is
 * compiled, and no initialiser ever runs. So there is no startup code, no
 * ordering between modules, and nothing to destroy at exit — and the reason the
 * feature is worth having is in the first test: a lookup table becomes an address
 * in `.rodata` rather than a stack copy made on every call.
 *
 * Every `run` test here also asserts the live allocation count is zero
 * afterwards, automatically. That matters more than it looks: a global holds no
 * allocation, so a global that somehow acquired one would show up here rather
 * than in whatever later test happened to notice.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("what a module-level constant is for", () => {
    test("a table is one symbol in read-only data, not a stack copy", async () => {
        // The whole point. As a function local this is four `store double`s on
        // every call; as a constant it is an address, and the `.ll` beside the
        // object is where that is checked rather than inferred.
        const {project, result} = await compileSource(
            "global-table",
            `const EPHEMERIS: FixedArray<f64, 4> = fixedArrayOf(1.5, 2.5, 3.5, 4.5);

       export function main(): i32 {
         console.log(\`\${EPHEMERIS[2]}\`);
         return 0;
       }\n`,
            {emitIr: true},
        );
        expect(result.ok).toBe(true);

        const ir = readFileSync(`${project.dir}/build/main.ll`, "utf8");
        const line = ir
            .split("\n")
            .find((text) => text.includes("$EPHEMERIS = "));
        expect(line).toBeDefined();
        // `internal constant` is what puts it in `.rodata`; the values are IEEE
        // hex because that is what the MIR carries.
        expect(line).toContain("internal constant [4 x double]");
        expect(line).toContain("0x3FF8000000000000");
        // And the table is never copied to the stack to be read.
        expect(ir).not.toContain("alloca [4 x double]");
    });

    test("the elements are the ones written, and reading one costs nothing", async () => {
        const result = await run(
            "global-table-read",
            `const TABLE: FixedArray<i32, 3> = fixedArrayOf(10, 20, 30);

       export function main(): i32 {
         let total: i32 = 0;
         let i: usize = 0;
         while (i < TABLE.length) {
           total = total + TABLE[i];
           i = i + 1;
         }
         console.log(\`\${TABLE[0]} \${TABLE[2]} \${total}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("10 30 60\n");
    });
});

describe("what folds", () => {
    test("scalars, enums, booleans and arithmetic over them", async () => {
        const result = await run(
            "global-folds",
            `enum Level { Low = 1, High = 9 }
       declare namespace Level { type Underlying = u8 }

       const LIMIT: i32 = 7;
       const MASK: u32 = 1 << 12;
       const NEGATIVE: i32 = -5;
       const READY: boolean = true;
       const TOP: u8 = Level.High;
       const HALF: f64 = 3 / 2;
       const SUM: i32 = 2 * 3 + 1;

       export function main(): i32 {
         console.log(\`\${LIMIT} \${MASK} \${NEGATIVE} \${READY} \${TOP}\`);
         console.log(\`\${HALF} \${SUM}\`);
         return 0;
       }\n`,
        );
        // `3 / 2` at `f64` is 1.5: the fold is at the *annotated* type, so this is
        // not integer division that happened to be widened afterwards.
        expect(result.stdout).toBe("7 4096 -5 true 9\n1.5 7\n");
    });

    test("`sizeOf` and `alignOf` are resolved by the backend", async () => {
        // The frontend has no layout at all, so these are leaves the backend
        // fills in. Which is also why they cannot appear inside arithmetic.
        const result = await run(
            "global-layout",
            `interface Body { mass: f64; id: i32; }

       const STRIDE: usize = sizeOf<Body>();
       const ALIGNMENT: usize = alignOf<Body>();

       export function main(): i32 {
         console.log(\`\${STRIDE} \${ALIGNMENT}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("16 8\n");
    });

    test("a struct constant, field by field", async () => {
        const result = await run(
            "global-struct",
            `interface Body { mass: f64; id: i32; }

       const ORIGIN: Body = { mass: 1.5, id: 3 };

       export function main(): i32 {
         console.log(\`\${ORIGIN.mass} \${ORIGIN.id}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1.5 3\n");
    });

    test("the fields land in the struct's order, not the literal's", async () => {
        // The fold walks the *type*, so writing the properties the other way round
        // has to produce the same bytes. Getting this wrong is not a compile error
        // — it is a struct whose fields are swapped.
        const result = await run(
            "global-struct-order",
            `interface Pair { first: i32; second: f64; }

       const BACKWARDS: Pair = { second: 2.5, first: 1 };

       export function main(): i32 {
         console.log(\`\${BACKWARDS.first} \${BACKWARDS.second}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 2.5\n");
    });

    test("`zeroed<T>()` is one leaf, whatever the type", async () => {
        const result = await run(
            "global-zeroed",
            `interface Body { mass: f64; id: i32; }

       const BLANK: Body = zeroed<Body>();
       const EMPTY: FixedArray<i32, 512> = zeroed<FixedArray<i32, 512>>();

       export function main(): i32 {
         console.log(\`\${BLANK.mass} \${BLANK.id} \${EMPTY[511]}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("0 0 0\n");
    });

    test("a uniform fill of zero does not cost a leaf per element", async () => {
        // `fixedArray(4096, 0)` folds to one `Zero`, which is what keeps a big
        // table cheap on the wire rather than 4096 entries of nothing.
        const result = await run(
            "global-fill-zero",
            `const SCRATCH: FixedArray<u8, 4096> = fixedArray(4096, 0);

       export function main(): i32 {
         console.log(\`\${SCRATCH[4095]} \${SCRATCH.length}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("0 4096\n");
    });

    test("a non-zero fill repeats, and every element is it", async () => {
        const result = await run(
            "global-fill-value",
            `const ONES: FixedArray<i32, 4> = fixedArray(4, 1);

       export function main(): i32 {
         console.log(\`\${ONES[0]} \${ONES[3]}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 1\n");
    });

    test("a null pointer constant", async () => {
        // `Pointer<T>` is not nullable on its own — the union is how absence is
        // spelled — and the nullability never reaches the machine type, so what is
        // emitted is one pointer-sized zero.
        const result = await run(
            "global-null",
            `const NOTHING: Pointer<i32> | null = null;

       export function main(): i32 {
         return NOTHING === null ? 0 : 1;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
    });
});

describe("one constant reading another", () => {
    test("within a file, tsc's own ordering applies", async () => {
        // A module `const` is block-scoped, so a *forward* reference is `TS2448`
        // before this compiler is involved at all. Worth pinning: the folder does
        // not care about order and would have folded this happily, so if the rule
        // ever changes on tsc's side the behaviour changes here rather than being
        // silently different from what this file claims.
        const {result} = await compileSource(
            "global-forward",
            `const DOUBLE: i32 = LIMIT * 2;
       const LIMIT: i32 = 21;

       export function main(): i32 {
         return DOUBLE;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2448");
    });

    test("a chain folds all the way down", async () => {
        const result = await run(
            "global-chain",
            `const A: i32 = 2;
       const B: i32 = A + 1;
       const C: i32 = B * B;

       export function main(): i32 {
         console.log(\`\${A} \${B} \${C}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("2 3 9\n");
    });

    test("a constant from another file of the same program", async () => {
        // One record per declaration, so an import lands on the *exported*
        // declaration's own symbol and reads the same object. There is nothing per
        // import to reconcile because there is nothing per import.
        const result = await run(
            "global-cross-file",
            `import { SHARED, TABLE } from "./consts.ts";

       export function main(): i32 {
         console.log(\`\${SHARED} \${TABLE[1]}\`);
         return 0;
       }\n`,
            {
                files: {
                    "consts.ts":
                        `export const SHARED: i32 = 5;\n` +
                        `export const TABLE: FixedArray<i32, 2> = fixedArrayOf(8, 9);\n`,
                },
            },
        );
        expect(result.stdout).toBe("5 9\n");
    });
});

describe("the rules", () => {
    test("a top-level `let` is a gap, and says which keyword to use", async () => {
        const diagnostic = await expectRejected(
            "global-let",
            `let frame: u64 = 0;

       export function main(): i32 {
         return cast<i32>(frame);
       }\n`,
            "GF0001",
        );
        expect(diagnostic.message).toContain("`const`");
    });

    test("a `string` constant is `GF0008`, and says it is a gap", async () => {
        const diagnostic = await expectRejected(
            "global-string",
            `const NAME: string = "sol";

       export function main(): i32 {
         console.log(NAME);
         return 0;
       }\n`,
            "GF0008",
        );
        expect(diagnostic.message).toContain("release");
    });

    test("a `T[]` constant is `GF0008` too", async () => {
        await expectRejected(
            "global-array",
            `const XS: i32[] = [1, 2];

       export function main(): i32 {
         return cast<i32>(XS.length);
       }\n`,
            "GF0008",
        );
    });

    test("a struct holding a `string` names both types", async () => {
        const diagnostic = await expectRejected(
            "global-struct-string",
            `interface Named { id: i32; name: string; }

       const WHO: Named = { id: 1, name: "sol" };

       export function main(): i32 {
         return WHO.id;
       }\n`,
            "GF0008",
        );
        expect(diagnostic.message).toContain("Named");
        expect(diagnostic.message).toContain("string");
    });

    test("a call does not fold", async () => {
        const diagnostic = await expectRejected(
            "global-call",
            `function compute(): i32 {
         return 7;
       }

       const N: i32 = compute();

       export function main(): i32 {
         return N;
       }\n`,
            "GF0007",
        );
        expect(diagnostic.message).toContain("compile time");
    });

    test("`sizeOf<T>() * 2` does not fold, and says why", async () => {
        // Not because multiplication is hard: the size is a leaf the *backend*
        // resolves, so there is no number here to multiply.
        const diagnostic = await expectRejected(
            "global-sizeof-arithmetic",
            `interface Body { mass: f64; }

       const TWO: usize = sizeOf<Body>() * 2;

       export function main(): i32 {
         return cast<i32>(TWO);
       }\n`,
            "GF0007",
        );
        expect(diagnostic.message).toContain("the backend");
    });

    test("a cycle across two files is `GF0008`", async () => {
        // The reachable shape, and the only one: within a file tsc's block scoping
        // makes a cycle impossible, because one of the two references has to point
        // forward. Circular *imports* are legal TypeScript, so this is where the
        // compiler's own guard earns its place — and it is why folding is on demand
        // with a visiting set rather than a topological sort.
        const diagnostic = await expectRejected(
            "global-cycle-files",
            `import { A } from "./a.ts";

       export function main(): i32 {
         return A;
       }\n`,
            "GF0008",
            {
                files: {
                    "a.ts": `import { B } from "./b.ts";\n\nexport const A: i32 = B + 1;\n`,
                    "b.ts": `import { A } from "./a.ts";\n\nexport const B: i32 = A + 1;\n`,
                },
            },
        );
        expect(diagnostic.message).toContain("itself");
    });

    test("a self-reference in one file is tsc's to refuse", async () => {
        const {result} = await compileSource(
            "global-cycle-self",
            `const A: i32 = A + 1;

       export function main(): i32 {
         return A;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2448");
    });

    test("several declarators in one statement is a gap", async () => {
        await expectRejected(
            "global-several",
            `const A: i32 = 1, B: i32 = 2;

       export function main(): i32 {
         return A + B;
       }\n`,
            "GF0001",
        );
    });

    test("a value that does not fit the type is refused", async () => {
        await expectRejected(
            "global-range",
            `const TOO_BIG: u8 = 300;

       export function main(): i32 {
         return cast<i32>(TOO_BIG);
       }\n`,
            "GF0007",
        );
    });

    test("a constant nothing reads is still checked", async () => {
        // The enum precedent: a member nothing mentions is still wrong. Folding is
        // forced for every constant rather than only for the ones something reads.
        await expectRejected(
            "global-unused-bad",
            `const UNUSED: string = "sol";

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0008",
        );
    });

    test("one unfoldable constant read from several places is reported once", async () => {
        const {result} = await compileSource(
            "global-reported-once",
            `function compute(): i32 {
         return 1;
       }

       const N: i32 = compute();

       export function main(): i32 {
         return N + N + N;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result).filter((code) => code === "GF0007").length).toBe(1);
    });
});
