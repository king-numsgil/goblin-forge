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

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run, scratchPath } from "./harness.ts";

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

  test("`alloc<T>()` with no class allocates a zeroed `T`", async () => {
    const result = await run(
      "heap-plain",
      // `p[0]` is C's `*p`, and the spelling `CorePointer<T>`'s index signature
      // gives it. A pointer to one `T` and a pointer to the first of many are
      // the same type here, as they are in C.
      `export function main(): i32 {
         const n = alloc<i32>();
         const before: i32 = n[0];
         n[0] = 7;
         const after: i32 = n[0];
         n.free();
         return before * 10 + after;
       }\n`,
    );
    expect(result.exitCode).toBe(7);
    expect(result.leaked).toBe(0);
  });

  test("`alloc<T>()` of a struct is zeroed, field by field", async () => {
    const result = await run(
      "heap-plain-struct",
      `interface P { x: i32; y: i32; }

       export function main(): i32 {
         const p = alloc<P>();
         const zeroed: i32 = p.x + p.y;
         p.x = 3;
         p.y = 4;
         const sum: i32 = p.x + p.y;
         p.free();
         return zeroed * 100 + sum;
       }\n`,
    );
    expect(result.exitCode).toBe(7);
    expect(result.leaked).toBe(0);
  });

  test("`alloc<T>()` of an owning type is safe to free without ever writing it", async () => {
    // The reason there is no uninitialised form. `free()` destroys what the
    // storage holds; on uninitialised memory that is a garbage pointer, and the
    // crash lands nowhere near the mistake.
    const result = await run(
      "heap-plain-owning",
      `export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) {
           const s = alloc<string>();
           s.free();
           i = i + 1;
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("a class with a constructor must be named, not written as a type argument", async () => {
    const diagnostic = await expectRejected(
      "heap-ctor-required",
      `class R {
         x: i32;
         constructor(x: i32) { this.x = x; }
       }

       export function main(): i32 {
         const r = alloc<R>();
         r.free();
         return 0;
       }\n`,
      "GF0002",
    );
    expect(diagnostic.message).toContain("without constructing it");
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
  test("`sizeOf` and `alignOf` are constants from the layout engine", async () => {
    const result = await run(
      "heap-layout",
      `interface P { x: i32; y: i32; }
       interface Padded { flag: boolean; value: f64; }

       export function main(): i32 {
         console.log(\`\${sizeOf<P>()} \${alignOf<P>()}\`);
         console.log(\`\${sizeOf<Padded>()} \${alignOf<Padded>()}\`);
         console.log(\`\${sizeOf<u8>()} \${sizeOf<FixedArray<u8, 128>>()}\`);
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
         console.log(\`\${sizeOf<Empty>()} \${sizeOf<One>()}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("8 16\n");
  });

  test("`sizeOf` written without a type argument is refused", async () => {
    const { result } = await compileSource(
      "heap-sizeof-untyped",
      `export function main(): i32 {
         const n: usize = sizeOf();
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).length).toBeGreaterThan(0);
  });
});

describe("the pointer's own members", () => {
  test("`address` is the bits, and two allocations differ", async () => {
    const result = await run(
      "heap-address",
      `export function main(): i32 {
         const a = alloc<i32>();
         const b = alloc<i32>();
         const distinct: boolean = a.address !== b.address;
         const aligned: boolean = a.address % alignOf<i32>() === 0;
         a.free();
         b.free();
         return (distinct ? 2 : 0) + (aligned ? 1 : 0);
       }\n`,
    );
    expect(result.exitCode).toBe(3);
    expect(result.leaked).toBe(0);
  });

  test("`address` wins over a field of the pointee, which cannot exist", async () => {
    // The other half of `RESERVED_ON_POINTER`. A class declaring `address`
    // would have a member unreachable through every pointer to it, so the
    // declaration is refused rather than the access being ambiguous.
    const diagnostic = await expectRejected(
      "heap-address-reserved",
      `class Node {
         address: i32 = 0;
       }

       export function main(): i32 { return 0; }\n`,
      "GF0002",
    );
    expect(diagnostic.message).toContain("address");
  });

  test("`offset` strides by the element, forwards and backwards", async () => {
    // C's `p + n`, with the stride from the layout engine rather than from
    // anything written here. `i32` strides by four, so three elements apart is
    // twelve bytes apart, and that is the assertion.
    const result = await run(
      "heap-offset",
      `export function main(): i32 {
         const p = alloc<i32>();
         const three = p.offset(3);
         const gap: usize = three.address - p.address;
         const back: usize = three.offset(-3).address;
         console.log(\`\${gap} \${back === p.address}\`);
         p.free();
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("12 true\n");
    expect(result.leaked).toBe(0);
  });

  test("`offset` walks a run of storage, as C does", async () => {
    // What the arithmetic is *for*, over storage that really does hold four
    // elements. A pointer to one `T` and a pointer to the first of many are the
    // same type here, so this is written exactly as it is in C — including the
    // part where nothing checks that the fourth element exists.
    const result = await run(
      "heap-offset-walk",
      `declare function malloc(size: usize): Pointer<i32> | null;
       declare function free(block: Pointer<i32>): void;

       export function main(): i32 {
         const buf = malloc(sizeOf<i32>() * 4);
         if (buf === null) { return 1; }
         buf[0] = 10;
         buf[1] = 20;
         buf[2] = 30;
         buf[3] = 40;
         const third = buf.offset(2);
         console.log(\`\${third[0]} \${third[1]} \${third.offset(-2)[0]}\`);
         free(buf);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("30 40 10\n");
    // Nothing here is Goblin's: `malloc` allocated it and `free` released it,
    // and the counter correctly sees none of it.
    expect(result.leaked).toBe(0);
  });

  test("`deref` borrows the pointee, keeping its dynamic type", async () => {
    // The reason `deref` exists: passing a `Pointer<A>` where a
    // `Reference<A>` is wanted is not a conversion the language does, and a
    // *value* parameter would slice. This is the written form of "borrow it".
    const result = await run(
      "heap-deref",
      `class A { speak(): string { return "A"; } }
       class B extends A { override speak(): string { return "B"; } }

       function say(a: Reference<A>): void { console.log(a.speak()); }

       export function main(): i32 {
         const p: Pointer<A> = alloc(B);
         say(p.deref());
         p.free();
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("B\n");
    expect(result.leaked).toBe(0);
  });

  test("`deref` of a pointer to a primitive is GF0001, and says what to write", async () => {
    // `Reference<i32>` is not a type that can be written yet, so handing one
    // back would produce a value whose type the next line could not name.
    // `p[0]` is C's `*p` and already works.
    const diagnostic = await expectRejected(
      "heap-deref-primitive",
      `export function main(): i32 {
         const p = alloc<i32>();
         const r = p.deref();
         p.free();
         return 0;
       }\n`,
      "GF0001",
    );
    expect(diagnostic.message).toContain("p[0]");
  });
});

describe("nullable pointers", () => {
  test("a C function returning null is checked, and the check lowers", async () => {
    // `char *` is a `Pointer<u8>`, and `getenv` is the shape half of libc has:
    // a pointer that is null when the answer is "no". The `| null` makes tsc
    // refuse to read it without asking, which is the whole benefit — and worth
    // nothing unless the asking compiles, which is what this pins.
    const result = await run(
      "heap-nullable",
      `declare function getenv(name: CString): Pointer<u8> | null;

       export function main(): i32 {
         const missing = getenv(cstring("GOBLIN_FORGE_DEFINITELY_UNSET_9F2A"));
         if (missing === null) { console.log("unset"); } else { console.log("set"); }

         const path = getenv(cstring("PATH"));
         if (path !== null) {
           const copied: string = stringFromCString(path);
           console.log(\`PATH is \${copied.length > 0} \${path.address !== 0}\`);
         }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("unset\nPATH is true true\n");
    // The copy is Goblin's and is released; the bytes `getenv` returned are
    // the C library's and are never touched.
    expect(result.leaked).toBe(0);
  });

  test("reading a nullable pointer without checking is tsc's error, not the compiler's", async () => {
    const { result } = await compileSource(
      "heap-nullable-unchecked",
      `declare function getenv(name: CString): Pointer<u8> | null;

       export function main(): i32 {
         const p = getenv(cstring("PATH"));
         return cast<i32>(p[0]);
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
  });
});

describe("allocArray and freeArray", () => {
  test("a run of elements, indexed and strided like any other pointer", async () => {
    const result = await run(
      "heap-alloc-array",
      `export function main(): i32 {
         const xs = allocArray<i32>(4);
         let i: usize = 0;
         while (i < 4) {
           xs[i] = cast<i32>(i) * 10;
           i = i + 1;
         }
         const sum: i32 = xs[0] + xs[1] + xs[2] + xs.offset(3)[0];
         xs.freeArray();
         return sum;
       }\n`,
    );
    expect(result.exitCode).toBe(60);
    expect(result.leaked).toBe(0);
  });

  test("every element is initialised, not merely allocated", async () => {
    // The reason there is no uninitialised form, and the reason the
    // construction loop is not an optimisation away. `freeArray` destroys what
    // each slot holds; on uninitialised memory that is a garbage pointer per
    // element, and the crash lands nowhere near the mistake.
    const result = await run(
      "heap-alloc-array-zeroed",
      `export function main(): i32 {
         const xs = allocArray<i32>(8);
         let sum: i32 = 0;
         let i: usize = 0;
         while (i < 8) { sum = sum + xs[i]; i = i + 1; }
         xs.freeArray();
         return sum;
       }\n`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.leaked).toBe(0);
  });

  test("`freeArray` runs one destructor per element", async () => {
    // The whole reason `delete[]` is a separate operation. Twenty arrays of
    // three strings each: sixty allocations that only a per-element loop
    // releases, and the counter is what says it happened.
    const result = await run(
      "heap-free-array-owning",
      `export function main(): i32 {
         let n: usize = 0;
         while (n < 20) {
           const xs = allocArray<string>(3);
           xs[0] = "a" + "0";
           xs[1] = "b" + "1";
           xs[2] = "c" + "2";
           xs.freeArray();
           n = n + 1;
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("a count of zero allocates a block and frees it", async () => {
    // `new T[0]` is a real pointer in C++ too — the cookie still has to live
    // somewhere, so the block is never empty even when the run is.
    const result = await run(
      "heap-alloc-array-zero",
      `export function main(): i32 {
         const xs = allocArray<i32>(0);
         const real: boolean = xs.address !== 0;
         xs.freeArray();
         return real ? 0 : 1;
       }\n`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.leaked).toBe(0);
  });

  test("elements stride by `sizeOf`, padding included", async () => {
    // The distinction that makes the cookie's `stride` argument worth naming:
    // `{ i32, i8 }` occupies five bytes and strides by eight. Allocating with
    // one number and indexing with the other overlaps the elements, and it
    // prints plausible values for a while before it stops.
    const result = await run(
      "heap-alloc-array-stride",
      `interface Pad { a: i32; b: i8; }

       export function main(): i32 {
         const xs = allocArray<Pad>(3);
         xs[0].a = 1;
         xs[1].a = 2;
         xs[2].a = 3;
         const gap: usize = xs.offset(1).address - xs.address;
         console.log(\`\${sizeOf<Pad>()} \${gap} \${xs[0].a} \${xs[2].a}\`);
         xs.freeArray();
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("8 8 1 3\n");
    expect(result.leaked).toBe(0);
  });

  test("a class with a constructor is refused, as `new T[n]` is in C++", async () => {
    const diagnostic = await expectRejected(
      "heap-alloc-array-ctor",
      `class R {
         x: i32;
         constructor(x: i32) { this.x = x; }
       }

       export function main(): i32 {
         const xs = allocArray<R>(2);
         xs.freeArray();
         return 0;
       }\n`,
      "GF0002",
    );
    expect(diagnostic.message).toContain("nowhere to put its arguments");
  });

  test("a class without one is allocated in a run, and destroyed in a run", async () => {
    const result = await run(
      "heap-alloc-array-class",
      `class Holder { s: string = "x" + "y"; }

       export function main(): i32 {
         let n: usize = 0;
         while (n < 20) {
           const xs = allocArray<Holder>(2);
           n = n + 1;
           xs.freeArray();
         }
         console.log("done");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("done\n");
    expect(result.leaked).toBe(0);
  });

  test("dropping the pointer leaks the whole run, not one element", async () => {
    let message = "";
    try {
      await run(
        "heap-alloc-array-leak",
        `export function main(): i32 {
           const xs = allocArray<i32>(4);
           return 0;
         }\n`,
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("leaked 1 allocation");
  });
});

/**
 * `declare class FILE { private _opaque: never }` — C's incomplete type, and
 * the shape every library that hands out a handle uses.
 *
 * The pointer travels; the pointee does not exist here. What makes this worth
 * a suite of its own is that nothing about it fails loudly on its own: a type
 * with no layout, represented as a zero-field struct or a `void` pointee, has
 * a size of zero and an alignment of one, and answers every layout question
 * wrongly rather than refusing it (POINTER-ERASURE.md). So every refusal below
 * is a check somebody had to write, and the backend panics if one is missing.
 */
describe("opaque handles", () => {
  const FILE = `declare class FILE { private _opaque: never }

       declare function fopen(path: CString, mode: CString): Pointer<FILE> | null;
       declare function fputs(text: CString, stream: Pointer<FILE>): i32;
       declare function fclose(stream: Pointer<FILE>): i32;
`;

  // Each of these opens its *own* file, in the harness's scratch directory
  // rather than in `/tmp`, which does not exist on Windows. `scratchPath`
  // hands back forward slashes on every platform, because the result is
  // pasted into Goblin source where a backslash would be an escape.
  test("a handle round-trips through the C library that owns it", async () => {
    const result = await run(
      "opaque-file",
      `${FILE}
       export function main(): i32 {
         const f = fopen(cstring("${scratchPath("opaque-roundtrip.txt")}"), cstring("w"));
         if (f === null) { console.log("open failed"); return 1; }
         fputs(cstring("through FILE*"), f);
         fclose(f);
         console.log("ok");
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("ok\n");
    // Nothing here is Goblin's: the handle is a borrow, and the runtime
    // correctly counts none of it.
    expect(result.leaked).toBe(0);
  });

  test("`address` works, because it is the one member needing no layout", async () => {
    const result = await run(
      "opaque-address",
      `${FILE}
       export function main(): i32 {
         const f = fopen(cstring("${scratchPath("opaque-address.txt")}"), cstring("w"));
         if (f === null) { return 1; }
         const at: usize = f.address;
         console.log(at === 0 ? "null" : "not null");
         fclose(f);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("not null\n");
  });

  test("handles of different types do not convert into each other", async () => {
    // The property the `private` member buys, and the reason this is a class
    // rather than a type alias: tsc keeps them apart nominally even though the
    // two declarations are identical.
    await expectRejected(
      "opaque-nominal",
      `declare class FILE { private _opaque: never }
       declare class DIR { private _opaque: never }
       declare function fopen(p: CString, m: CString): Pointer<FILE>;
       declare function closedir(d: Pointer<DIR>): i32;

       export function main(): i32 {
         return closedir(fopen(cstring("never-opened"), cstring("r")));
       }\n`,
      "TS2345",
    );
  });

  test("a pointer to one lives in a struct and in an array", async () => {
    const result = await run(
      "opaque-containers",
      `${FILE}
       interface Handle { stream: Pointer<FILE>; tag: i32; }

       export function main(): i32 {
         const f = fopen(cstring("${scratchPath("opaque-containers.txt")}"), cstring("w"));
         if (f === null) { return 1; }
         const h: Handle = { stream: f, tag: 7 };
         const all: Pointer<FILE>[] = [];
         all.push(h.stream);
         console.log(\`\${all.length} \${h.tag}\`);
         fclose(h.stream);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("1 7\n");
    expect(result.leaked).toBe(0);
  });

  test("every operation that would need the layout is GF0302", async () => {
    // The list is the point. Each of these reached the backend and panicked
    // before the checks existed, because none of them refuses itself.
    for (const [name, body] of [
      ["index", "const g = f[1];"],
      ["offset", "const g = f.offset(1);"],
      ["deref", "const r = f.deref();"],
      ["free", "f.free();"],
      ["freeArray", "f.freeArray();"],
    ] as const) {
      await expectRejected(
        `opaque-refuse-${name}`,
        `declare class FILE { private _opaque: never }
         declare function fopen(p: CString, m: CString): Pointer<FILE>;

         export function main(): i32 {
           const f = fopen(cstring("never-opened"), cstring("r"));
           ${body}
           return 0;
         }\n`,
        "GF0302",
      );
    }
  });

  test("allocating one is GF0302 — there is no size to ask for", async () => {
    for (const [name, body] of [
      ["alloc", "const p = alloc<FILE>();"],
      ["allocArray", "const p = allocArray<FILE>(4);"],
      ["sizeOf", "const n: usize = sizeOf<FILE>();"],
      ["alignOf", "const n: usize = alignOf<FILE>();"],
    ] as const) {
      await expectRejected(
        `opaque-alloc-${name}`,
        `declare class FILE { private _opaque: never }

         export function main(): i32 {
           ${body}
           return 0;
         }\n`,
        "GF0302",
      );
    }
  });

  test("holding one by value is GF0302, wherever it is held", async () => {
    for (const [name, source] of [
      ["param", "function take(f: FILE): i32 { return 0; }"],
      ["return", "declare function get(): FILE;"],
      // A struct lays its fields out inline, so a field with no size gives
      // the struct no size. Reached through a signature, because an interface
      // nothing mentions is never erased at all.
      ["field", "interface S { f: FILE; }\n         export function take(s: S): i32 { return 0; }"],
      ["nestedField", "interface In { f: FILE; }\n         interface Out { i: In; }\n         export function take(o: Out): i32 { return 0; }"],
      ["array", "declare function all(): FILE[];"],
    ] as const) {
      await expectRejected(
        `opaque-value-${name}`,
        `declare class FILE { private _opaque: never }
         ${source}

         export function main(): i32 { return 0; }\n`,
        "GF0302",
      );
    }
  });
});

/**
 * `Pointer<unknown>` — C's `void *`.
 *
 * The only type-erased pointer the language has, and the only escape hatch in
 * the ambient surface. It exists because C's own signatures need one: `memcpy`,
 * a callback's userdata, anything a library hands back before you know what it
 * is.
 *
 * The asymmetry is C's, for C's reason. Throwing the type away is implicit,
 * because it cannot be wrong; putting one back is `reify<T>()`, written out,
 * because it can.
 */
describe("void pointers", () => {
  test("a pointer survives the round trip", async () => {
    const result = await run(
      "void-round-trip",
      `class Rect {
         w: i32;
         h: i32;
         constructor(w: i32, h: i32) { this.w = w; this.h = h; }
       }

       export function main(): i32 {
         const r = alloc(Rect, 6, 7);
         const raw: Pointer<unknown> = r.erase();
         const back = raw.reify<Rect>();
         const area: i32 = back.w * back.h;
         r.free();
         return area;
       }\n`,
    );
    expect(result.exitCode).toBe(42);
    expect(result.leaked).toBe(0);
  });

  test("erasure needs no cast, in an argument or an assignment", async () => {
    // The whole reason it is implicit. A binding written against a C header
    // says `void *` where the header does, and the call site stays the call
    // site rather than growing a conversion that says nothing new.
    const result = await run(
      "void-implicit",
      `interface Frame { pixels: Pointer<unknown>; pitch: i32; }

       function addressOfAnything(p: Pointer<unknown>): usize { return p.address; }

       export function main(): i32 {
         const r = alloc<i32>();
         r[0] = 42;
         const frame: Frame = { pixels: r, pitch: 4 };
         const same: boolean = addressOfAnything(r) === frame.pixels.address;
         const value: i32 = frame.pixels.reify<i32>()[0];
         r.free();
         return same ? value : 0;
       }\n`,
    );
    expect(result.exitCode).toBe(42);
    expect(result.leaked).toBe(0);
  });

  test("`void **` is an ordinary pointer to an erased one", async () => {
    // The shape of every C out-parameter that hands back a buffer —
    // `SDL_LockTexture(…, void **pixels, int *pitch)`. The outer pointer's
    // pointee is a `void *`, which is one word and has a layout, so indexing
    // through it is allowed where indexing an erased pointer is not.
    const result = await run(
      "void-double",
      `export function main(): i32 {
         const value = alloc<i32>();
         value[0] = 42;

         const cell = allocArray<Pointer<unknown>>(1);
         cell[0] = value;

         const back: i32 = cell[0].reify<i32>()[0];
         cell.freeArray();
         value.free();
         return back;
       }\n`,
    );
    expect(result.exitCode).toBe(42);
    expect(result.leaked).toBe(0);
  });

  test("C's own `void *` signature is callable", async () => {
    // `memcpy` is the reason the type exists, and it is a real C function
    // rather than a declaration this build could quietly agree with itself
    // about. Both pointers are erased implicitly at the call.
    const result = await run(
      "void-memcpy",
      `declare function memcpy(
         dst: Pointer<unknown>,
         src: Pointer<unknown>,
         n: usize,
       ): Pointer<unknown>;

       export function main(): i32 {
         const src = allocArray<i32>(2);
         src[0] = 19;
         src[1] = 23;
         const dst = allocArray<i32>(2);

         memcpy(dst, src, sizeOf<i32>() * 2);

         const total: i32 = dst[0] + dst[1];
         src.freeArray();
         dst.freeArray();
         return total;
       }\n`,
    );
    expect(result.exitCode).toBe(42);
    expect(result.leaked).toBe(0);
  });

  // `fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream)` — libc's
  // own `const void *`, and the reason the type exists. Nothing about the
  // declaration says `const`: there is no const in this language, so both C
  // spellings are one type here, which is truthful rather than lossy — they are
  // the same machine type and the same ABI.
  const FWRITE = `declare class FILE { private _opaque: never }

       declare function fopen(path: CString, mode: CString): Pointer<FILE> | null;
       declare function fwrite(
         ptr: Pointer<unknown>,
         size: usize,
         count: usize,
         stream: Pointer<FILE>,
       ): usize;
       declare function fread(
         ptr: Pointer<unknown>,
         size: usize,
         count: usize,
         stream: Pointer<FILE>,
       ): usize;
       declare function fclose(stream: Pointer<FILE>): i32;
`;

  test("libc's own `const void *` takes a buffer with no conversion written", async () => {
    // The buffer is a `Pointer<u32>` rather than a `Pointer<u8>` on purpose:
    // what crosses is an erasure, not a byte pointer that happened to fit. The
    // file on disk is the assertion, because libc is the one implementation of
    // this signature that cannot quietly agree with the compiler.
    const path = scratchPath("void-fwrite.bin");
    const result = await run(
      "void-fwrite",
      `${FWRITE}
       export function main(): i32 {
         const words = allocArray<u32>(4);
         words[0] = 0x11223344;
         words[1] = 0x55667788;
         words[2] = 0x99aabbcc;
         words[3] = 0xddeeff00;

         const f = fopen(cstring("${path}"), cstring("wb"));
         if (f === null) { console.log("open failed"); return 1; }
         const written: usize = fwrite(words, sizeOf<u32>(), 4, f);
         fclose(f);

         words.freeArray();
         console.log(\`\${written}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("4\n");
    expect(result.leaked).toBe(0);

    const bytes = readFileSync(path);
    expect(bytes.byteLength).toBe(16);
    expect([0, 1, 2, 3].map((i) => bytes.readUInt32LE(i * 4))).toEqual([
      0x11223344, 0x55667788, 0x99aabbcc, 0xddeeff00,
    ]);
  });

  // The same program written the way C writes it, now that a fixed array
  // decays. `char buf[1024]` is the spelling every C example uses, and a
  // binding that could not take one would be a binding nobody wants.
  test("the same buffer as C's `char buf[1024]`", async () => {
    const path = scratchPath("void-fwrite-fixed.bin");
    const result = await run(
      "void-fwrite-fixed",
      `${FWRITE}
       export function main(): i32 {
         const buf: FixedArray<u8, 1024> = fixedArray(1024, 0);
         buf[0] = 71;
         buf[1] = 111;
         buf[2] = 98;

         const f = fopen(cstring("${path}"), cstring("wb"));
         if (f === null) { return 1; }
         const written: usize = fwrite(buf, 1, 3, f);
         fclose(f);
         console.log(\`\${written}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("3\n");
    expect(readFileSync(path, "utf8")).toBe("Gob");
  });

  test("a file read is bytes and a length, and that is a `string`", async () => {
    // The whole loop a binding actually performs: hand C a buffer as a
    // `void *`, get a count back, and turn exactly that many bytes into a
    // `string`. No terminator is written and none is needed — which is the
    // difference between `stringFromBytes` and a scan.
    const path = scratchPath("void-file-roundtrip.txt");
    const result = await run(
      "void-file-roundtrip",
      `${FWRITE}
       export function main(): i32 {
         const out: FixedArray<u8, 6> = fixedArray(6, 0);
         out[0] = 71; out[1] = 111; out[2] = 98; out[3] = 108; out[4] = 105; out[5] = 110;

         const w = fopen(cstring("${path}"), cstring("wb"));
         if (w === null) { console.log("open failed"); return 1; }
         fwrite(out, 1, 6, w);
         fclose(w);

         const r = fopen(cstring("${path}"), cstring("rb"));
         if (r === null) { console.log("reopen failed"); return 2; }
         const buf: FixedArray<u8, 64> = fixedArray(64, 0);
         const read: usize = fread(buf, 1, 64, r);
         fclose(r);

         console.log(\`\${read} "\${stringFromBytes(buf, read)}"\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe('6 "Goblin"\n');
    expect(result.leaked).toBe(0);
  });

  test("every operation that would need the pointee is GF0305", async () => {
    // The same list as the opaque handle's, and for a related reason with a
    // sharper edge: `void` *has* a layout — nought bytes, aligned to one — so
    // not one of these refuses itself. `p[i]` would stride by nothing and
    // `free` would hand the allocator a size of nothing, which is a corrupt
    // heap rather than a wrong number.
    for (const [name, body] of [
      ["index", "const v = raw[1];"],
      ["offset", "const q = raw.offset(1);"],
      ["deref", "const d = raw.deref();"],
      ["free", "raw.free();"],
      ["freeArray", "raw.freeArray();"],
    ] as const) {
      await expectRejected(
        `void-refuse-${name}`,
        `export function main(): i32 {
           const p = alloc<i32>();
           const raw: Pointer<unknown> = p;
           ${body}
           p.free();
           return 0;
         }\n`,
        "GF0305",
      );
    }
  });

  test("allocating through one is GF0305 — there is no size to ask for", async () => {
    for (const [name, body] of [
      ["alloc", "const p: Pointer<unknown> = alloc<unknown>();"],
      ["allocArray", "const p: Pointer<unknown> = allocArray<unknown>(4);"],
    ] as const) {
      await expectRejected(
        `void-alloc-${name}`,
        `export function main(): i32 {
           ${body}
           return 0;
         }\n`,
        "GF0305",
      );
    }
  });

  test("reifying a pointer that never lost its type is GF0306", async () => {
    // tsc cannot say "only on an erased pointer", because `reify` is declared
    // on `CorePointer<T>` and is therefore callable on every pointer. This is
    // the rule the prelude states — no unchecked cast between two concrete
    // pointee types — enforced where it can be.
    await expectRejected(
      "void-reify-concrete",
      `class Rect { w: i32; }
       class Circle { r: i32; }

       export function main(): i32 {
         const p = alloc(Rect);
         const q = p.reify<Circle>();
         p.free();
         return 0;
       }\n`,
      "GF0306",
    );
  });

  test("the round trip written out is allowed", async () => {
    // The point of refusing the short spelling: this one says what it does at
    // the site that depends on it. It is `reinterpret_cast`, and it looks like
    // one.
    const result = await run(
      "void-reinterpret",
      `interface Header { tag: i32; }
       interface Payload { tag: i32; extra: i32; }

       export function main(): i32 {
         const p = alloc<Payload>();
         p.tag = 42;
         p.extra = 1;
         const h = p.erase().reify<Header>();
         const tag: i32 = h.tag;
         p.free();
         return tag;
       }\n`,
    );
    expect(result.exitCode).toBe(42);
    expect(result.leaked).toBe(0);
  });

  test("reification is never implicit", async () => {
    // tsc's own refusal, and the half of the asymmetry that has to hold: an
    // erased pointer is not assignable to a concrete one.
    await expectRejected(
      "void-not-implicit",
      `class Rect { w: i32; }

       export function main(): i32 {
         const p = alloc(Rect);
         const raw: Pointer<unknown> = p;
         const back: Pointer<Rect> = raw;
         p.free();
         return back.w;
       }\n`,
      "TS2322",
    );
  });
});

describe("what is still missing", () => {
  test("`nativeNew` is gone — `alloc<T>()` is the one allocation", async () => {
    // Folded rather than implemented. `nativeNew` handed back *uninitialised*
    // storage, which is at odds with the rest of the language: a destructor
    // releases what a slot holds, and on uninitialised memory that is a garbage
    // pointer. One operation, two spellings, always initialised.
    const { result } = await compileSource(
      "heap-no-nativenew",
      `export function main(): i32 {
         const p = nativeNew<i32>();
         return 0;
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("TS2304");
  });

});

/**
 * Array-to-pointer decay — C's silent conversion, written out here as an
 * `AddrOf`.
 *
 * A `FixedArray<T, N>` **is** the bytes, which is the whole difference between
 * it and a pointer. So decay is not a retype of a value: it is the address of
 * the place the bytes occupy, which is why this could not have come along free
 * with the pointer type itself.
 */
describe("fixed arrays decay", () => {
  test("to a pointer to the element, and the bytes are the same bytes", async () => {
    const result = await run(
      "decay-element",
      `export function main(): i32 {
         const buf: FixedArray<i32, 4> = fixedArray(4, 0);
         buf[2] = 42;

         const p: Pointer<i32> = buf;
         // Writing through the pointer is writing the array: one object.
         p[3] = p[2];
         return buf[3];
       }\n`,
    );
    expect(result.exitCode).toBe(42);
    expect(result.leaked).toBe(0);
  });

  test("to a `void *`, which is what a C buffer parameter usually is", async () => {
    const result = await run(
      "decay-erased",
      `function firstByte(p: Pointer<unknown>): u8 { return p.reify<u8>()[0]; }

       export function main(): i32 {
         const buf: FixedArray<u8, 8> = fixedArray(8, 0);
         buf[0] = 42;
         return cast<i32>(firstByte(buf));
       }\n`,
    );
    expect(result.exitCode).toBe(42);
    expect(result.leaked).toBe(0);
  });

  test("as an argument, even when the array is a temporary", async () => {
    // A temporary lives to the end of the enclosing full-expression, so the
    // call completes inside its lifetime. This is the same rule a borrow gets,
    // and C++ draws the line in the same place.
    const result = await run(
      "decay-temporary-argument",
      `function firstByte(p: Pointer<u8>): u8 { return p[0]; }

       export function main(): i32 {
         return cast<i32>(firstByte(zeroed<FixedArray<u8, 4>>()));
       }\n`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.leaked).toBe(0);
  });

  test("but a binding may not outlive the temporary it decayed", async () => {
    // The other half of the same rule. Nothing owns the array, so the pointer
    // would be dangling on the next line rather than at the end of the scope.
    await expectRejected(
      "decay-temporary-binding",
      `export function main(): i32 {
         const p: Pointer<u8> = zeroed<FixedArray<u8, 4>>();
         return cast<i32>(p[0]);
       }\n`,
      "GF0234",
    );
  });

  test("to the element type only — tsc keeps the rest apart", async () => {
    // C decays `T[N]` to `T *` and to nothing else. Here the width brands do
    // that work before the compiler is reached, which is why there is no
    // diagnostic of the compiler's own for a mismatched decay.
    const { result } = await compileSource(
      "decay-mismatch",
      `export function main(): i32 {
         const buf: FixedArray<u8, 4> = fixedArray(4, 0);
         const p: Pointer<i32> = buf;
         return p[0];
       }\n`,
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
  });
});
