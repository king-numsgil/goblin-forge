/**
 * Goblin source that lives under `node_modules`.
 *
 * tsc calls such a file an "external library", and the lowerer used to filter
 * those out of the program — right for a TypeScript project, where
 * `node_modules` holds JavaScript and `.d.ts`, and wrong for this language in
 * two ways that only appear once the compiler is *installed* rather than
 * checked out:
 *
 * * **`std/collection` ships inside the package**, so a consumer's copy sits at
 *   `node_modules/goblin-forge/std/collection.ts`. Every class in it was
 *   dropped, and the symptom was `GF0001` about a class whose file tsc had
 *   resolved and read — a gap message for something that is right there.
 * * **A Goblin library crosses a boundary as source** (DECISIONS §25),
 *   instantiated in the consumer's own compilation. Same shape, same silence.
 *
 * `0.2.1` shipped both halves of that: a package with no `std/` in it at all,
 * and a compiler that would have skipped it if there had been. This is the
 * second half — the first is the `SHIPPED` check in `packages/forge/build.ts`,
 * which fails the packaging run rather than the release.
 *
 * The library is written straight into `node_modules` rather than through the
 * harness's `files`, deliberately: a file named in the project's tsconfig is a
 * *root* file, which is not what tsc marks as external, so routing it that way
 * would test the wrong thing.
 */

import { describe, expect, test } from "bun:test";
import { compile } from "goblin-forge";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_OPT_LEVEL, runBinary, writeProject } from "./harness.ts";

/** A Goblin library: a class with a destructor's worth of state, and a function. */
const LIBRARY = `export class Counter {
    private total: i32 = 0;

    add(n: i32): void {
        this.total += n;
    }

    get value(): i32 {
        return this.total;
    }
}

export function twice(n: i32): i32 {
    return n * 2;
}
`;

const PROGRAM = `import { Counter, twice } from "widgets/counter.ts";

export function main(): i32 {
    const c = new Counter();
    c.add(20);
    c.add(twice(11));
    const total = c.value;
    console.log(\`total \${total}\`);
    return 0;
}
`;

describe("source under node_modules", () => {
    test("a class and a function are compiled, not skipped", async () => {
        const project = writeProject("node-modules-source", PROGRAM);

        const lib = join(project.dir, "node_modules", "widgets");
        mkdirSync(lib, {recursive: true});
        writeFileSync(join(lib, "counter.ts"), LIBRARY, "utf8");

        const result = await compile({
            entry: project.entry,
            tsconfig: project.tsconfig,
            output: project.output,
            root: project.dir,
            outDir: join(project.dir, "build"),
            type: "bin",
            optLevel: HARNESS_OPT_LEVEL,
            checked: false,
            strictInternalErrors: true,
        });

        // Named rather than just `toBe(true)`: the failure this guards against
        // is a `GF0001` gap message, and reading it is most of the diagnosis.
        expect(result.diagnostics.map((d) => d.code)).toEqual([]);
        expect(result.ok).toBe(true);

        const ran = runBinary("node-modules-source", result.output!);
        expect(ran.stdout).toBe("total 42\n");
        expect(ran.stderr).toBe("");
        expect(ran.exitCode).toBe(0);
        expect(ran.leaked).toBe(0);
    }, 300_000);
});
