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
import { dirname, join } from "node:path";

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

describe("constants that own something", () => {
    // A `string` and a `T[]` both hold a buffer, and a static one is safe for the
    // same reason in both cases: the runtime already has a marker for "this did not
    // come from the allocator" — `owned = 0` in a string's header, `cap = 0` in an
    // array's — so releasing one is a no-op the *runtime* decides. Nothing had to be
    // arranged for a global never to be freed.
    //
    // Every test here runs, so the live-allocation check is doing the real work:
    // a static buffer that got freed, or a copy that did not, shows up as a
    // mismatch rather than as wrong output.

    test("a `string` constant", async () => {
        const result = await run(
            "global-string",
            `const NAME: string = "sol";

       export function main(): i32 {
         console.log(NAME);
         console.log(\`\${NAME.length}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("sol\n3\n");
    });

    test("copying one clones the buffer and leaves the static alone", async () => {
        // The case the allocation check is for: the local's scope frees its clone,
        // and nothing frees the static. If the copy were a share, the count would be
        // wrong in one direction; if the static were freed, in the other.
        const result = await run(
            "global-string-copy",
            `const NAME: string = "sol";

       function shout(s: string): string {
         return s + "!";
       }

       export function main(): i32 {
         const copy: string = NAME;
         console.log(copy);
         console.log(shout(NAME));
         console.log(NAME);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("sol\nsol!\nsol\n");
    });

    test("a `readonly T[]` constant, and its elements", async () => {
        const result = await run(
            "global-array",
            `const PLANETS: readonly string[] = ["mercury", "venus", "earth"];
       const MASSES: readonly f64[] = [0.055, 0.815, 1.0];

       export function main(): i32 {
         console.log(\`\${PLANETS[2]} \${PLANETS.length} \${MASSES[1]}\`);
         PLANETS.forEach((p) => { console.log(p); });
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("earth 3 0.815\nmercury\nvenus\nearth\n");
    });

    test("an empty one costs no object at all", async () => {
        // Zeroed bytes are a null handle and the runtime reads a null handle as
        // empty, so this is one `Zero` leaf and no side object.
        const {project, result} = await compileSource(
            "global-array-empty",
            `const NOTHING: readonly i32[] = [];

       export function main(): i32 {
         return cast<i32>(NOTHING.length);
       }\n`,
            {emitIr: true},
        );
        expect(result.ok).toBe(true);

        const ir = readFileSync(`${project.dir}/build/main.ll`, "utf8");
        expect(ir).toContain("$NOTHING = internal constant ptr zeroinitializer");
        expect(ir).not.toContain("__gf_ga$");
    });

    test("a non-empty one is a header plus elements, with `cap = 0`", async () => {
        const {project, result} = await compileSource(
            "global-array-object",
            `const MASSES: readonly f64[] = [1.5, 2.5];

       export function main(): i32 {
         return cast<i32>(MASSES.length);
       }\n`,
            {emitIr: true},
        );
        expect(result.ok).toBe(true);

        const ir = readFileSync(`${project.dir}/build/main.ll`, "utf8");
        const object = ir.split("\n").find((line) => line.includes("__gf_ga$"));
        // `len = 2`, then `cap = 0` — the marker that says the allocator never
        // handed this out, so freeing it is a no-op.
        expect(object).toContain("i64 2, i64 0");
        // And the handle points past the sixteen-byte header, which is what a `T[]`
        // is everywhere else.
        expect(ir).toContain("i64 16)");
    });

    test("a struct can hold a string", async () => {
        const result = await run(
            "global-struct-string",
            `interface Named { id: i32; label: string; }

       const SOL: Named = { id: 1, label: "sol" };

       export function main(): i32 {
         console.log(\`\${SOL.id} \${SOL.label}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 sol\n");
    });

    test("an array of structs", async () => {
        const result = await run(
            "global-array-structs",
            `interface Body { mass: f64; id: i32; }

       const BODIES: readonly Body[] = [
         { mass: 1.5, id: 1 },
         { mass: 2.5, id: 2 },
       ];

       export function main(): i32 {
         console.log(\`\${BODIES[0].mass} \${BODIES[1].id} \${BODIES.length}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1.5 2 2\n");
    });

    test("a `static readonly` string works the same way", async () => {
        const result = await run(
            "global-static-string",
            `class Build {
         static readonly version: string = "0.3.0";
       }

       export function main(): i32 {
         console.log(Build.version);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("0.3.0\n");
    });

    test("a mutable array is refused, and says what to write", async () => {
        // `const` stops the name being rebound and nothing else, so `push` and
        // `xs[0] = v` would both still be allowed and both would write to read-only
        // memory. `readonly T[]` is the type that has neither.
        const diagnostic = await expectRejected(
            "global-array-mutable",
            `const XS: i32[] = [1, 2];

       export function main(): i32 {
         return cast<i32>(XS.length);
       }\n`,
            "GF0008",
        );
        expect(diagnostic.message).toContain("readonly");
    });

    test("an array nested in a struct is refused", async () => {
        // There is nowhere to say `readonly` about a field's element type from the
        // outside, so this is refused rather than guessed at.
        await expectRejected(
            "global-nested-array",
            `interface Holder { xs: readonly i32[]; }

       const H: Holder = { xs: [1] };

       export function main(): i32 {
         return cast<i32>(H.xs.length);
       }\n`,
            "GF0008",
        );
    });

    test("building a string does not fold", async () => {
        const diagnostic = await expectRejected(
            "global-string-concat",
            `const NAME: string = "so" + "l";

       export function main(): i32 {
         console.log(NAME);
         return 0;
       }\n`,
            "GF0007",
        );
        expect(diagnostic.message).toContain("literal");
    });
});

describe("a function's address in a constant", () => {
    test("a dispatch table, indexed at run time", async () => {
        // C's `int (*fns[])(int)`. A code address is decided by the linker rather
        // than by the program, which is what makes it something a constant can hold.
        const result = await run(
            "global-dispatch",
            `function double(a: i32): i32 { return a * 2; }
       function triple(a: i32): i32 { return a * 3; }
       function negate(a: i32): i32 { return -a; }

       const HANDLERS: FixedArray<(a: i32) => i32, 3> =
         fixedArrayOf(double, triple, negate);

       export function main(): i32 {
         let total: i32 = 0;
         let i: usize = 0;
         while (i < 3) {
           total = total + HANDLERS[i](10);
           i = i + 1;
         }
         console.log(\`\${total}\`);
         return 0;
       }\n`,
        );
        // 20 + 30 - 10.
        expect(result.stdout).toBe("40\n");
    });

    test("one on its own, and a null one", async () => {
        const result = await run(
            "global-fnptr",
            `function answer(): i32 { return 42; }

       const ANSWER: () => i32 = answer;
       const NONE: (() => i32) | null = null;

       export function main(): i32 {
         return NONE === null ? ANSWER() : 0;
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("a closure does not fold, and says why", async () => {
        const diagnostic = await expectRejected(
            "global-closure",
            `const F: (a: i32) => i32 = (a) => a * 2;

       export function main(): i32 {
         return F(1);
       }\n`,
            "GF0007",
        );
        expect(diagnostic.message).toContain("capture");
    });
});

describe("`std/linalg` constants", () => {
    test("a vector written out component by component", async () => {
        const result = await run(
            "global-linalg",
            `import { dvec3 } from "std/linalg";

       const UP: dvec3 = new dvec3(0, 1, 0);
       const ORIGIN: dvec3 = dvec3.zero();
       const G: f64 = -9.81;

       export function main(): i32 {
         const gravity: dvec3 = UP.scale(G);
         console.log(\`\${UP.x} \${UP.y} \${ORIGIN.y} \${gravity.y}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("0 1 0 -9.81\n");
    });

    test("a table of them", async () => {
        const result = await run(
            "global-linalg-table",
            `import { dvec3 } from "std/linalg";

       const AXES: FixedArray<dvec3, 3> = fixedArrayOf(
         new dvec3(1, 0, 0),
         new dvec3(0, 1, 0),
         new dvec3(0, 0, 1),
       );

       export function main(): i32 {
         console.log(\`\${AXES[0].x} \${AXES[1].y} \${AXES[2].z}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 1 1\n");
    });

    test("a factory that has to compute something does not fold", async () => {
        const diagnostic = await expectRejected(
            "global-linalg-splat",
            `import { dvec3 } from "std/linalg";

       const TWOS: dvec3 = dvec3.splat(2);

       export function main(): i32 {
         return cast<i32>(TWOS.x);
       }\n`,
            "GF0007",
        );
        expect(diagnostic.message).toContain("new dvec3");
    });
});

describe("a constant some other build defines", () => {
    test("`declare const` is an extern data symbol, and only if read", async () => {
        const {project, result} = await compileSource(
            "global-extern",
            `declare const gf_probe_read: i32;
       declare const gf_probe_unread: i32;

       export function main(): i32 {
         return gf_probe_read;
       }\n`,
            {emitIr: true},
        );
        // It does not link — nothing defines it — but it compiles, and the IR is
        // where the declaration is checked.
        const ir = readFileSync(`${project.dir}/build/main.ll`, "utf8");
        expect(ir).toContain("@gf_probe_read = external global i32");
        // The one nothing reads costs no undefined symbol. The MIR extern is made
        // at the first read, which is the rule an extern *function* follows too.
        expect(ir).not.toContain("gf_probe_unread");
        // The symbol is the bare name, verbatim: that is the only thing the two
        // sides share, so mangling it would be this compiler inventing a contract.
        expect(ir).not.toContain("__gf_g$");
        expect(result.ok).toBe(false);
    });

    test("nothing defining it is an unresolved external, not a silent zero", async () => {
        const {result} = await compileSource(
            "global-extern-unresolved",
            `declare const gf_no_such_constant: i32;

       export function main(): i32 {
         return gf_no_such_constant;
       }\n`,
        );
        expect(result.ok).toBe(false);
        const message = result.diagnostics.map((d) => d.message).join("\n");
        expect(message).toContain("gf_no_such_constant");
    });

    test("folding through an imported constant is refused, and says why", async () => {
        const diagnostic = await expectRejected(
            "global-extern-fold",
            `declare const gf_probe_base: i32;

       const DERIVED: i32 = gf_probe_base + 1;

       export function main(): i32 {
         return DERIVED;
       }\n`,
            "GF0007",
        );
        expect(diagnostic.message).toContain("linker");
    });

    test("a library's constant crosses by its source, not by its symbol", async () => {
        // The recommended path, and the one that works. A Goblin library's exported
        // constant is emitted under a module-qualified symbol, so a consumer cannot
        // name it with `declare const` — and does not need to: importing the source
        // folds the value into the consumer, which is the same way DECISIONS §25 has
        // a generic cross a library boundary.
        const {project: libProject, result: lib} = await compileSource(
            "global-lib",
            "export function unused(): i32 { return 0; }\n",
            {
                type: "static-lib",
                files: {"consts.ts": "export const LIB_LIMIT: i32 = 11;\n"},
            },
        );
        expect(lib.ok).toBe(true);

        const source = join(dirname(libProject.entry), "consts.ts").replaceAll("\\", "/");
        const result = await run(
            "global-lib-app",
            `import { LIB_LIMIT } from "${source}";

       export function main(): i32 {
         console.log(\`\${LIB_LIMIT}\`);
         return 0;
       }\n`,
            {nativeLibs: [lib.output!]},
        );
        expect(result.stdout).toBe("11\n");
    });
});

describe("`static` fields", () => {
    test("a `static readonly` is a constant the class name reaches", async () => {
        const result = await run(
            "static-readonly",
            `class Physics {
         static readonly gravity: f64 = 9.81;
         static readonly steps: i32 = 4;
       }

       export function main(): i32 {
         console.log(\`\${Physics.gravity} \${Physics.steps}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("9.81 4\n");
    });

    test("a plain `static` is writable, and lives in `.data`", async () => {
        // The one mutable global in the language. `.data` rather than `.rodata`,
        // because writing to a read-only page is a fault rather than a store.
        const {project, result} = await compileSource(
            "static-mutable",
            `class Counter {
         static frames: u64 = 0;
         static readonly limit: i32 = 60;
       }

       export function main(): i32 {
         Counter.frames = 7;
         Counter.frames = Counter.frames + 1;
         Counter.frames += 2;
         Counter.frames++;
         console.log(\`\${Counter.frames} \${Counter.limit}\`);
         return 0;
       }\n`,
            {emitIr: true},
        );
        expect(result.ok).toBe(true);

        const ir = readFileSync(`${project.dir}/build/main.ll`, "utf8");
        const frames = ir.split("\n").find((line) => line.includes("$Counter$frames = "));
        const limit = ir.split("\n").find((line) => line.includes("$Counter$limit = "));
        expect(frames).toContain("internal global i64 0");
        expect(limit).toContain("internal constant i32 60");
    });

    test("every way of writing one works", async () => {
        const result = await run(
            "static-writes",
            `class Counter {
         static frames: u64 = 0;
       }

       export function main(): i32 {
         Counter.frames = 7;
         Counter.frames = Counter.frames + 1;
         Counter.frames += 2;
         Counter.frames++;
         console.log(\`\${Counter.frames}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("11\n");
    });

    test("a derived class shares the variable, it does not copy it", async () => {
        // What C++, TypeScript and Java all mean by a static: `D.n` *is* `C.n`. A
        // copy per derived class would be a silent difference rather than a visible
        // one, so this is asserted through a write on one name and a read on the
        // other.
        const result = await run(
            "static-inherited",
            `class Base {
         static count: i32 = 0;
       }
       class Derived extends Base {}

       export function main(): i32 {
         Base.count = 5;
         console.log(\`\${Derived.count}\`);
         Derived.count = 9;
         console.log(\`\${Base.count}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("5\n9\n");
    });

    test("writing a `static readonly` is tsc's refusal", async () => {
        // Which is why the compiler has no rule about it: `readonly` is enforced
        // where the program is type-checked, so there is nothing here to catch.
        const {result} = await compileSource(
            "static-readonly-write",
            `class C {
         static readonly n: i32 = 1;
       }

       export function main(): i32 {
         C.n = 5;
         return C.n;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2540");
    });

    test("a static on a generic class is refused once, at the declaration", async () => {
        // Reported where the mistake is rather than at each instantiation, and the
        // instantiation still builds — otherwise one unrelated line takes every use
        // of `Box<i32>` down with it.
        const {result} = await compileSource(
            "static-generic",
            `class Box<T> {
         static readonly zero: i32 = 0;
         constructor(readonly v: T) {}
       }

       export function main(): i32 {
         const b: Box<i32> = new Box<i32>(1);
         return b.v;
       }\n`,
        );
        expect(result.ok).toBe(false);
        const refusals = result.diagnostics.filter((d) => d.severity === "error");
        expect(refusals.length).toBe(1);
        expect(refusals[0]?.code).toBe("GF0001");
        expect(refusals[0]?.message).toContain("generic class `Box`");
    });

    test("the `readonly` array rule applies here too", async () => {
        // `static readonly xs: i32[]` makes the *field* read-only and says nothing
        // about its elements, so `C.xs[0] = v` would still type-check — and would
        // write into the read-only object the elements live in.
        const diagnostic = await expectRejected(
            "static-array-mutable",
            `class C {
         static readonly xs: i32[] = [1, 2];
       }

       export function main(): i32 {
         return cast<i32>(C.xs.length);
       }\n`,
            "GF0008",
        );
        expect(diagnostic.message).toContain("readonly");
    });

    test("a static with no value is refused", async () => {
        const {result} = await compileSource(
            "static-no-value",
            `class C {
         static n: i32;
       }

       export function main(): i32 {
         return C.n;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("GF0002");
    });

    test("a static field folds against a module constant", async () => {
        const result = await run(
            "static-from-const",
            `const BASE: i32 = 10;

       class C {
         static readonly derived: i32 = BASE * 2;
       }

       export function main(): i32 {
         return C.derived;
       }\n`,
        );
        expect(result.exitCode).toBe(20);
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

    test("a class cannot be a constant, and the message names both types", async () => {
        // `string` and `readonly T[]` used to be here. What is left is the type that
        // genuinely cannot: a class has a vtable pointer, which is a relocation onto
        // a table, and slices when copied.
        const diagnostic = await expectRejected(
            "global-class",
            `class Body { mass: f64 = 1; }
       interface Holder { body: Body; }

       const H: Holder = { body: new Body() };

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0008",
        );
        expect(diagnostic.message).toContain("Holder");
        expect(diagnostic.message).toContain("Body");
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
            `function compute(): i32 { return 1; }

       const UNUSED: i32 = compute();

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0007",
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
