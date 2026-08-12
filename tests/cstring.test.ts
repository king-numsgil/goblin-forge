/**
 * `CString`, the borrowed half of the string pair.
 *
 * `string` and `CString` are `String` and `&str`, or `std::string` and
 * `string_view` — the split every language that takes C seriously ends up
 * making. Two things it buys, and both are checked here:
 *
 * * **A C signature can say which it means.** A returned `string` is always the
 *   caller's to release, because returning an owning value is a move and there
 *   is no way for a function to hand one back and keep it. A returned `CString`
 *   is the case where the signature has stopped talking and documentation has
 *   to start — which is what a C API does anyway.
 * * **The cost of `length` is in the type.** On a `string` it is a load; on a
 *   `CString` it is a `strlen` scan. One syntax, two costs, visible.
 *
 * A `CString` is never released by the scope that holds it. Nothing tracks it,
 * which is the point — this is the unsafe escape hatch, and the tests below are
 * as much about what the compiler *stops* doing as about what it does.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("CString", () => {
  test("borrowing a string's bytes costs nothing and agrees about length", async () => {
    // The same pointer with a different type: a Goblin `string` is already
    // nul-terminated, so there is nothing to convert. The two `length`s are
    // computed completely differently — a load and a scan — and have to agree.
    const result = await run(
      "cstring-borrow",
      `export function main(): i32 {
         const greeting: string = "hello, " + "world";
         const c: CString = cstring(greeting);
         console.log(\`goblin=\${greeting.length} c=\${c.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("goblin=12 c=12\n");
  });

  test("a borrow does not take ownership: the string still releases itself", async () => {
    // The leak assertion is the test. If `cstring` had used `Copy` rather than
    // `Borrow` it would have applied the string's copy operation and allocated
    // a second buffer nothing frees — which is the exact bug the M5 cascade was
    // made of, in a new place.
    const result = await run(
      "cstring-borrow-no-leak",
      `export function main(): i32 {
         let i: i32 = 0;
         let total: usize = 0;
         while (i < 4) {
           const s: string = \`item\${i}\`;
           total = total + cstring(s).length;
           i = i + 1;
         }
         console.log(\`total=\${total}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("total=20\n");
  });

  test("borrowing a temporary is GF0234", async () => {
    // The temporary is released at the end of the statement, so the `CString`
    // could not outlive it by a line. REWRITE-PLAN §4.4: no lifetime extension.
    const diagnostic = await expectRejected(
      "cstring-temporary",
      `export function main(): i32 {
         const c: CString = cstring("a" + "b");
         return 0;
       }\n`,
      "GF0234",
    );
    // The message has to name `move`, because taking the bytes deliberately is
    // a real thing to want and the alternative should not have to be guessed.
    expect(diagnostic.message).toContain("move");
  });

  test("`cstring_free` releases a moved-out string", async () => {
    // The companion to `cstring(move(…))`, and only to that: it calls Goblin's
    // own deallocator, which subtracts sixteen bytes to reach the length
    // header. A `CString` from anywhere else needs *its* library's free.
    const result = await run(
      "cstring-free",
      `export function main(): i32 {
         const s: string = "a" + "bcd";
         const c: CString = cstring(move(s));
         console.log(\`len=\${c.length}\`);
         cstring_free(c);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("len=4\n");
  });

  test("`cstring_free` refuses a `string` — and tsc says so first", async () => {
    // A `string` releases itself; handing one here would free it twice. The
    // brand is what makes this tsc's to catch rather than the lowerer's, which
    // is the better outcome: the editor underlines it while you type. The
    // lowerer keeps its own check anyway, per REWRITE-PLAN §8.
    await expectRejected(
      "cstring-free-string",
      `export function main(): i32 {
         const s: string = "a" + "b";
         cstring_free(s);
         return 0;
       }\n`,
      "TS2345",
    );
  });

  test("a foreign `CString` is freed by whoever allocated it", async () => {
    // The question this type exists to answer, with the two real shapes:
    //
    //   `getenv`  — library-owned, do **not** free   (SDL_GetError)
    //   `_strdup` — yours, freed with *its* free     (SDL_GetPrefPath / SDL_free)
    //
    // Goblin never needs to know which allocator was used, because it is never
    // asked to free them. That is the whole content of "untracked", and it is
    // why there is no `.free()` method: there would be no right answer for it.
    //
    // The leak count is zero because the runtime correctly counts *nothing*
    // here — none of this memory is Goblin's.
    const result = await run(
      "cstring-foreign",
      `declare function getenv(name: CString): CString | null;
       declare function _strdup(source: CString): CString | null;
       declare function free(mem: CString): void;

       export function main(): i32 {
         const path = getenv(cstring("PATH"));
         if (path !== null) { console.log("PATH is set"); } else { console.log("unset"); }

         const copy = _strdup(cstring("borrowed then owned"));
         if (copy !== null) {
           console.log(\`copy len=\${copy.length}\`);
           free(copy);
         }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("PATH is set\ncopy len=19\n");
  });

  test("`cstring(move(s))` takes the bytes out of the compiler's hands", async () => {
    // The unsafe escape hatch, working as designed. `move` makes the string
    // dead, so no destructor runs and the bytes outlive the scope — which is a
    // leak unless somebody frees them, and here somebody does.
    //
    // `gf_string_free` rather than `free`: the allocation starts at the length
    // header, sixteen bytes before the pointer. That is the call the generated
    // C header declares, for exactly this reason.
    const result = await run(
      "cstring-move",
      `declare function gf_string_free(s: CString): void;

       export function main(): i32 {
         const s: string = "a" + "bc";
         const c: CString = cstring(move(s));
         console.log(\`len=\${c.length}\`);
         gf_string_free(c);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("len=3\n");
  });

  test("a moved-from string cannot be read afterwards", async () => {
    // `move` is `move`, whatever it was handed to.
    await expectRejected(
      "cstring-move-then-read",
      `export function main(): i32 {
         const s: string = "a" + "b";
         const c: CString = cstring(move(s));
         console.log(s);
         return 0;
       }\n`,
      "GF0235",
    );
  });

  test("a `CString` crosses to C as a plain `const char *`", async () => {
    // Which is the whole point of the type. Declared with no body, so it is an
    // `extern "C"` import — and `strlen` from the platform's own C library is
    // the most honest possible test that the representation is what it claims.
    const result = await run(
      "cstring-extern",
      `declare function strlen(s: CString): usize;

       export function main(): i32 {
         const s: string = "abcde";
         console.log(\`\${strlen(cstring(s))}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("5\n");
  });
});
