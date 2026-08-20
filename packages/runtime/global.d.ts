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
 *     sizeOf<FixedArray<u8, 128>>();   // 128, not 8
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
 * and what makes a C function taking `uint8_t*` callable with one. It decays to
 * a `Pointer<unknown>` too, so `char buf[1024]` reaches a `void *` parameter the
 * way it does in C, and to no other pointer type. The relation runs one way
 * only: a pointer never becomes a fixed array, because it does not carry a
 * length.
 *
 * A *temporary* array may be decayed into a call, which finishes before the
 * temporary does, but not bound to a name that would outlive it. `free()` and `freeArray()` are inherited and are undefined
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
 * `cast<usize>(…)`.
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
// Unions.
//
// A C `union`: every member starts at offset 0, and the whole thing is as big
// as the largest and as aligned as the strictest. Written by extending the
// marker, which is the declaration-site half of the same brand idea the widths
// and pointers use:
//
//     interface SDL_Event extends Union {
//       type: u32;
//       key: SDL_KeyboardEvent;
//       motion: SDL_MouseMotionEvent;
//     }
//
// Two rules follow from what a union *is*, and both are the compiler's:
//
// * **Members must be plain data.** Nothing in the bytes says which member is
//   live, so nothing can say which one to destroy. A union of owning types has
//   no definable destructor and is refused rather than guessed at.
// * **No object literal builds one.** tsc would demand every member, which is
//   the opposite of what a union means. One is zero-initialised, or filled by
//   the C function you handed it to — which is the whole use case.
//
// Reading a member other than the one last written is undefined, exactly as in
// C, and is not diagnosed: this is an unsafe language on purpose. The reliable
// read is the common initial sequence — the leading fields every member shares
// — which is what a tag like `SDL_Event.type` is.
// ---------------------------------------------------------------------------

declare const UnionBrand: unique symbol;

interface Union {
    /**
     * Optional, so that extending it costs nothing structurally and adds no
     * field. Symbol-keyed, so no source file can spell it and claim to be a
     * union without saying so.
     */
    readonly [UnionBrand]?: never;
}

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
//
// `Pointer<unknown>` is C's `void *` — an address with the type deliberately
// thrown away, for the C signatures that need one: a callback's userdata,
// `memcpy`, a property bag. Any pointer converts to one implicitly; getting a
// type back is `reify<T>()`, and everything that would read through the pointer
// in between is refused (`GF0305`).
//
// `Pointer<T> | null` is C's nullable pointer, and `null` is C's NULL: one
// machine word of zero. The union costs no representation — it erases to the
// same word — so nullability is entirely tsc's view of the program, and tsc is
// what insists on the check before the use. Only the borrowed handles have a
// null; a `string` or a `T[]` owns its buffer and has none (`GF0237`).
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

    /**
     * `p + n`, in units of `T` — C's pointer arithmetic.
     *
     * A method rather than a free function because there is a receiver to hang it
     * on, which is also why it needs no prefix to say it is unsafe. Nothing
     * checks that the result points at anything.
     */
    offset(elements: isize): Pointer<T>;

    /**
     * Discard the pointee type. `Pointer<unknown>` is the language's only
     * type-erased pointer and the only escape hatch in the ambient surface —
     * there is deliberately no `any` and no unchecked cast between two concrete
     * pointee types.
     *
     * Rarely needed, because erasure is **implicit** wherever a `Pointer<unknown>`
     * is expected, exactly as `T *` converts to `void *` in C. Write it where
     * there is no such context to convert into — a binding being handed to
     * something generic, or a `const` with no annotation.
     */
    erase(): Pointer<unknown>;

    /**
     * Re-attach a pointee type to an erased pointer. Entirely on your honour.
     *
     * The direction that is never implicit, for C's reason: throwing the type
     * away cannot be wrong, and guessing it back can. Only callable on a
     * `Pointer<unknown>` — reinterpreting one concrete type as another is
     * `p.erase().reify<Other>()`, written out (`GF0306`), so that the escape
     * hatch is visible at the site that depends on it.
     */
    reify<U>(): Pointer<U>;
}

/**
 * Members of {@link CorePointer} are **reserved on every class**.
 *
 * `Pointer<T>` is `T & CorePointer<T>`, so a class that declares `free` or
 * `address` has a member that can never be reached through a pointer to it —
 * the pointer's own wins, silently. tsc cannot see the problem, because the
 * intersection is perfectly well typed; the compiler rejects it instead
 * (`GF0002`), at the declaration rather than at the confusing call site.
 */
/**
 * `[T] extends […]`, not `T extends …`, and the brackets are load-bearing.
 *
 * A naked `T` on the left of a conditional type is *distributive*: for a `T`
 * that is a union, tsc evaluates the conditional once per constituent and
 * unions the results, rather than once for the union as a whole. A
 * multi-member enum's type **is** such a union — `E` is `E.A | E.B | …` — so
 * an unbracketed `Pointer<E>` resolved to `CorePointer<E.A> | CorePointer<E.B>`
 * instead of `CorePointer<E>`, and that reconstructed union does not carry the
 * `EnumLike` flag `enumUnderlying` (`checker/src/types.ts`) checks for, so
 * `E` erased as "no machine representation yet" — silently, and only for an
 * enum with more than one member, since a single-member enum's type is not a
 * union and never distributes. Verified against real tsc, not assumed.
 *
 * The one-tuple on both sides is the standard way to opt a conditional type
 * out of distribution: `[T] extends [U]` compares the *tuple*, which is never
 * a union even when `T` is one.
 */
type Pointer<T> = [T] extends [GfPrimitive] ? CorePointer<T> : T & CorePointer<T>;

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

/** `[T] extends […]`, not `T extends …` — same distribution hazard as {@link Pointer}. */
type Reference<T> = [T] extends [GfPrimitive] ? ReferenceCore<T> : T & ReferenceCore<T>;

// ---------------------------------------------------------------------------
// Closures. DECISIONS §18: three function types, all written down.
//
// A bare `(a: i32) => i32` is one code address and nothing else, so a lambda
// that captures cannot be one — that is an error at the lambda. `LocalFn<F>`
// is the form that may capture, and it is a **borrow**: its environment lives
// in the caller's frame, so it costs no allocation and may not outlive the
// call it was passed to.
//
// The escaping form, `HeapFn<F>`, is §18 step 2 and does not exist yet.
// ---------------------------------------------------------------------------

declare const LocalFnBrand: unique symbol;

interface LocalFnCore<F> {
    /**
     * **Optional**, and that is what lets a lambda be written at the call site:
     * optional-and-absent is assignable, so `(x: i32) => x * 2` satisfies a
     * `LocalFn` parameter with nothing to spell. The same property means
     * TypeScript will *also* let a `LocalFn` be assigned to a plain `F`, which
     * is the escape this type exists to forbid — so the escape rule is the
     * compiler's, raised as a `GF02xx`, and not tsc's.
     *
     * A required brand, the way {@link FixedArray} does it, would close that
     * direction and break every call site in exchange. It is the wrong trade
     * here: the lambda is written far more often than the escape is attempted.
     */
    readonly [LocalFnBrand]?: F;
}

/**
 * A function value that may capture, whose captures are **references into the
 * frame that created it**, and which therefore may not escape the call.
 *
 *     function each(xs: i32[], f: LocalFn<(x: i32) => void>): void {
 *         for (let i: usize = 0; i < xs.length; i++) f(xs[i]);
 *     }
 *
 *     let total: i32 = 0;
 *     each(xs, (x) => { total += x; });   // no allocation; total is the frame's
 *
 * The contract is escape, not storage: binding one to a name inside the callee
 * is fine, and so is handing it to another `LocalFn` parameter, because neither
 * outlives the call. Returning one, storing one in a struct field or an array,
 * or capturing one inside a closure that escapes are the cases that are
 * refused.
 *
 * It removes the allocation. It does not remove the call — that is one indirect
 * call through a two-word value per invocation, and collapsing it into the
 * caller needs monomorphisation (REWRITE-PLAN §11.7) and an inliner (§17).
 *
 * A non-capturing lambda is accepted here too, with a null environment, so a
 * caller never has to know which kind it wrote.
 */
type LocalFn<F extends (...args: never[]) => unknown> = F & LocalFnCore<F>;

// ---------------------------------------------------------------------------
// Memory intrinsics. Manual, C++-style, unverified. There is no GC, no
// refcount, and no borrow checker: `free()` on a pointer that is still
// live is your bug, and the compiler will not find it for you.
// ---------------------------------------------------------------------------

/**
 * Every field optional, at every depth — the initialiser {@link alloc} takes.
 *
 * A C API's create-info struct is mostly nesting and mostly zero:
 * `SDL_GPUGraphicsPipelineCreateInfo` reaches three levels down to
 * `depth_stencil_state.back_stencil_state.fail_op`, and a caller sets a handful
 * of leaves. One level of `Partial` does not help, because overriding a nested
 * field still demands that field *complete*.
 *
 * The four bails are the whole design, and each one is a type that must be
 * supplied whole rather than picked apart:
 *
 *   * a **primitive** — `i32` is `number & __GfWidth<"i32">`, so it would
 *     otherwise take the object branch and map to its own brand;
 *   * a **function** — a C struct of callbacks holds `feed: () => void` as an
 *     ordinary field, and mapping over a function type gives `{}`, which
 *     accepts anything at all;
 *   * a **pointer or reference** — `Pointer<T>` is `T & CorePointer<T>`, so
 *     recursing would splice the *pointee's* fields into the initialiser and
 *     let `{ shader: { fail: 1 } }` pass for an address. `FixedArray<T, N>`
 *     extends `CorePointer<T>` and is caught here too, which is right: it is
 *     the bytes, and `fixedArray(…)` is how you make one;
 *   * an **array** — `T[]` owns its buffer, and half a buffer is not a thing.
 *
 * `[T] extends [X]` rather than `T extends X` throughout, for the same reason
 * {@link Pointer} spells it that way: a bare conditional distributes over a
 * union, and `Reference<T> | null` is a union.
 *
 * The type is deliberately looser than the language. It cannot tell a struct
 * shape from a dispatched contract — that distinction is the compiler's, not
 * tsc's — so the frontend still refuses what this admits, with a diagnostic
 * that names the construct.
 */
type DeepPartial<T> =
    [T] extends [GfPrimitive]
        ? T
        : [T] extends [(...args: never[]) => unknown]
            ? T
            : [T] extends [CorePointer<unknown>]
                ? T
                : [T] extends [ReferenceCore<unknown>]
                    ? T
                    : [T] extends [Array<unknown>]
                        ? T
                        : { [K in keyof T]?: DeepPartial<T[K]> };

/**
 * Construct a `T` on the heap and hand back its address — C++ `new T(...)`.
 *
 *     const r = alloc(Rect, 6, 7);      // Pointer<Rect>, constructed
 *     console.log(`${r.area()}`);       // dereferences
 *     r.free();                         // yours to call, and nobody calls it
 *
 *     const n = alloc<i32>();           // Pointer<i32>, zeroed
 *     n.free();
 *
 *     const p = alloc<SDL_GPUGraphicsPipelineCreateInfo>({
 *         vertex_shader: vs,            // the rest stays zero
 *         depth_stencil_state: { back_stencil_state: { fail_op: Keep } },
 *     });
 *     p.free();
 *
 * Three spellings and **one operation**. Naming a class runs its constructor;
 * naming a type does not, because there is no constructor to run — but the
 * storage is default-initialised either way, which is the part worth being
 * precise about, and is what makes the third spelling only a shorthand: the
 * initialiser writes the fields it names into storage that is already zero,
 * so `alloc<T>({})` and `alloc<T>()` are the same program.
 *
 * The initialiser is for C's aggregates. A class is refused, because its
 * fields are reached past a constructor that never ran — `alloc(C, …)` is the
 * spelling that runs it.
 *
 * There is deliberately no uninitialised form, for the same reason
 * {@link fixedArray} has none: a destructor releases what a slot holds, and on
 * uninitialised memory that is a garbage pointer. An allocation that hands back
 * bytes nobody has written is a `free()` away from a crash, and the crash is
 * nowhere near the mistake.
 *
 * Where `new Rect(6, 7)` gives a value that its scope releases, this gives a
 * pointer that outlives the scope and leaks if you drop it. That is the whole
 * distinction, and it is the same one C++ draws.
 */
declare function alloc<T>(): Pointer<T>;
declare function alloc<T extends object, A extends readonly unknown[]>(
    klass: new (...args: A) => T,
    ...args: A
): Pointer<T>;
declare function alloc<T>(init: DeepPartial<T>): Pointer<T>;

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

/**
 * Allocate `count` contiguous `T` on the heap — C++ `new T[n]`.
 *
 * The count is a runtime value, which is the whole reason this exists: a length
 * known at compile time is a `FixedArray<T, N>` and costs no allocation.
 *
 * Every element is default-initialised, for the same reason {@link alloc} has
 * no uninitialised form. There is nowhere to put a constructor's arguments, so
 * a class that declares one is refused — exactly as `new T[n]` in C++ needs a
 * default constructor.
 *
 * The count is stored in a hidden word just before the first element, which is
 * how `freeArray` knows how many destructors to run. That costs one machine
 * word per allocation and is what C++ does; it also means the pointer you get
 * back is **not** the start of the block, so it must not be handed to `free`,
 * to `realloc`, or to anything else that expects an allocator's own pointer.
 *
 * Released with `freeArray`, and never with `free`.
 */
declare function allocArray<T>(count: usize): Pointer<T>;

/**
 * Size of `T` in bytes, as laid out by this compiler.
 *
 * This is the *storage* size — what an array of `T` strides by and what
 * `alloc<T>()` reserves — never "what a register holds". The two are
 * different questions and this answers only one of them.
 *
 * It is C's `sizeof`, padding included: `{ a: i32, b: i8 }` occupies five bytes
 * and this says eight, because that is what the sixth through eighth bytes are
 * for. So `sizeOf<T>() * n` is the right size for a buffer of `n`, which is the
 * whole reason it is the rounded number.
 */
declare function sizeOf<T>(): usize;

/** Alignment of `T` in bytes. */
declare function alignOf<T>(): usize;

/**
 * A `T` whose bytes are all zero — what `alloc<T>()` gives, on the stack.
 *
 *     let event = zeroed<SDL_Event>();
 *     event.type = SDL_EventType.Quit;
 *
 * This is how a {@link Union} is made **by value**. A C function that *fills*
 * one needs a pointer to it, and there is no way to take the address of a
 * local — so that case is `alloc<SDL_Event>()` instead, whose pointer reaches
 * the members directly and is released with `.free()`.
 *
 * An object literal cannot build one —
 * it would have to supply every member, and a union has room for one — so
 * zeroing and then assigning the member you mean is the whole construction
 * story, exactly as it is in C.
 *
 * Not restricted to unions: a zeroed struct is an ordinary thing to want, and
 * zero is what every field of one would be initialised to anyway.
 *
 * A class is refused. `Default` would zero it and install its vtable without
 * running its constructor, and `new C(…)` is the spelling that runs it.
 */
declare function zeroed<T>(): T;

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
// `cast` is that written form. It is also the only way to narrow, since
// silent truncation is how you lose an afternoon.
// ---------------------------------------------------------------------------

/** Convert a numeric value to another fixed width. */
declare function cast<T extends number>(value: number): T;

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
// Raw memory is still yours to manage — `alloc` and `free` have not
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

/**
 * Copy `length` bytes into a managed string, terminator or not.
 *
 * The one to reach for at a C boundary, because the length usually arrives in
 * the same call as the pointer:
 *
 * ```ts
 * const size: FixedArray<usize, 1> = fixedArray(1, 0);
 * const data = SDL_LoadFile_IO(io, size, false);
 * if (data !== null) {
 *   console.log(stringFromBytes(data.reify<u8>(), size[0]));
 *   SDL_free(data);
 * }
 * ```
 *
 * {@link stringFromCString} would scan those bytes for a NUL — a second pass
 * over bytes already measured, and the *wrong* answer rather than merely a slow
 * one if the data contains a zero, because the string would stop there. Use the
 * scanning version only when a length is genuinely not available.
 *
 * The bytes are copied, so they stay whoever's they were: a buffer a C library
 * allocated is still released by that library's own deallocator.
 */
declare function stringFromBytes(bytes: Pointer<u8> | CString, length: usize): string;

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
 * cstringFree(mine);          // right
 *
 * declare function SDL_GetPrefPath(o: CString, a: CString): CString | null;
 * const theirs = SDL_GetPrefPath(cstring("acme"), cstring("game"));
 * cstringFree(theirs);        // WRONG — SDL allocated it, `SDL_free` releases it
 * ```
 *
 * There is deliberately **no `free()` method on `CString`**. A method would have
 * to pick one deallocator and there is no right one to pick: SDL's needs
 * `SDL_free`, `malloc`'s needs `free`, and only a moved Goblin string needs
 * this. Releasing a `CString` is always "call the free that came with it", which
 * is the same rule C has always had — and a named function per allocator is how
 * C says it.
 */
declare function cstringFree(value: CString): void;

// ---------------------------------------------------------------------------
// The allocator, by its C name
//
// Every Goblin program links mimalloc, because the runtime allocates through
// it: `new`, `alloc`, a `string`, a `T[]` — all of it is `mi_malloc` underneath.
// These eight are that same allocator under its own C names, and they are the
// only names in this prelude that are **not** intrinsics: each one is an
// ordinary `extern "C"` call to a symbol already in the binary.
//
// They exist for one job. A C library that lets its allocator be replaced —
// SDL's `SDL_SetMemoryFunctions`, and it is far from alone — wants four
// function pointers whose signatures are exactly C's `malloc`, `calloc`,
// `realloc` and `free`. Handing it these makes the library allocate from the
// same heap the program does, which turns two allocators competing over one
// address space into one:
//
// ```ts
// declare function SDL_SetMemoryFunctions(
//   malloc_fn: (size: usize) => Pointer<unknown> | null,
//   calloc_fn: (count: usize, size: usize) => Pointer<unknown> | null,
//   realloc_fn: (mem: Pointer<unknown> | null, size: usize) => Pointer<unknown> | null,
//   free_fn: (mem: Pointer<unknown> | null) => void,
// ): boolean;
//
// SDL_SetMemoryFunctions(mi_malloc, mi_calloc, mi_realloc, mi_free);
// ```
//
// Write the parameter types **exactly** as above. A function pointer is checked
// one level in, so a `(size: usize) => Pointer<unknown>` that drops the `| null`
// is a different type from `mi_malloc` and is refused — which is the check
// doing its job, because a `malloc` that cannot fail is a claim C does not make.
//
// Two things to know before reaching for them:
//
//   * **A block from here is not a Goblin value.** Nothing constructs into it,
//     nothing destroys out of it, and no scope releases it. `alloc<T>()` is what
//     you want for a `T`; these are for handing an allocator to someone else.
//   * **The library has to be told before it allocates.** SDL wants
//     `SDL_SetMemoryFunctions` before `SDL_Init`. Memory a library took from its
//     own allocator before the swap must still go back to that one, and passing
//     it to `mi_free` afterwards is heap corruption rather than a leak.
// ---------------------------------------------------------------------------

/** C's `malloc`. Null when the allocation fails. */
declare function mi_malloc(size: usize): Pointer<unknown> | null;

/** C's `calloc`: `count * size` bytes, zeroed. */
declare function mi_calloc(count: usize, size: usize): Pointer<unknown> | null;

/**
 * C's `realloc`. Null on failure, and the original block is **still live** —
 * assigning the result over the only copy of the pointer leaks it, exactly as
 * it does in C.
 */
declare function mi_realloc(mem: Pointer<unknown> | null, size: usize): Pointer<unknown> | null;

/** C's `free`. A null pointer is a no-op, as it is in C. */
declare function mi_free(mem: Pointer<unknown> | null): void;

/** `size` bytes, zeroed. `mi_calloc` without the multiplication. */
declare function mi_zalloc(size: usize): Pointer<unknown> | null;

/**
 * `size` bytes on an `align` boundary, where `align` is a power of two.
 *
 * The reason this family is worth having at all: a block from here goes back
 * through the same one-argument `mi_free`, whatever its alignment. Windows'
 * `_aligned_malloc` needs `_aligned_free` and pairing them wrongly is
 * undefined; there is no second free here to pair wrongly.
 */
declare function mi_malloc_aligned(size: usize, align: usize): Pointer<unknown> | null;

/** `mi_realloc`, keeping the block on an `align` boundary. */
declare function mi_realloc_aligned(
    mem: Pointer<unknown> | null,
    size: usize,
    align: usize,
): Pointer<unknown> | null;

/**
 * How many bytes are actually usable at `mem` — at least what was asked for,
 * and often more, because a request is rounded up to a size class.
 *
 * Zero for a null pointer. Undefined for anything this allocator did not hand
 * out, which includes a pointer from a C library that never took the swap.
 */
declare function mi_usable_size(mem: Pointer<unknown> | null): usize;

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
