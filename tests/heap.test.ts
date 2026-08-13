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

describe("what is still missing", () => {
  test("`erase` and `reify` are GF0001", async () => {
    for (const [name, body] of [
      ["erase", "  const p = alloc<i32>();\n  const e = p.erase();\n  p.free();\n  return 0;"],
      ["reify", "  const p = alloc<i32>();\n  const r = p.reify<u8>();\n  p.free();\n  return 0;"],
    ] as const) {
      await expectRejected(
        `heap-missing-${name}`,
        `export function main(): i32 {\n${body}\n}\n`,
        "GF0001",
      );
    }
  });

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
