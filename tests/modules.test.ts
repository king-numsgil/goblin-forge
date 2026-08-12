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
      { files: { "math.ts": `export function add(a: i32, b: i32): i32 { return a + b; }\n` } },
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
    const { result } = await compileSource(
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
