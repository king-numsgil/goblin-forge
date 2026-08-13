/**
 * `alloc`, `Pointer<T>`, and `free`.
 *
 * C++'s `new T(…)` and `delete`, split the way this compiler splits every other
 * owning operation: the runtime hands out and takes back *storage*, and emitted
 * code constructs and destroys what goes in it. Neither half knows what a `T`
 * is, which is why there is no `alloc` node in the MIR — only `SizeOf` and
 * `AlignOf`, and an ordinary runtime call built from them.
 *
 * Where `new C(…)` gives a value that its scope releases, `alloc` gives a
 * pointer that outlives the scope and **leaks if you drop it**. That is the
 * same distinction C++ draws, and the reason `free()` is something you write.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("alloc and free", () => {
  test("constructs on the heap, and the object works", async () => {
    const result = await run(
      "heap-basic",
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

  test("fields read and write through the pointer, with no dereference written", async () => {
    // The auto-dereference C++ spells `->`. `Pointer<T>` is `T & CorePointer<T>`
    // in the prelude for exactly this reason.
    const result = await run(
      "heap-fields",
      `class R {
         x: i32;
         constructor(x: i32) { this.x = x; }
       }

       export function main(): i32 {
         const r = alloc(R, 5);
         r.x = r.x + 4;
         const v: i32 = r.x;
         r.free();
         return v;
       }\n`,
    );
    expect(result.exitCode).toBe(9);
  });

  test("a class with no constructor takes no arguments", async () => {
    const result = await run(
      "heap-no-ctor",
      `class R { x: i32 = 4; }

       export function main(): i32 {
         const r = alloc(R);
         const v: i32 = r.x;
         r.free();
         return v;
       }\n`,
    );
    expect(result.exitCode).toBe(4);
    expect(result.leaked).toBe(0);
  });

  test("`free` releases what the object owns, not just its storage", async () => {
    const result = await run(
      "heap-owning",
      `class Holder {
         s: string;
         constructor(s: string) { this.s = s; }
       }

       export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) {
           const h = alloc(Holder, \`v\${i}\`);
           i = i + 1;
           h.free();
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("dropping the pointer leaks, which is the whole point of `free`", async () => {
    // Not a bug: `alloc` hands over something whose lifetime the compiler has
    // stopped tracking. The automatic leak check is what makes that visible,
    // and this pins that it stays visible.
    let message = "";
    try {
      await run(
        "heap-leak",
        `class R { x: i32 = 0; }

         export function main(): i32 {
           const r = alloc(R);
           return 0;
         }\n`,
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("leaked 1 allocation");
  });
});

describe("pointers and polymorphism", () => {
  test("a `Pointer<Derived>` is a `Pointer<Base>`, and costs nothing", async () => {
    // A base is a byte-for-byte layout prefix, so the object's address *is* the
    // base subobject's address. Exactly as unsound as `Derived**` to `Base**`
    // is in C++, which is the trade the prelude states.
    const result = await run(
      "heap-upcast",
      `class A { speak(): string { return "A"; } }
       class B extends A { override speak(): string { return "B"; } }

       export function main(): i32 {
         const p: Pointer<A> = alloc(B);
         console.log(p.speak());
         p.free();
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("B\n");
  });

  test("`free` through a base pointer runs the derived destructor", async () => {
    // Virtual destruction, and the reason `free` drops the pointee rather than
    // calling a destructor it picked statically. Both of `B`'s strings have to
    // be released through a `Pointer<A>` that has never heard of the second.
    const result = await run(
      "heap-virtual-destroy",
      `class A { a: string = "a" + "1"; }
       class B extends A { b: string = "b" + "2"; }

       export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) {
           const p: Pointer<A> = alloc(B);
           p.free();
           i = i + 1;
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("a pointer is a parameter like any other, and does not copy", async () => {
    const result = await run(
      "heap-param",
      `class R {
         x: i32;
         constructor(x: i32) { this.x = x; }
       }

       function bump(p: Pointer<R>): void { p.x = p.x + 1; }

       export function main(): i32 {
         const r = alloc(R, 6);
         bump(r);
         bump(r);
         const v: i32 = r.x;
         r.free();
         return v;
       }\n`,
    );
    expect(result.exitCode).toBe(8);
  });

  test("a pointer may be returned, which is what outliving a scope means", async () => {
    const result = await run(
      "heap-return",
      `class R {
         x: i32;
         constructor(x: i32) { this.x = x; }
       }

       function make(x: i32): Pointer<R> { return alloc(R, x); }

       export function main(): i32 {
         const r = make(7);
         const v: i32 = r.x;
         r.free();
         return v;
       }\n`,
    );
    expect(result.exitCode).toBe(7);
    expect(result.leaked).toBe(0);
  });

  test("two pointers compare as addresses", async () => {
    const result = await run(
      "heap-compare",
      `class R { x: i32 = 0; }

       export function main(): i32 {
         const a = alloc(R);
         const b = alloc(R);
         const same: Pointer<R> = a;
         const verdict: i32 = a !== b && a === same ? 0 : 1;
         a.free();
         b.free();
         return verdict;
       }\n`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.leaked).toBe(0);
  });
});

describe("the layout intrinsics", () => {
  test("`nativeSizeOf` and `nativeAlignOf` are constants from the layout engine", async () => {
    const result = await run(
      "heap-layout",
      `interface P { x: i32; y: i32; }
       interface Padded { flag: boolean; value: f64; }

       export function main(): i32 {
         console.log(\`\${nativeSizeOf<P>()} \${nativeAlignOf<P>()}\`);
         console.log(\`\${nativeSizeOf<Padded>()} \${nativeAlignOf<Padded>()}\`);
         console.log(\`\${nativeSizeOf<u8>()} \${nativeSizeOf<FixedArray<u8, 128>>()}\`);
         return 0;
       }\n`,
    );
    // The padded struct is the interesting one: a `boolean` followed by an
    // `f64` is 16 bytes, not 9, and the layout engine is what says so.
    expect(result.stdout).toBe("8 4\n16 8\n1 128\n");
  });

  test("the size of a class includes its vtable pointer", async () => {
    const result = await run(
      "heap-class-size",
      `class Empty { }
       class One { x: i32; }

       export function main(): i32 {
         console.log(\`\${nativeSizeOf<Empty>()} \${nativeSizeOf<One>()}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("8 16\n");
  });

  test("`nativeSizeOf` written without a type argument is refused", async () => {
    const { result } = await compileSource(
      "heap-sizeof-untyped",
      `export function main(): i32 {
         const n: usize = nativeSizeOf();
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).length).toBeGreaterThan(0);
  });
});

describe("what is still missing", () => {
  test("`allocArray` and the raw-pointer intrinsics are GF0001", async () => {
    for (const [name, body] of [
      ["allocArray", "  const p = allocArray<u8>(4);\n  return 0;"],
      ["nativeNew", "  const p = nativeNew<i32>();\n  return 0;"],
      ["nativeRead", "  const p = nativeNull<i32>();\n  return 0;"],
    ] as const) {
      await expectRejected(
        `heap-missing-${name}`,
        `export function main(): i32 {\n${body}\n}\n`,
        "GF0001",
      );
    }
  });

  test("a fixed array does not decay to a pointer yet", async () => {
    await expectRejected(
      "heap-decay",
      `export function main(): i32 {
         const buf: FixedArray<u8, 4> = fixedArray(4, 0);
         const p: Pointer<u8> = buf;
         return 0;
       }\n`,
      "GF0161",
    );
  });
});
