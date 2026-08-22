/**
 * `std/io` — stdio, with the names spelled out.
 *
 * The second ambient module, and the first one with a *type* in it: `File` is
 * an opaque handle, so a program holds a `Pointer<File>` and can do nothing
 * with it but hand it back. That is the whole safety story, and it is C's.
 *
 * Two properties are worth more than the rest of this file put together, and
 * both are checked by the harness rather than asserted here:
 *
 * * **A file nobody closes is a detected leak.** The handle comes from the same
 *   allocator every other allocation does, so the automatic live-allocation
 *   check counts it. That is the argument for spending an allocation on
 *   something that could have been an integer — an integer would have leaked
 *   the descriptor in silence.
 * * **A string from `fileRead` is owned by the scope that took it.** Every test
 *   here reads one and none of them frees anything, and the leak check is what
 *   says the drop was placed.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run, scratchPath } from "./harness.ts";

describe("std/io", () => {
    test("a file round-trips through write and read", async () => {
        const path = scratchPath("round-trip.txt");
        const result = await run(
            "io-round-trip",
            `import { fileClose, fileOpen, fileRead, fileWrite } from "std/io";

       export function main(): i32 {
         const w = fileOpen("${path}", "w");
         if (w === null) { return 1; }
         const written = fileWrite(w, "hello, file\\n");
         fileClose(w);

         const r = fileOpen("${path}", "r");
         if (r === null) { return 2; }
         const text = fileRead(r, 256);
         fileClose(r);

         console.log(text);
         return cast<i32>(written) - cast<i32>(text.length);
       }\n`,
        );
        expect(result.stdout).toBe("hello, file\n\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("opening a file that is not there is null, not a crash", async () => {
        // The only failure `fileOpen` reports. *Why* is C's `errno`, which has
        // no portable spelling from here — so the type says what can be known.
        const result = await run(
            "io-missing",
            `import { fileOpen } from "std/io";

       export function main(): i32 {
         const f = fileOpen("${scratchPath("no-such-file.txt")}", "r");
         if (f !== null) { return 1; }
         console.log("absent");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("absent\n");
        expect(result.leaked).toBe(0);
    });

    test("a file nobody closes is caught by the leak check", async () => {
        // The reason the handle is an allocation rather than an integer. An
        // integer would have leaked the descriptor and told nobody; this fails
        // the run, without the test having asked it to.
        const path = scratchPath("unclosed.txt");
        await expect(
            run(
                "io-unclosed",
                `import { fileOpen } from "std/io";

       export function main(): i32 {
         const f = fileOpen("${path}", "w");
         if (f === null) { return 1; }
         return 0;
       }\n`,
            ),
        ).rejects.toThrow(/leaked 1 allocation/);
    });

    test("reading past the end gives an empty string", async () => {
        // The whole end-of-file story, and one rule rather than two: a `feof`
        // would answer for a `FILE *` and have nothing to say about `stdin()`.
        const path = scratchPath("short.txt");
        const result = await run(
            "io-eof",
            `import { fileClose, fileOpen, fileRead, fileWrite } from "std/io";

       export function main(): i32 {
         const w = fileOpen("${path}", "w");
         if (w === null) { return 1; }
         fileWrite(w, "ab");
         fileClose(w);

         const r = fileOpen("${path}", "r");
         if (r === null) { return 2; }
         const first = fileRead(r, 64);
         const second = fileRead(r, 64);
         fileClose(r);

         console.log(\`\${first.length} then \${second.length}\`);
         return cast<i32>(second.length);
       }\n`,
        );
        expect(result.stdout).toBe("2 then 0\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("a short read is the bytes asked for, not the whole file", async () => {
        const path = scratchPath("chunked.txt");
        const result = await run(
            "io-chunks",
            `import { fileClose, fileOpen, fileRead, fileWrite } from "std/io";

       export function main(): i32 {
         const w = fileOpen("${path}", "w");
         if (w === null) { return 1; }
         fileWrite(w, "abcdefgh");
         fileClose(w);

         const r = fileOpen("${path}", "r");
         if (r === null) { return 2; }
         const head = fileRead(r, 3);
         const rest = fileRead(r, 64);
         fileClose(r);

         console.log(\`\${head}|\${rest}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("abc|defgh\n");
        expect(result.leaked).toBe(0);
    });

    test("append adds to a file rather than truncating it", async () => {
        const path = scratchPath("appended.txt");
        const result = await run(
            "io-append",
            `import { fileClose, fileOpen, fileRead, fileWrite } from "std/io";

       export function main(): i32 {
         const first = fileOpen("${path}", "w");
         if (first === null) { return 1; }
         fileWrite(first, "one");
         fileClose(first);

         const second = fileOpen("${path}", "a");
         if (second === null) { return 2; }
         fileWrite(second, "two");
         fileClose(second);

         const r = fileOpen("${path}", "r");
         if (r === null) { return 3; }
         console.log(fileRead(r, 64));
         fileClose(r);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("onetwo\n");
        expect(result.leaked).toBe(0);
    });

    test("`stdout()` writes the bytes `console.log` writes", async () => {
        // The reason the standard streams are not `FILE *` here. Through the
        // CRT on Windows every `\n` on the way out becomes `\r\n`, which is
        // invisible in a terminal and breaks every test that compares output —
        // so these go through the same unbuffered path `console.log` uses.
        const result = await run(
            "io-stdout",
            `import { fileWrite, stdout } from "std/io";

       export function main(): i32 {
         fileWrite(stdout(), "one\\ntwo\\n");
         console.log("three");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("one\ntwo\nthree\n");
        expect(result.stderr).toBe("");
        expect(result.leaked).toBe(0);
    });

    test("`stderr()` writes to the other stream", async () => {
        const result = await run(
            "io-stderr",
            `import { fileWrite, stderr, stdout } from "std/io";

       export function main(): i32 {
         fileWrite(stdout(), "out\\n");
         fileWrite(stderr(), "err\\n");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("out\n");
        expect(result.stderr).toBe("err\n");
        expect(result.leaked).toBe(0);
    });

    test("closing a standard stream is a no-op, not a way to lose stdout", async () => {
        // So a function that takes "a file" and closes it when it is done does
        // not have to ask which kind it was handed. The alternative is that
        // `fileClose(stdout())` takes `console.log` down with it, three calls
        // later and nowhere near the mistake.
        const result = await run(
            "io-close-standard",
            `import { fileClose, fileWrite, stdout } from "std/io";

       export function main(): i32 {
         fileClose(stdout());
         fileWrite(stdout(), "still here\\n");
         console.log("and still");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("still here\nand still\n");
        expect(result.leaked).toBe(0);
    });

    test("a handle is opaque: there is nothing to read through it", async () => {
        // What makes `File` a handle rather than a struct. tsc knows the class
        // has no members, so this is its rejection rather than the compiler's —
        // which is the right one, because it arrives while you are typing.
        await expectRejected(
            "io-opaque",
            `import { fileOpen } from "std/io";

       export function main(): i32 {
         const f = fileOpen("${scratchPath("opaque.txt")}", "w");
         if (f === null) { return 1; }
         return f.stream;
       }\n`,
            "TS2339",
        );
    });

    test("the handle survives being passed between functions", async () => {
        // A `Pointer<File>` is one machine word and nothing else, so it crosses
        // a call the way any other pointer does — and the file it names is not
        // copied, closed, or otherwise interfered with on the way.
        const path = scratchPath("passed.txt");
        const result = await run(
            "io-passed",
            `import { File, fileClose, fileOpen, fileWrite } from "std/io";

       function say(f: Pointer<File>, what: string): usize {
         return fileWrite(f, what);
       }

       export function main(): i32 {
         const f = fileOpen("${path}", "w");
         if (f === null) { return 1; }
         const n = say(f, "through a call\\n");
         fileClose(f);
         return cast<i32>(n);
       }\n`,
        );
        expect(result.exitCode).toBe(15);
        expect(result.leaked).toBe(0);
    });

    test("both ambient modules work in one program", async () => {
        // `std/alloc` and `std/io` in the same file, one namespaced and one
        // not. Nothing about a std module is singular, and this is what says so.
        const path = scratchPath("two-modules.txt");
        const result = await run(
            "io-with-alloc",
            `import * as io from "std/io";
       import { mi_free, mi_malloc } from "std/alloc";

       export function main(): i32 {
         const raw = mi_malloc(16);
         if (raw === null) { return 1; }

         const f = io.fileOpen("${path}", "w");
         if (f === null) { mi_free(raw); return 2; }
         io.fileWrite(f, "both\\n");
         io.fileClose(f);

         mi_free(raw);
         console.log("done");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("done\n");
        expect(result.leaked).toBe(0);
    });
});
