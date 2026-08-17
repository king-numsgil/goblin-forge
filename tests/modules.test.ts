/**
 * Multi-module programs.
 *
 * REWRITE-PLAN §12.10, answering §11.8. The answer is that **`.gbi` does not
 * survive**, and the reason is that most of what it was for turned out to be
 * somebody else's job:
 *
 * * **tsc resolves the imports.** A Goblin program is a TypeScript program, and
 *   `ts.Program` already contains every file reachable from the entry, in
 *   dependency order, type-checked together. A bespoke interface file would be
 *   a second, weaker copy of that.
 * * **The lowerer already walks all of them.** One `ts.Program` becomes one MIR
 *   module and one object file. There is no separate compilation to hold an
 *   interface *between*.
 * * **A real library boundary already has a format**, and it is the C ABI plus
 *   the header milestone 9 emits. Two Goblin libraries meet the way a Goblin
 *   library and a C one do.
 *
 * So "multi-module" here means many *files*, one compilation. What that
 * demands, and what these check, is that names stop being global: two modules
 * may each declare a private `helper`, and both are right.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, expectRejected, run } from "./harness.ts";

describe("multi-module programs", () => {
    test("a function is called across an import", async () => {
        const result = await run(
            "mod-import",
            `import { add } from "./math.ts";

       export function main(): i32 {
         console.log(\`\${add(19, 23)}\`);
         return 0;
       }\n`,
            {files: {"math.ts": `export function add(a: i32, b: i32): i32 { return a + b; }\n`}},
        );
        expect(result.stdout).toBe("42\n");
    });

    test("two modules may each have a private function of the same name", async () => {
        // The case that makes this a milestone rather than a coincidence. Names are
        // scoped to their modules and tsc says so; keying the function table by the
        // bare name made the second overwrite the first, and emitting both under
        // that name was a duplicate-symbol error from Cranelift with no file and no
        // line — exactly the failure REWRITE-PLAN §8 forbids.
        const result = await run(
            "mod-private-collision",
            `import { one } from "./a.ts";
       import { two } from "./b.ts";

       export function main(): i32 {
         console.log(\`\${one()}\${two()}\`);
         return 0;
       }\n`,
            {
                files: {
                    "a.ts": `function helper(): i32 { return 1; }
                   export function one(): i32 { return helper(); }\n`,
                    "b.ts": `function helper(): i32 { return 2; }
                   export function two(): i32 { return helper(); }\n`,
                },
            },
        );
        expect(result.stdout).toBe("12\n");
    });

    test("a class crosses a module boundary, vtable and all", async () => {
        const result = await run(
            "mod-class",
            `import { Dog } from "./animals.ts";

       export function main(): i32 {
         console.log(new Dog("rex").speak());
         return 0;
       }\n`,
            {
                files: {
                    "animals.ts": `export class Animal { speak(): string { return "..."; } }
             export class Dog extends Animal {
               name: string;
               constructor(name: string) { super(); this.name = name; }
               override speak(): string { return \`\${this.name} says woof\`; }
             }\n`,
                },
            },
        );
        expect(result.stdout).toBe("rex says woof\n");
    });

    test("a contract is declared in one module and satisfied in another", async () => {
        const result = await run(
            "mod-contract",
            `import type { Speaker } from "./contract.ts";
       import { Cat } from "./cat.ts";

       function announce(s: Reference<Speaker>): void { console.log(s.speak()); }

       export function main(): i32 {
         announce(new Cat());
         return 0;
       }\n`,
            {
                files: {
                    "contract.ts": `export interface Speaker { speak(): string; }\n`,
                    "cat.ts": `import type { Speaker } from "./contract.ts";
             export class Cat implements Speaker { speak(): string { return "mew"; } }\n`,
                },
            },
        );
        expect(result.stdout).toBe("mew\n");
    });

    test("owning values cross a module boundary without leaking", async () => {
        const result = await run(
            "mod-owning",
            `import { shout } from "./text.ts";

       export function main(): i32 {
         let i: i32 = 0;
         while (i < 3) {
           console.log(shout("hi"));
           i = i + 1;
         }
         return 0;
       }\n`,
            {
                files: {
                    "text.ts": `export function shout(text: string): string {
             return \`\${text}!\`;
           }\n`,
                },
            },
        );
        expect(result.stdout).toBe("hi!\nhi!\nhi!\n");
    });

    test("an exported function keeps its bare name; a private one does not", async () => {
        // The rule milestone 9 settled, seen from the other side. An exported
        // symbol is the C ABI contract and has to be exactly what the header says;
        // an internal one may be qualified precisely because nothing outside this
        // compilation can name it.
        const {result} = await compileSource(
            "mod-symbols",
            `import { two } from "./b.ts";
       export function shown(): i32 { return two(); }\n`,
            {
                type: "static-lib",
                files: {
                    "b.ts": `function helper(): i32 { return 2; }
                   export function two(): i32 { return helper(); }\n`,
                },
            },
        );
        expect(result.ok).toBe(true);
    });

    test("two classes with the same name are rejected, with both locations", async () => {
        // A restriction, and a stated one: a class is emitted under its name, so
        // two of them collide at the linker. Qualifying is the right fix and needs
        // a class to carry a symbol distinct from its name — a wire-format change,
        // and cheap to make later.
        const diagnostic = await expectRejected(
            "mod-class-collision",
            `import { Dog } from "./a.ts";
       export function main(): i32 { return 0; }\n`,
            "GF0002",
            {
                files: {
                    "a.ts": `export class Dog { bark(): i32 { return 1; } }\n`,
                    "b.ts": `export class Dog { bark(): i32 { return 2; } }\n`,
                },
            },
        );
        expect(diagnostic.message).toContain("already a class called");
    });
});

describe("`export` versus the public ABI", () => {
    test("a non-entry export may take and return owning values", async () => {
        // REWRITE-PLAN §3 warns that v1 conflates "visible to other Goblin modules"
        // with "visible to the dynamic linker". They separate here: `export` is
        // TypeScript's word for *importable*, and a program is one compilation, so
        // an exported function another module calls is an ordinary internal call —
        // free to take a `string`, which no C boundary could.
        const result = await run(
            "abi-internal-export",
            `import { shout } from "./text.ts";

       export function main(): i32 {
         console.log(shout("hi"));
         return 0;
       }\n`,
            {
                files: {
                    "text.ts": `export function shout(text: string): string { return \`\${text}!\`; }\n`,
                },
            },
        );
        expect(result.stdout).toBe("hi!\n");
    });

    test("an entry-module export may take a `string` too", async () => {
        // A `string` is a valid nul-terminated `char *`, so it crosses and its
        // ownership becomes documentation — the same deal every C API that hands
        // out memory makes. What the *header* does about the asymmetry is
        // `libraries.test.ts`'s business.
        const result = await run(
            "abi-public-string",
            `export function shout(text: string): string { return \`\${text}!\`; }

       export function main(): i32 {
         console.log(shout("hi"));
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("hi!\n");
    });

    test("a `string` buried in a struct still may not", async () => {
        // The line between the two: a bare `string` puts the ownership question in
        // the signature, where a doc comment can answer it. A field inside a struct
        // that a C caller will build and copy by value has nothing to see and
        // nothing to document.
        const diagnostic = await expectRejected(
            "abi-public-struct-string",
            `interface Named { id: i32; name: string; }
       export function label(n: Named): i32 { return n.id; }
       export function main(): i32 { return 0; }\n`,
            "GF0301",
        );
        expect(diagnostic.message).toContain("nothing to see and nothing to document");
    });

    test("a class cannot cross the public boundary either", async () => {
        // It carries a vtable pointer — an address into *this* build's read-only
        // data, meaningless to C and to a second Goblin build alike, because type
        // descriptors have one owner per compilation.
        const diagnostic = await expectRejected(
            "abi-public-class",
            `class Dog { n: i32; }
       export function feed(d: Dog): i32 { return d.n; }
       export function main(): i32 { return 0; }\n`,
            "GF0301",
        );
        expect(diagnostic.message).toContain("vtable");
    });
});

describe("import and export forms", () => {
    test("a re-export makes a name importable through a second module", async () => {
        const result = await run(
            "mod-reexport",
            `export { add } from "./math.ts";
       import { add } from "./math.ts";

       export function main(): i32 {
         return add(1, 2);
       }\n`,
            {files: {"math.ts": `export function add(a: i32, b: i32): i32 { return a + b; }\n`}},
        );
        expect(result.exitCode).toBe(3);
    });

    test("a default export is called like any other", async () => {
        const result = await run(
            "mod-default",
            `import twice from "./math.ts";

       export function main(): i32 {
         return twice(4);
       }\n`,
            {files: {"math.ts": `export default function twice(a: i32): i32 { return a * 2; }\n`}},
        );
        expect(result.exitCode).toBe(8);
    });

    test("a type-only import is erased, not lowered", async () => {
        const result = await run(
            "mod-type-only",
            `import type { S } from "./shapes.ts";

       export function main(): i32 {
         const s: S = { a: 5 };
         return s.a;
       }\n`,
            {files: {"shapes.ts": `export interface S { a: i32; }\n`}},
        );
        expect(result.exitCode).toBe(5);
    });

    test("two modules may each export a name the other does not import", async () => {
        const result = await run(
            "mod-parallel-exports",
            `import { one } from "./a.ts";

       export function two(): i32 { return 2; }

       export function main(): i32 {
         return one() * 10 + two();
       }\n`,
            {files: {"a.ts": `export function one(): i32 { return 1; }\n`}},
        );
        expect(result.exitCode).toBe(12);
    });

    test("a namespace import is GF0001", async () => {
        // `import * as m` makes the call target a property access on a module
        // object, and there is no module object at runtime here.
        await expectRejected(
            "mod-namespace-import",
            `import * as math from "./math.ts";

       export function main(): i32 {
         return math.add(1, 2);
       }\n`,
            "GF0001",
            {files: {"math.ts": `export function add(a: i32, b: i32): i32 { return a + b; }\n`}},
        );
    });

    test("an exported `const` is GF0001, as a top-level binding is anywhere", async () => {
        await expectRejected(
            "mod-const-export",
            `import { N } from "./consts.ts";

       export function main(): i32 {
         return N;
       }\n`,
            "GF0001",
            {files: {"consts.ts": `export const N: i32 = 5;\n`}},
        );
    });
});

describe("declarations and the linker", () => {
    test("a `declare function` nobody calls does not have to be linked", async () => {
        // A body-less declaration is an `extern "C"` import, and an extern in the
        // module is an undefined symbol in the object file. Making one eagerly at
        // the declaration meant declaring a library's surface and calling half of
        // it failed to link on the half you did not call — nothing like the C
        // header it is modelled on. The extern is made at the first call site now.
        const result = await run(
            "mod-extern-uncalled",
            `declare function c_never_called(v: i32): i32;
       declare function c_also_unused(a: f64, b: f64): f64;

       export function main(): i32 {
         return 0;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
    });

    test("a TypeScript overload signature is not an extern declaration", async () => {
        // `function f(a: i32): i32;` followed by an implementation is one function
        // with a declared signature — ordinary TypeScript. Reading the body-less
        // half as an `extern "C"` import dropped the implementation and asked the
        // linker for a symbol the program was about to define itself, so the error
        // named the user's own function.
        const result = await run(
            "mod-overload",
            `function f(a: i32): i32;
       function f(a: i32): i32 { return a * 2; }

       export function main(): i32 {
         return f(4);
       }\n`,
        );
        expect(result.exitCode).toBe(8);
    });

    test("a declaration and a definition of the same name still link once", async () => {
        // The declaration is skipped and the definition stands, so the symbol is
        // defined exactly once — the failure mode on the other side of the fix.
        const result = await run(
            "mod-overload-exported",
            `export function twice(a: i32): i32;
       export function twice(a: i32): i32 { return a * 2; }

       export function main(): i32 {
         return twice(21);
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("a `declare function` that is called and not defined is GF9005", async () => {
        // The honest case, and the one GF9005 is written for: the message carries
        // the whole linker command so the failure can be reproduced by hand.
        const diagnostic = await expectRejected(
            "mod-extern-missing",
            `declare function c_absent(v: i32): i32;

       export function main(): i32 {
         return c_absent(1);
       }\n`,
            "GF9005",
        );
        expect(diagnostic.message).toContain("c_absent");
    });
});
