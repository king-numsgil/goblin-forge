/**
 * `FixedArray<T, N>` — the inline array.
 *
 * This is C's `T name[N]`, and the property everything else follows from is
 * that it **is** the bytes rather than a pointer to them. A C array decays to a
 * pointer in expression contexts, which is where the intuition that it *is* one
 * comes from — but `sizeof` says otherwise, as a struct field it occupies its
 * whole layout, and copying the parent copies the elements with it.
 *
 * Its storage class is therefore `Inline` (REWRITE-PLAN §4.2), not "stack": a
 * fixed array inside a heap object is on the heap and is still inline.
 *
 * Layout is checked against a C compiler in `layout.test.ts`; these test what
 * the language does with it. Every one of them also asserts the live allocation
 * count is zero afterwards, automatically.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("fixed arrays", () => {
  test("elements read and write, by constant and by computed index", async () => {
    const result = await run(
      "array-indexing",
      `export function main(): i32 {
         const buf: FixedArray<i32, 4> = fixedArray(4, 0);
         buf[0] = 10;
         buf[1] = 20;
         let i: usize = 2;
         buf[i] = 30;
         console.log(\`\${buf[0]} \${buf[1]} \${buf[2]} \${buf[3]}\`);
         return 0;
       }\n`,
    );
    // The fourth is still the fill: every element is constructed, not left as
    // whatever was on the stack.
    expect(result.stdout).toBe("10 20 30 0\n");
  });

  test("`length` is a constant, not a load", async () => {
    // The length is in the type, which is the whole difference between this and
    // the `T[]` that will one day be the `std::vector` equivalent.
    const result = await run(
      "array-length",
      `export function main(): i32 {
         const buf: FixedArray<u8, 7> = fixedArray(7, 1);
         console.log(\`\${buf.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("7\n");
  });

  test("an array is a value: binding copies the elements", async () => {
    const result = await run(
      "array-value-semantics",
      `export function main(): i32 {
         const a: FixedArray<i32, 3> = fixedArray(3, 1);
         const b: FixedArray<i32, 3> = a;
         b[0] = 99;
         console.log(\`a[0]=\${a[0]} b[0]=\${b[0]}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("a[0]=1 b[0]=99\n");
  });

  test("every element gets its own copy of the fill", async () => {
    // Moving the fill into the first element would leave every other one
    // holding whatever the move left behind — which is exactly what happened
    // before the fill was made a copy per iteration.
    const result = await run(
      "array-fill-copies",
      `export function main(): i32 {
         const names: FixedArray<string, 3> = fixedArray(3, "x" + "y");
         names[0] = "a" + "b";
         console.log(\`\${names[0]} \${names[1]} \${names[2]}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ab xy xy\n");
    expect(result.leaked).toBe(0);
  });

  test("an owning element is destroyed by the array", async () => {
    const result = await run(
      "array-owning-elements",
      `export function main(): i32 {
         let round: i32 = 0;
         while (round < 20) {
           const names: FixedArray<string, 4> = fixedArray(4, "value" + "!");
           round = round + 1;
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("elements of struct type are inline and addressable", async () => {
    const result = await run(
      "array-struct-elements",
      `interface Point { x: i32; y: i32; }

       export function main(): i32 {
         const pts: FixedArray<Point, 2> = fixedArray(2, { x: 1, y: 2 });
         pts[1].x = 7;
         console.log(\`\${pts[0].x} \${pts[1].x} \${pts[1].y}\`);
         return 0;
       }\n`,
    );
    // Only the second changed, and its other field kept the fill.
    expect(result.stdout).toBe("1 7 2\n");
  });

  test("an array inside a struct is inline, and copies with it", async () => {
    const result = await run(
      "array-in-struct",
      `interface Buffer { data: FixedArray<i32, 3>; tag: i32; }

       export function main(): i32 {
         const a: Buffer = { data: fixedArray(3, 5), tag: 1 };
         const b: Buffer = a;
         b.data[0] = 42;
         console.log(\`\${a.data[0]} \${b.data[0]} \${b.tag}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("5 42 1\n");
  });
});

describe("the type carries the length", () => {
  test("two lengths are different types", async () => {
    const { result } = await compileSource(
      "array-length-identity",
      `export function main(): i32 {
         const a: FixedArray<i32, 8> = fixedArray(8, 0);
         const b: FixedArray<i32, 4> = a;
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    // tsc says so, which is the right half of the compiler for it: the length
    // is a literal type, so `8` is not assignable to `4`.
    expect(errorCodes(result)).toContain("TS2322");
  });

  test("a pointer does not become a fixed array", async () => {
    // The length brand is *required*, unlike the width brand. An optional one
    // would be optional-and-absent on a plain pointer, and optional-and-absent
    // is assignable — so any pointer would silently become an array of
    // whatever length was asked for (REWRITE-PLAN §7's trap, in a new place).
    const { result } = await compileSource(
      "array-from-pointer",
      `export function main(): i32 {
         const p: Pointer<u8> = allocArray<u8>(16);
         const wrong: FixedArray<u8, 16> = p;
         p.freeArray();
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
  });

  test("a fixed array decays to a pointer", async () => {
    // C's array-to-pointer conversion, and what makes a C function taking
    // `uint8_t*` callable with one. Only tsc's half is checked here — the C
    // boundary itself arrives with milestone 7.
    const { result } = await compileSource(
      "array-decay",
      `declare function takesPointer(p: Pointer<u8>): void;

       export function main(): i32 {
         const buf: FixedArray<u8, 8> = fixedArray(8, 0);
         const p: Pointer<u8> = buf;
         return 0;
       }\n`,
    );
    // No TS error about the assignment; the remaining gaps are lowering ones.
    expect(errorCodes(result).filter((code) => code.startsWith("TS"))).toEqual([]);
  });
});

describe("what fixed arrays are not", () => {
  test("`push` is not in the language", async () => {
    const { result } = await compileSource(
      "array-push",
      `export function main(): i32 {
         const buf: FixedArray<i32, 2> = fixedArray(2, 0);
         buf.push(1);
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    // tsc, not the compiler: the method simply is not on the type, so the user
    // sees it while typing rather than at build time.
    expect(errorCodes(result)).toContain("TS2339");
  });

  test("`T[]` is a different type, and the two do not convert", async () => {
    // Both are arrays and neither is the other: a `FixedArray` *is* its
    // elements and allocates nothing, a `T[]` is a handle to a heap buffer it
    // owns. tsc keeps them apart, which is where a user meets the distinction.
    const { result } = await compileSource(
      "array-fixed-vs-vector",
      `export function main(): i32 {
         const fixed: FixedArray<i32, 2> = fixedArray(2, 0);
         const heap: i32[] = fixed;
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
  });
});

describe("fixed array edges", () => {
  test("a zero-length array is legal and has length zero", async () => {
    const result = await run(
      "array-zero",
      `export function main(): i32 {
         const a: FixedArray<u8, 0> = fixedArray(0, 0);
         return cast<i32>(a.length);
       }\n`,
    );
    expect(result.exitCode).toBe(0);
  });

  test("an index has to be a `usize`, and an `i32` counter does not qualify", async () => {
    // `length` is a `usize`, so a loop written against it indexes fine. A loop
    // counter declared `i32` — the width most people reach for — does not, and
    // the diagnostic is a width error rather than anything about arrays.
    const diagnostic = await expectRejected(
      "array-index-i32",
      `export function main(): i32 {
         const a: FixedArray<i32, 4> = fixedArray(4, 0);
         let i: i32 = 0;
         while (i < 4) { a[i] = i; i = i + 1; }
         return a[3];
       }\n`,
      "GF0161",
    );
    expect(diagnostic.message).toContain("usize");
  });

  test("a `usize` counter indexes, and `length` is the natural bound", async () => {
    const result = await run(
      "array-index-usize",
      `export function main(): i32 {
         const a: FixedArray<i32, 4> = fixedArray(4, 0);
         let i: usize = 0;
         while (i < a.length) { a[i] = cast<i32>(i) * 2; i = i + 1; }
         return a[3];
       }\n`,
    );
    expect(result.exitCode).toBe(6);
  });

  test("an `i32` converted with `cast` indexes too", async () => {
    const result = await run(
      "array-index-cast",
      `export function main(): i32 {
         const a: FixedArray<i32, 4> = fixedArray(4, 7);
         const i: i32 = 2;
         return a[cast<usize>(i)];
       }\n`,
    );
    expect(result.exitCode).toBe(7);
  });

  test("indexing is unchecked, exactly as the prelude says", async () => {
    // Not an assertion about the *value* — there is no value to assert, the
    // read is out of bounds. The assertion is that nothing checks it and
    // nothing crashes, which is what "unchecked, like every other memory
    // access here" commits to.
    const result = await run(
      "array-oob",
      `export function main(): i32 {
         const a: FixedArray<u8, 2> = fixedArray(2, 0);
         const v: u8 = a[5];
         return 0;
       }\n`,
    );
    expect(result.exitCode).toBe(0);
  });

  test("a four-kilobyte array is inline storage, and the last element is reachable", async () => {
    const result = await run(
      "array-big",
      `export function main(): i32 {
         const a: FixedArray<u8, 4096> = fixedArray(4096, 1);
         return cast<i32>(a[4095]);
       }\n`,
    );
    expect(result.exitCode).toBe(1);
  });

  test("`length` is usable as an ordinary `usize`", async () => {
    const result = await run(
      "array-length-value",
      `export function main(): i32 {
         const a: FixedArray<u8, 8> = fixedArray(8, 0);
         const n: usize = a.length;
         return cast<i32>(n);
       }\n`,
    );
    expect(result.exitCode).toBe(8);
  });

  test("an array of an array cannot be built from a nested `fixedArray` call", async () => {
    // `fixedArray<T, N>(length, fill)` takes the fill by value, and the width
    // pass has no width for a `FixedArray` fill, so the inner call is rejected
    // before the outer one is considered. There is no other spelling for a
    // two-dimensional array today.
    await expectRejected(
      "array-nested",
      `export function main(): i32 {
         const a: FixedArray<FixedArray<u8, 2>, 2> = fixedArray(2, fixedArray(2, 3));
         return cast<i32>(a[1][1]);
       }\n`,
      "GF0161",
    );
  });
});
