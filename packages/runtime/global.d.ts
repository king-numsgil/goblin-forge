/**
 * goblin-forge ambient prelude.
 *
 * This file defines the *entire* global surface of the language. It is compiled
 * with `noLib: true`, so nothing from `lib.dom.d.ts` / `lib.es*.d.ts` exists:
 * no `console`, no `Math`, no `Array` methods, no `any`. A stock TypeScript
 * toolchain (tsc, tsserver, WebStorm, eslint) reads this file and nothing else
 * special — there are no compiler plugins and no custom syntax anywhere.
 *
 * Everything declared here is *ambient*. None of it has a runtime
 * representation of its own; the compiler recognises these declarations by name
 * and lowers them directly to machine operations.
 *
 * The language this describes is C++'s value semantics wearing TypeScript's
 * syntax. The differences that will surprise a TypeScript programmer are
 * deliberate and permanent:
 *
 *   * **Objects are values.** `const b = a; b.x = 5` leaves `a` untouched.
 *   * **Copying a class slices.** Polymorphism travels through `Reference<T>`
 *     and `Pointer<T>`, never through values.
 *   * **The prototype is fixed.** Assigning a method on an instance is an error
 *     even though tsc accepts it.
 *   * **No truthiness.** `if (n)` on a number is an error.
 *   * **Fixed-width arithmetic**, with implicit promotion only where it cannot
 *     lose a value.
 */

// ---------------------------------------------------------------------------
// Minimal global types required by the TypeScript checker itself.
//
// With `noLib: true` the checker still demands that a handful of global type
// names resolve. They are declared empty on purpose: an empty `Number` means
// `(1).toFixed()` is a type error, which is exactly right — there is no
// JavaScript runtime underneath this language.
// ---------------------------------------------------------------------------

interface Object {}
interface Function {}
interface CallableFunction extends Function {}
interface NewableFunction extends Function {}
interface IArguments {}
interface Number {}
interface Boolean {}
interface RegExp {}

/**
 * `FixedArray<T, N>`: exactly `N` elements, inline, with no allocation at all.
 *
 * This is C's `T name[N]`, and the thing worth being precise about is that a
 * fixed array **is** the bytes rather than a pointer to them:
 *
 *     const buf: FixedArray<u8, 128> = fixedArray(128, 0);
 *     nativeSizeOf<FixedArray<u8, 128>>();   // 128, not 8
 *
 * A C array decays to a pointer in most expression contexts, which is where the
 * intuition that it *is* one comes from. It is not, and the difference shows
 * everywhere it matters: as a struct field it occupies its whole layout inline,
 * copying the struct copies the elements with it, and nothing is ever handed to
 * an allocator.
 *
 * Its storage class is therefore **inline**, not "stack" — a fixed array inside
 * a heap-allocated object is on the heap, and is still inline. The scope that
 * owns the *parent* reclaims it, and destroys each element in reverse order if
 * the element type owns anything.
 *
 * The length is part of the type, so `FixedArray<u8, 8>` and `FixedArray<u8, 4>`
 * are different types and tsc says so.
 *
 * A fixed array **decays to a `Pointer<T>`** — C's array-to-pointer conversion,
 * and what makes a C function taking `uint8_t*` callable with one. The relation
 * runs one way only: a pointer never becomes a fixed array, because it does not
 * carry a length. `free()` and `freeArray()` are inherited and are undefined
 * behaviour on a fixed array, exactly as `free(buf)` is in C — this is an unsafe
 * language on purpose, and the alternative is a second pointer type whose only
 * difference is which mistakes it permits.
 */
declare const FixedLengthBrand: unique symbol;

interface FixedArray<T, N extends number> extends CorePointer<T> {
  /**
   * **Required**, unlike the width brand, and that is what makes the relation
   * one-way. An optional brand would be optional-and-*absent* on a plain
   * `Pointer<T>`, and optional-and-absent is assignable — so a pointer would
   * silently become a fixed array of any length you asked for. The same trap
   * REWRITE-PLAN §7 describes for the widths, in a new place.
   */
  readonly [FixedLengthBrand]: N;
  /** Known at compile time — this is a literal type, not a load. */
  readonly length: N;
}

/**
 * Build a fixed array with every element set to `fill`.
 *
 * There is no uninitialised form. Constructing into a stack slot runs whatever
 * the element's construction is, and a constructor releases what the slot used
 * to hold — on uninitialised stack that is a garbage pointer (REWRITE-PLAN §10).
 */
declare function fixedArray<T, N extends number>(length: N, fill: T): FixedArray<T, N>;

/**
 * `T[]`: contiguous elements with a length header behind the pointer, the same
 * shape a string has. One machine word, `length` is a load, and the pointer is
 * a plain `T*` as far as a native function is concerned.
 *
 * This is the language's `std::vector`: owning, growable, and a **value**.
 *
 *     const xs: i32[] = [1, 2, 3];
 *     xs.push(4);
 *     xs[0] = 9;
 *     const ys = xs;        // a copy — a second buffer, not a second name
 *     const last = xs.pop();
 *
 * Elements are stored **inline**: an element occupies its own stride, not a
 * pointer to itself. That is what makes the bytes match what a C compiler
 * produces for the same declaration, and it is not negotiable.
 *
 * `T[]` and `Array<T>` are the same type, as they are in TypeScript.
 *
 * Copying one copies every element with that element's own copy operation, so
 * a `string[]` deep-copies its strings and an `i32[]` is a single `memcpy`.
 * That is `std::vector`'s copy constructor, and the reason passing one to a
 * function costs an allocation — take a `Reference<T[]>` where it should not.
 *
 * An empty array holds no buffer and allocates nothing, exactly as an empty
 * `std::vector` does. Growth is amortised: the buffer doubles, from a floor of
 * four, so a loop of `push` is linear.
 *
 * Indexing is unchecked, like every other memory access here, and `length` is
 * a `usize` — so a loop counter has to be one too, or converted with
 * `nativeCast<usize>(…)`.
 *
 * An array is released when its binding leaves scope, and it releases its
 * elements first if the element type owns anything.
 */
interface Array<T> {
  /** Element count. A load from the header, not a scan. */
  readonly length: usize;
  /**
   * Mutable, unlike `length`: `xs[0] = 1` is the point of the type. A
   * `readonly` index signature is what TypeScript's own `ReadonlyArray` has,
   * and it would make this a different container.
   */
  [index: number]: T;

  /**
   * Append one element, growing the buffer if it is full.
   *
   * The element is **copied** in, by the same rule every other assignment
   * follows — so pushing a `string` allocates a second one. `push(move(s))`
   * hands the buffer over instead.
   *
   * Growing reallocates, which moves the elements. Anything holding a
   * `Pointer<T>` into this array is dangling afterwards, exactly as it is with
   * `std::vector::push_back`.
   */
  push(value: T): void;

  /**
   * Remove the last element and hand it back.
   *
   * A move, not a copy: the element is leaving the array. The buffer is kept,
   * as `std::vector::pop_back` keeps its capacity.
   *
   * Popping an empty array is unchecked, like indexing one.
   */
  pop(): T;
}

/**
 * The `string` primitive: NUL-terminated UTF-8, one machine word wide.
 *
 * `length` is a byte count, not a character count, and it is O(1) — the length
 * is stored in a header behind the pointer rather than found by scanning. The
 * same pointer is a valid C `char *`, so a string can be handed straight to a
 * native function without conversion.
 *
 * Strings have value semantics, like `std::string`. Binding one to a second
 * name copies it, so two names never share a buffer, and the binding's scope
 * releases it.
 */
interface String {
  readonly length: usize;

  /**
   * The bytes between two offsets, as a new string.
   *
   * Out-of-range offsets are clamped and a reversed pair is swapped, matching
   * JavaScript, so parsing code does not need a bounds check on every call.
   * Omitting `end` runs to the end of the string.
   *
   * Offsets are bytes. Cutting through the middle of a multi-byte character
   * produces a string that is no longer valid UTF-8; use `codePointAt` to find
   * boundaries if you are not working in ASCII.
   */
  substring(start: usize, end?: usize): string;

  /** Byte offset of `search` at or after `from`, or -1 if it does not occur. */
  indexOf(search: string, from?: usize): isize;

  /**
   * The Unicode code point whose encoding starts at byte `index`.
   *
   * Zero if `index` is past the end, or lands inside a multi-byte character —
   * which is how a byte-by-byte scan tells characters from continuation bytes.
   * For ASCII this is just the byte.
   */
  codePointAt(index: usize): u32;
}

// ---------------------------------------------------------------------------
// Fixed-width numeric types.
//
// Each width is `number` intersected with an *optional* literal brand. Three
// properties fall out, all of them deliberate:
//
//   * arithmetic works — `a + b` where `a: i32, b: i32` is legal;
//   * a bare numeric literal is assignable to any width, so `const x: i32 = 42`
//     and `add(40, 2)` read naturally;
//   * *distinct* widths are not mutually assignable — `i32` is not a `u8`, and
//     tsc says so, because the brands are different string literal types.
//
// **One brand key, twelve literals.** This is load-bearing and is the thing
// most likely to be "simplified" by someone who does not know why. A distinct
// symbol key per width would leave every brand optional-and-*absent* from the
// others, and optional-and-absent is assignable — the widths would silently
// unify. Verified against real tsc, not assumed.
//
// A symbol key, so that no source file can spell it and claim a width it does
// not have.
//
// The cost of the brand being optional is that plain `number` is assignable to
// every width. That is the hole the compiler's own width pass exists to close.
// ---------------------------------------------------------------------------

declare const WidthBrand: unique symbol;

interface __GfWidth<N extends string> {
  readonly [WidthBrand]?: N;
}

type i8 = number & __GfWidth<"i8">;
type i16 = number & __GfWidth<"i16">;
type i32 = number & __GfWidth<"i32">;
type i64 = number & __GfWidth<"i64">;

type u8 = number & __GfWidth<"u8">;
type u16 = number & __GfWidth<"u16">;
type u32 = number & __GfWidth<"u32">;
type u64 = number & __GfWidth<"u64">;

type f32 = number & __GfWidth<"f32">;
type f64 = number & __GfWidth<"f64">;

/** Pointer-width signed integer. Promotes only to itself. */
type isize = number & __GfWidth<"isize">;
/** Pointer-width unsigned integer. Promotes only to itself. */
type usize = number & __GfWidth<"usize">;

// ---------------------------------------------------------------------------
// Pointers.
//
// `Pointer<T>` is a bare machine address at runtime — one register, no header,
// no metadata. `T` exists only at compile time, where it supplies the stride
// for pointer arithmetic, the layout to read through, and nominal identity.
//
// A pointer to an object *is* that object's members, so `p.width` and
// `p.area()` work without writing a dereference — the same auto-dereference
// C++ spells `->`. That is what the intersection buys:
//
//     type Pointer<Rect> = Rect & CorePointer<Rect>
//
// The brand is required, not optional, so the relation only runs one way: a
// `Rect` is not a `Pointer<Rect>`. The other direction *is* assignable as far
// as tsc is concerned, and this compiler rejects it (`GF0227`) — silently
// copying a heap object onto the stack is not what anyone means.
//
// Opaque handles are declared the way native libraries declare them:
//
//     declare class MetisWorld { private _opaque: never }
//     export function metis_world_new(): Pointer<MetisWorld>;
//
// `MetisWorld` has no layout and no members, so the only thing user code can do
// with a `Pointer<MetisWorld>` is hand it back to the library.
// ---------------------------------------------------------------------------

declare const PointerBrand: unique symbol;

interface CorePointer<T> {
  /**
   * Covariant in `T`, so a `Pointer<Rect>` is a `Pointer<Shape>` — the upcast
   * that makes `Pointer<Shape>[]` the way to hold mixed subtypes. It is exactly
   * as unsound as `Shape**` is in C++, and that is the trade: this is an unsafe
   * language on purpose. Opaque FFI handles stay unrelated regardless, because
   * a class with a private member is nominal.
   */
  readonly [PointerBrand]: T;

  /** The address, for FFI and for comparison. */
  readonly address: usize;

  /**
   * The pointee, borrowed. Needed only where the auto-dereference cannot
   * reach: a pointer to a primitive, or where a `Reference<T>` is wanted as a
   * value rather than as a receiver.
   */
  deref(): Reference<T>;

  /**
   * `p[i]` — the `i`th element from here, in units of `T`.
   *
   * Exactly C's `*(p + i)`, including the part where nothing checks that there
   * *is* an `i`th element. A pointer to one `T` and a pointer to the first of
   * many are the same type here, as they are in C.
   */
  [index: number]: T;

  /**
   * Run the destructor and release the storage — C++ `delete`, and just as
   * unchecked. The pointer is poisoned afterwards, so a use-after-free through
   * *this* binding is a null dereference rather than a read of reused memory.
   * Aliases are not poisoned; `checked` catches the double free instead.
   */
  free(): void;

  /**
   * Release storage obtained from `allocArray` — C++ `delete[]`.
   *
   * Distinct from `free` for the same reason C++ distinguishes `delete` from
   * `delete[]`: one destructor has to run per element, and only this knows how
   * many there are. Calling the wrong one is undefined behaviour, exactly as it
   * is in C++.
   */
  freeArray(): void;
}

type Pointer<T> = T extends GfPrimitive ? CorePointer<T> : T & CorePointer<T>;

// ---------------------------------------------------------------------------
// References.
//
// Everything with a lifetime here is a *value*: binding it copies, and the
// binding's scope releases it. `Reference<T>` is how you say "do not copy this"
// — the same job `T&` does in C++, and the only way to borrow, which is what
// makes borrowing something you *write* rather than something the compiler
// infers.
//
//     function area(r: Rect): i32          // copies
//     function draw(r: Reference<Rect>)    // does not
//
// A reference cannot be constructed; it arrives implicitly, by assignment or by
// being passed. It owns nothing and releases nothing, so what it points at must
// outlive it — unchecked, exactly as in C++.
//
// The brand is *optional*, so a value converts to a reference implicitly. That
// also means a reference converts back to a value, which is the copy — and it
// is the right place for the copy to happen, because it is where the programmer
// wrote it.
//
// Unlike C++'s `const&`, a reference does **not** extend the lifetime of a
// temporary bound to it. That is rejected (`GF0234`) rather than supported, and
// on purpose: lifetime extension would put ownership back into the compiler's
// inference, which is the thing `Reference<T>` exists to avoid.
//
// Polymorphism travels through references. Copying a `Circle` into a `Shape`
// slices it, as it does in C++; a `Reference<Shape>` keeps the dynamic type and
// dispatches to it.
// ---------------------------------------------------------------------------

declare const ReferenceBrand: unique symbol;

interface ReferenceCore<T> {
  readonly [ReferenceBrand]?: T;
}

/**
 * The primitives are `number` intersected with a brand, and TypeScript counts
 * such an intersection as extending `object` — so the discriminator has to name
 * the primitive side, or every scalar takes the wrong branch.
 */
type GfPrimitive = number | string | boolean;

type Reference<T> = T extends GfPrimitive ? ReferenceCore<T> : T & ReferenceCore<T>;

// ---------------------------------------------------------------------------
// Memory intrinsics. Manual, C++-style, unverified. There is no GC, no
// refcount, and no borrow checker: `nativeDelete` on a pointer that is still
// live is your bug, and the compiler will not find it for you.
// ---------------------------------------------------------------------------

/**
 * Construct a `T` on the heap and hand back its address — C++ `new T(...)`.
 *
 *     const r = alloc(Rect, 6, 7);   // Pointer<Rect>
 *     console.log(`${r.area()}`);    // dereferences
 *     r.free();                      // yours to call, and nobody calls it for you
 *
 * Where `new Rect(6, 7)` gives a value that its scope releases, this gives a
 * pointer that outlives the scope and leaks if you drop it. That is the whole
 * distinction, and it is the same one C++ draws.
 */
declare function alloc<T extends object, A extends readonly unknown[]>(
  klass: new (...args: A) => T,
  ...args: A
): Pointer<T>;

/**
 * Hand a value's ownership somewhere else, instead of copying it.
 *
 *     const a = `hello, ${name}`;
 *     const b = move(a);        // no allocation; `a` must not be read again
 *     take(move(b));            // ownership goes to the callee
 *
 * This is C++'s `std::move`, and it is written for the same reason
 * `Reference<T>` is written: ownership is a property of the program that the
 * programmer states, not one the compiler infers from how the code happens to
 * be arranged. A binding that is copied is copied on every path; it does not
 * quietly become a move because a later line was deleted.
 *
 * Returning a local is the one move you do not have to write, because there is
 * nothing else it could mean — the local is about to go out of scope. A
 * *parameter* is the exception: the caller releases a by-value argument, so
 * `return param` is a copy and `return move(param)` is `GF0236`.
 *
 * Reading a moved-from value is an error (`GF0235`), and **assigning to the
 * binding clears it** — a moved-from value is empty rather than invalid, so
 * putting one back makes it readable again:
 *
 * ```ts
 * let s = `hello, ${name}`;
 * take(move(s));
 * s = "next";               // `s` holds a value again
 * console.log(s);           // fine
 * ```
 *
 * The check is not flow-sensitive: a move under an `if` that does not refill
 * the binding is reported after the `if`. Where it is wrong in the other
 * direction the value is left empty rather than dangling, so the failure is a
 * wrong answer and never memory corruption.
 */
declare function move<T>(value: T): T;

/**
 * A checked downcast: `Reference<T>` if the value really is a `T`, `null` if not.
 *
 * ```ts
 * const pet = tryCast<Pet>(animal);
 * if (pet !== null) {
 *   pet.feed();
 * }
 * ```
 *
 * The `| null` is doing real work. TypeScript's `strictNullChecks` **rejects**
 * `tryCast<Pet>(animal).feed()`, so the check is not something you are trusted
 * to remember — it is the only way to reach the value. A boolean type guard
 * would have left ignoring the answer possible.
 *
 * There is no unchecked form and no throwing form. C++ has both (`dynamic_cast`
 * to a pointer, and to a reference) and the second exists to make the first
 * ergonomic in expressions; here the type system does that job instead.
 *
 * `T` may be a contract — an interface declaring methods — or a class. In both
 * cases the question is the same, "is this really a `T`", and the compiler
 * knows statically which mechanism answers it: an itable lookup on the object's
 * type descriptor, or a walk of that descriptor's base chain.
 *
 * The argument is `object` rather than a type parameter because TypeScript has
 * no partial type-argument inference: with two parameters, `tryCast<Pet>(x)`
 * would be an error and every call site would have to spell the source type too.
 */
declare function tryCast<T>(value: object): Reference<T> | null;

/** Allocate uninitialised storage for one `T`. Analogous to C++ `new T`. */
declare function nativeNew<T>(): Pointer<T>;

/** Release storage obtained from `nativeNew`. Analogous to C++ `delete`. */
declare function nativeDelete<T>(ptr: CorePointer<T>): void;

/**
 * Allocate `count` contiguous `T` on the heap — C++ `new T[n]`.
 *
 * The count is a runtime value, which is the whole reason this exists: a length
 * known at compile time is a `FixedArray<T, N>` and costs no allocation.
 *
 * Released with `freeArray`, and never with `free`.
 */
declare function allocArray<T>(count: usize): Pointer<T>;

/** Load the `T` at `ptr`. Requires `T` to have a known layout. */
declare function nativeRead<T>(ptr: CorePointer<T>): T;

/** Store `value` at `ptr`. Requires `T` to have a known layout. */
declare function nativeWrite<T>(ptr: CorePointer<T>, value: T): void;

/** `ptr + elements * sizeof(T)`, in units of `T`. */
declare function nativeOffset<T>(ptr: CorePointer<T>, elements: isize): Pointer<T>;

/** The null address, typed. */
declare function nativeNull<T>(): Pointer<T>;

/** Address comparison against null. */
declare function nativeIsNull<T>(ptr: CorePointer<T>): boolean;

/**
 * Size of `T` in bytes, as laid out by this compiler.
 *
 * This is the *storage* size — what an array of `T` strides by and what
 * `nativeNew<T>()` allocates — never "what a register holds". The two are
 * different questions and this answers only one of them.
 */
declare function nativeSizeOf<T>(): usize;

/** Alignment of `T` in bytes. */
declare function nativeAlignOf<T>(): usize;

/**
 * Discard a pointer's pointee type. `Pointer<unknown>` is the language's only
 * type-erased pointer and the only escape hatch in the ambient surface — there
 * is deliberately no `any` and no unchecked cast between two concrete pointee
 * types.
 */
declare function nativeErase<T>(ptr: CorePointer<T>): Pointer<unknown>;

/** Re-attach a pointee type to an erased pointer. Entirely on your honour. */
declare function nativeReify<T>(ptr: CorePointer<unknown>): Pointer<T>;

// ---------------------------------------------------------------------------
// Width conversion.
//
// Inside an arithmetic expression, operands promote automatically to whichever
// type holds both: `u8 + u32` is done in `u32`, and `i32 * f64` in `f64`. The
// rule is that a promotion can never lose a value, so `i32 + u32` has no common
// type — neither holds the other — and neither does `i64 + f64`, since `f64` is
// exact only to 2^53. C performs both of those silently; here you write which
// one you meant.
//
// `nativeCast` is that written form. It is also the only way to narrow, since
// silent truncation is how you lose an afternoon.
// ---------------------------------------------------------------------------

/** Convert a numeric value to another fixed width. */
declare function nativeCast<T extends number>(value: number): T;

// ---------------------------------------------------------------------------
// Strings.
//
// `+` concatenates, template literals interpolate, and `substring` copies.
// Every one of those allocates — and every one is released for you when the
// binding holding it goes out of scope. There is no `stringFree`, for the same
// reason C++ has no `delete` for a `std::string`:
//
//     function greet(name: string): void {
//         const greeting = `hello, ${name}`;
//         console.log(greeting);
//     }                                   // greeting released here
//
// Returning a local hands its buffer to the caller rather than copying it.
// Parameters are borrowed: a function may read a string it was passed, but the
// caller keeps ownership, so passing one costs nothing.
//
// Raw memory is still yours to manage — `nativeNew` and `nativeDelete` have not
// changed. This is the same split C++ draws between a container and a pointer.
// ---------------------------------------------------------------------------

/**
 * Copy a NUL-terminated C string into a managed string.
 *
 * This is how anything arriving across the FFI boundary becomes a `string`,
 * `argv` entries included. The result is owned by the binding you put it in;
 * the pointer is not touched again.
 */
declare function stringFromCString(pointer: Pointer<u8> | CString): string;

// ---------------------------------------------------------------------------
// CString
//
// The borrowed half of the string pair: a raw `const char *`, and nothing
// else. No header, no length, no owner.
//
// `string` and `CString` are `String` and `&str`, or `std::string` and
// `string_view` — the same split every language that takes C seriously ends up
// making. What it buys here:
//
//   * **The C boundary can say which it means.** A returned `string` is always
//     the caller's to release, because returning an owning value is a move and
//     there is no way for a function to hand one back and keep it. A returned
//     `CString` is the case where the signature has stopped talking and the
//     documentation has to start — which is exactly what a C API does.
//   * **The cost of `length` is in the type.** On a `string` it is a load; on a
//     `CString` it is a `strlen` scan. One syntax, two costs, and you can see
//     which one you have.
//
// A `CString` is **never** released by the scope that holds it. Nothing tracks
// it — that is the point, and it is the unsafe escape hatch of this language.

declare const CStringBrand: unique symbol;

interface CString {
  /**
   * Unforgeable, and required rather than optional for the same reason
   * `FixedArray`'s is: an optional brand is *absent* on other types, and
   * optional-and-absent is assignable, so every pointer would silently become
   * a `CString`.
   */
  readonly [CStringBrand]: void;

  /**
   * `strlen`. **O(n)** — it scans to the NUL, because there is no header to
   * read a length out of.
   *
   * A `string`'s `length` is a single load. That difference is the reason
   * these are two types.
   */
  readonly length: usize;
}

/**
 * Borrow a `string`'s bytes as a `CString`.
 *
 * Free — a Goblin `string` is already NUL-terminated, so this hands back the
 * same pointer. What it is *not* is free of consequence:
 *
 * ```ts
 * const c: CString = cstring(name);   // valid while `name` is
 * const d: CString = cstring(move(name));   // `name` is dead; `d` is yours now
 * ```
 *
 * Without `move`, the `string` still owns the bytes and still releases them at
 * the end of its scope; the `CString` is a borrow and dies with it. Borrowing a
 * *temporary* is `GF0234`, because that one is released at the end of the
 * statement and the borrow could not outlive it by even a line.
 *
 * With `move`, nothing releases the bytes any more — the compiler has been told
 * to stop tracking them. That is a real thing to want when handing a buffer to
 * a C library that will free it, and it is a leak in every other case. The
 * language is unsafe here on purpose; `move` is how you say you meant it.
 */
declare function cstring(value: string): CString;

/**
 * Release a `CString` that came from a Goblin `string`.
 *
 * The companion to `cstring(move(…))`, and **only** to that. It calls Goblin's
 * own deallocator, which subtracts sixteen bytes to reach the length header —
 * so handing it a `CString` from anywhere else is not a leak, it is memory
 * corruption:
 *
 * ```ts
 * const mine = cstring(move(built));
 * cstring_free(mine);          // right
 *
 * declare function SDL_GetPrefPath(o: CString, a: CString): CString | null;
 * const theirs = SDL_GetPrefPath(cstring("acme"), cstring("game"));
 * cstring_free(theirs);        // WRONG — SDL allocated it, `SDL_free` releases it
 * ```
 *
 * There is deliberately **no `free()` method on `CString`**. A method would have
 * to pick one deallocator and there is no right one to pick: SDL's needs
 * `SDL_free`, `malloc`'s needs `free`, and only a moved Goblin string needs
 * this. Releasing a `CString` is always "call the free that came with it", which
 * is the same rule C has always had — and a named function per allocator is how
 * C says it.
 */
declare function cstring_free(value: CString): void;

// ---------------------------------------------------------------------------
// console
//
// The output methods, and only those. `log`, `info` and `debug` write to
// stdout; `warn` and `error` write to stderr, matching Node. Each writes one
// line.
//
// Arguments are converted the same way an interpolation converts them, so
// `console.log(x)` and `console.log(`${x}`)` mean the same thing.
// ---------------------------------------------------------------------------

interface Console {
  log(message: string | number | boolean): void;
  info(message: string | number | boolean): void;
  debug(message: string | number | boolean): void;
  warn(message: string | number | boolean): void;
  error(message: string | number | boolean): void;
}

declare const console: Console;
