/**
 * The ambient prelude, checked against what the compiler actually implements.
 *
 * `packages/runtime/global.d.ts` is described in the README as "the *entire*
 * global surface of the language", and it is — but a declaration in it is a
 * promise the lowerer has to keep, and most of them are not kept yet. That is
 * fine and it is what `GF0001` is for. What is *not* fine is for one of them to
 * reach the backend, so this file names every global one at a time and pins
 * down which of the three answers it gives: it works, it is `GF0001` with a
 * line, or tsc rejects the call before the compiler is asked.
 *
 * The list being here rather than in a comment is the point. When an intrinsic
 * lands, its test moves from the "not implemented" table to a real one, and the
 * prelude and the compiler cannot drift apart without a red test.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("the intrinsics that are implemented", () => {
  test("`cast` converts between widths", async () => {
    const result = await run(
      "intr-nativecast",
      `export function main(): i32 {
         const a: i64 = 300;
         return cast<i32>(a);
       }\n`,
    );
    expect(result.exitCode).toBe(44);
  });

  test("`move` hands ownership on", async () => {
    const result = await run(
      "intr-move",
      `export function main(): i32 {
         const a: string = "a" + "b";
         console.log(move(a));
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ab\n");
    expect(result.leaked).toBe(0);
  });

  test("`fixedArray` builds an inline array", async () => {
    const result = await run(
      "intr-fixedarray",
      `export function main(): i32 {
         const a: FixedArray<i32, 3> = fixedArray(3, 5);
         return a[0] + a[2];
       }\n`,
    );
    expect(result.exitCode).toBe(10);
  });

  test("`tryCast` answers the downcast question, for a class that says `implements`", async () => {
    // Conversion to a contract is structural, but being *findable* by a
    // dynamic cast is not: the class has to have said `implements`, because
    // that is what puts the itab in its type descriptor rather than at some
    // conversion site the cast has never seen. Without the clause this
    // compiles and answers `null`.
    const result = await run(
      "intr-trycast",
      `interface Speaker { speak(): string; }
       class Dog implements Speaker { speak(): string { return "woof"; } }

       export function main(): i32 {
         const d = new Dog();
         const s = tryCast<Speaker>(d);
         if (s !== null) { console.log(s.speak()); }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("woof\n");
  });

  test("`alloc` constructs on the heap and `free` releases", async () => {
    const result = await run(
      "intr-alloc",
      `class Rect {
         w: i32;
         h: i32;
         constructor(w: i32, h: i32) { this.w = w; this.h = h; }
         area(): i32 { return this.w * this.h; }
       }

       export function main(): i32 {
         const r = alloc(Rect, 6, 7);
         const area: i32 = r.area();
         r.free();
         return area;
       }\n`,
    );
    expect(result.exitCode).toBe(42);
    expect(result.leaked).toBe(0);
  });

  test("`sizeOf` and `alignOf` are the layout, as constants", async () => {
    const result = await run(
      "intr-layout",
      `interface P { x: i32; y: i32; }

       export function main(): i32 {
         const size: usize = sizeOf<P>();
         const align: usize = alignOf<P>();
         const byte: usize = sizeOf<u8>();
         console.log(\`\${size} \${align} \${byte}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("8 4 1\n");
  });

  test("`cstring` borrows and `cstringFree` releases a moved one", async () => {
    const result = await run(
      "intr-cstring",
      `export function main(): i32 {
         const built: string = "a" + "b";
         const c: CString = cstring(move(built));
         console.log(\`\${c.length}\`);
         cstringFree(c);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("2\n");
    expect(result.leaked).toBe(0);
  });

  test("`stringFromCString` copies borrowed bytes into an owned string", async () => {
    const result = await run(
      "intr-string-from-cstring",
      `export function main(): i32 {
         const built: string = "a" + "b";
         const copied: string = stringFromCString(cstring(built));
         console.log(\`\${copied} \${copied.length}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ab 2\n");
    // Two allocations, both released: `built` by its own binding, `copied` by
    // its. If this were an adoption rather than a copy it would be a double
    // free rather than a leak, and the count would not say so.
    expect(result.leaked).toBe(0);
  });

  test("`allocArray` and `freeArray` — see `tests/heap.test.ts`", async () => {
    const result = await run(
      "intr-alloc-array",
      `export function main(): i32 {
         const xs = allocArray<u8>(4);
         xs[3] = 9;
         const v: u8 = xs[3];
         xs.freeArray();
         return cast<i32>(v);
       }\n`,
    );
    expect(result.exitCode).toBe(9);
    expect(result.leaked).toBe(0);
  });

  test("`p.address`, `p.deref()` and `p.offset()` — see `tests/heap.test.ts`", async () => {
    const result = await run(
      "intr-pointer-methods",
      `export function main(): i32 {
         const p = alloc<i32>();
         p[0] = 7;
         const q = p.offset(0);
         const same: boolean = q.address === p.address;
         const v: i32 = q[0];
         p.free();
         return same ? v : 0;
       }\n`,
    );
    expect(result.exitCode).toBe(7);
    expect(result.leaked).toBe(0);
  });
});

describe("the intrinsics the prelude declares and the lowerer does not have", () => {
  // Every one of these is a promise `global.d.ts` makes. Until it is kept, the
  // only acceptable answer is GF0001 with a file and a line — never a backend
  // failure, and never a wrong number.
  const cases: [string, string][] = [
    ["erase", "  const p = alloc<i32>();\n  const e = p.erase();\n  p.free();\n  return 0;"],
    ["reify", "  const p = alloc<i32>();\n  const r = p.reify<u8>();\n  p.free();\n  return 0;"],
  ];

  for (const [name, body] of cases) {
    test(`\`${name}\` is GF0001, with a position`, async () => {
      const diagnostic = await expectRejected(
        `intr-missing-${name}`,
        `export function main(): i32 {\n${body}\n}\n`,
        "GF0001",
      );
      expect(diagnostic.location?.line).toBeGreaterThan(0);
      expect(diagnostic.location?.file).toContain("main.ts");
    });
  }

  test("a fixed array does not decay to a pointer yet", async () => {
    // C's array-to-pointer conversion, and the one part of `Pointer<T>` that is
    // still missing now that the type itself exists.
    await expectRejected(
      "intr-array-decay",
      `export function main(): i32 {
         const buf: FixedArray<u8, 4> = fixedArray(4, 0);
         const p: Pointer<u8> = buf;
         return 0;
       }\n`,
      "GF0161",
    );
  });

  test("`Reference<T>` may only be written for a contract, so far", async () => {
    const diagnostic = await expectRejected(
      "intr-reference-type",
      `interface S { a: i32; }
       function f(r: Reference<S>): i32 { return r.a; }

       export function main(): i32 {
         const s: S = { a: 3 };
         return f(s);
       }\n`,
      "GF0001",
    );
    expect(diagnostic.message).toContain("Reference");
  });

  test("`T[]` is implemented — see `tests/arrays.test.ts`", async () => {
    const result = await run(
      "intr-array-type",
      `export function main(): i32 {
         const a: i32[] = [1, 2, 3];
         a.push(4);
         return a[3];
       }\n`,
    );
    expect(result.exitCode).toBe(4);
  });
});

describe("the `String` methods the prelude declares", () => {
  // `length` works. The other three are declared with their exact semantics
  // written out — clamping, byte offsets, the zero that means "inside a
  // multi-byte character" — and none of them is lowered.
  const cases: [string, string][] = [
    ["substring", '  const s: string = "hello";\n  console.log(s.substring(1, 3));\n  return 0;'],
    ["indexOf", '  const s: string = "hello";\n  const i: isize = s.indexOf("ll");\n  return cast<i32>(i);'],
    ["codePointAt", '  const s: string = "hello";\n  const c: u32 = s.codePointAt(0);\n  return cast<i32>(c);'],
  ];

  for (const [name, body] of cases) {
    test(`\`${name}\` is GF0001`, async () => {
      await expectRejected(
        `intr-string-${name}`,
        `export function main(): i32 {\n${body}\n}\n`,
        "GF0001",
      );
    });
  }

  test("`length` on a literal is GF0001, though it is on a binding", async () => {
    await expectRejected(
      "intr-length-literal",
      `export function main(): i32 {
         return cast<i32>("abc".length);
       }\n`,
      "GF0001",
    );

    const result = await run(
      "intr-length-binding",
      `export function main(): i32 {
         const s: string = "abc";
         return cast<i32>(s.length);
       }\n`,
    );
    expect(result.exitCode).toBe(3);
  });
});

describe("intrinsics used wrongly", () => {
  test("`cstring` of a temporary is GF0234, not a dangling borrow", async () => {
    await expectRejected(
      "intr-cstring-temp",
      `export function main(): i32 {
         const c: CString = cstring("a" + "b");
         return 0;
       }\n`,
      "GF0234",
    );
  });

  test("`cstringFree` of a `string` is refused, and tsc refuses it first", async () => {
    const { result } = await compileSource(
      "intr-cstring-free-string",
      `export function main(): i32 {
         const s: string = "a" + "b";
         cstringFree(s);
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).length).toBeGreaterThan(0);
  });

  test("`tryCast` to something that is neither a class nor a contract is GF0001", async () => {
    await expectRejected(
      "intr-trycast-struct",
      `interface Shape { a: i32; }
       interface Speaker { speak(): string; }

       export function main(): i32 {
         const s: Shape = { a: 1 };
         const r = tryCast<Speaker>(s);
         if (r !== null) { return 1; }
         return 0;
       }\n`,
      "GF0001",
    );
  });

  test("`cast` of a string is refused, and tsc refuses it first", async () => {
    // `cast<T extends number>(value: number)`, so anything that is not a
    // `number` never reaches the compiler's own check. GF0163 therefore has no
    // program that raises it today — see `tests/diagnostics.test.ts`.
    const { result } = await compileSource(
      "intr-nativecast-string",
      `export function main(): i32 {
         const s: string = "a";
         const n: i32 = cast<i32>(s);
         return n;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
  });

  test("an `as` expression is GF0001, so it is not an escape hatch either", async () => {
    await expectRejected(
      "intr-as-expression",
      `export function main(): i32 {
         const s: string = "a";
         const n: i32 = cast<i32>(s as unknown as number);
         return n;
       }\n`,
      "GF0001",
    );
  });

  test.failing("`cast` of a `boolean` is documented and unreachable", async () => {
    // `global.d.ts` says cast "converts between the twelve fixed widths
    // and from `boolean` to a width", GF0163's explanation repeats it, and the
    // lowerer has a `BoolToInt` cast kind waiting. The declared signature takes
    // a `number`, so tsc rejects every call that would use it.
    const result = await run(
      "intr-nativecast-bool",
      `export function main(): i32 {
         const b: boolean = true;
         return cast<i32>(b);
       }\n`,
    );
    expect(result.exitCode).toBe(1);
  });
});
