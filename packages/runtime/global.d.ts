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

    /**
     * Call `f` with each element, in order.
     *
     *     let total: i32 = 0;
     *     xs.forEach((x) => { total = total + x; });
     *
     * The loop is emitted inline and `f` is a {@link LocalFn}, so this costs no
     * allocation: the closure's captures are references into the frame that
     * wrote them, and there is nothing to release afterwards.
     *
     * **The length is read once, before the first call.** Growing or shrinking
     * the array from inside `f` is undefined, exactly as mutating a
     * `std::vector` while iterating it is — and a `push` in particular would
     * otherwise be a loop that does not end.
     *
     * The element arrives **by value**, so a `string[]` copies each string into
     * the call. That is what a by-value parameter means everywhere else here;
     * take a `Reference<T>` where the copy is not wanted.
     */
    forEach(f: LocalFn<(value: T) => void>): void;
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
// only names this prelude declares that are **not** intrinsics: each one is an
// ordinary `extern "C"` call to a symbol already in the binary.
//
// **They are the first thing that is not global.** Everything above is in scope
// in every file whether or not it is wanted; these are imported, which is what
// a standard library has to be if it is going to grow — a global surface has
// room for `console` and the widths and not for a hundred functions per module.
// The specifier is a bare `std/…` name that resolves to nothing on disk, which
// is what makes it an *ambient* module: it is this declaration, and there is no
// package to install and no path to configure.
//
//     import { mi_malloc, mi_free } from "std/alloc";
//
// They exist for one job. A C library that lets its allocator be replaced —
// SDL's `SDL_SetMemoryFunctions`, and it is far from alone — wants four
// function pointers whose signatures are exactly C's `malloc`, `calloc`,
// `realloc` and `free`. Handing it these makes the library allocate from the
// same heap the program does, which turns two allocators competing over one
// address space into one:
//
// ```ts
// import { mi_calloc, mi_free, mi_malloc, mi_realloc } from "std/alloc";
//
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

declare module "std/alloc" {
    /** C's `malloc`. Null when the allocation fails. */
    export function mi_malloc(size: usize): Pointer<unknown> | null;

    /** C's `calloc`: `count * size` bytes, zeroed. */
    export function mi_calloc(count: usize, size: usize): Pointer<unknown> | null;

    /**
     * C's `realloc`. Null on failure, and the original block is **still live** —
     * assigning the result over the only copy of the pointer leaks it, exactly
     * as it does in C.
     */
    export function mi_realloc(
        mem: Pointer<unknown> | null,
        size: usize,
    ): Pointer<unknown> | null;

    /** C's `free`. A null pointer is a no-op, as it is in C. */
    export function mi_free(mem: Pointer<unknown> | null): void;

    /** `size` bytes, zeroed. `mi_calloc` without the multiplication. */
    export function mi_zalloc(size: usize): Pointer<unknown> | null;

    /**
     * `size` bytes on an `align` boundary, where `align` is a power of two.
     *
     * The reason this family is worth having at all: a block from here goes
     * back through the same one-argument `mi_free`, whatever its alignment.
     * Windows' `_aligned_malloc` needs `_aligned_free` and pairing them wrongly
     * is undefined; there is no second free here to pair wrongly.
     */
    export function mi_malloc_aligned(size: usize, align: usize): Pointer<unknown> | null;

    /** `mi_realloc`, keeping the block on an `align` boundary. */
    export function mi_realloc_aligned(
        mem: Pointer<unknown> | null,
        size: usize,
        align: usize,
    ): Pointer<unknown> | null;

    /**
     * How many bytes are actually usable at `mem` — at least what was asked
     * for, and often more, because a request is rounded up to a size class.
     *
     * Zero for a null pointer. Undefined for anything this allocator did not
     * hand out, which includes a pointer from a C library that never took the
     * swap.
     */
    export function mi_usable_size(mem: Pointer<unknown> | null): usize;
}

// ---------------------------------------------------------------------------
// Files, by their C shape
//
// `std/io` is stdio with the names spelled out, and it is deliberately the
// shape C has rather than the shape the rest of this language has:
//
//     import { fileClose, fileOpen, fileWrite } from "std/io";
//
//     const f = fileOpen("notes.txt", "w");
//     if (f === null) { return 1; }
//     fileWrite(f, "hello\n");
//     fileClose(f);
//
// **A `File` is not a value and no scope releases it.** It is an opaque handle
// behind a `Pointer<File>`, closed by the call you write and by nothing else —
// the same bargain `alloc` and `free` strike, and the opposite of the one a
// `string` strikes. A file nobody closes is a leak, and it is a *detected* one:
// the handle comes from the same allocator everything else does, so the
// live-allocation check counts it and a test that forgets fails.
//
// `fileClose` is C's `fclose`: it closes the descriptor **and** releases the
// handle, in one call, so there is no order to get wrong. Which means
// `file.free()` is never right on one of these — it would release the handle
// and leave the descriptor open. The pointer methods are inherited and cannot
// be taken away, exactly as they are on a `FixedArray`, and this is the same
// kind of mistake `free(buf)` is in C.
//
// The three standard streams are functions rather than constants, and they are
// **not** closable: `fileClose(stdout())` is a no-op rather than a way to take
// `console.log` down with it. `stdout()` writes the same bytes `console.log`
// does, through the same unbuffered path — on Windows that means going around
// the CRT, which would otherwise turn every `\n` into `\r\n`.
// ---------------------------------------------------------------------------

declare module "std/io" {
    /**
     * An open file.
     *
     * Opaque: this build has no layout for one and there is nothing to read
     * through the pointer. Everything a file can be asked is a function below,
     * which is what makes the handle free to change without a program noticing.
     */
    export class File {
        private _file: never;
    }

    /**
     * Open a file by name, in the `mode` C's `fopen` takes — `"r"`, `"w"`,
     * `"a"`, and the `"b"` and `"+"` spellings.
     *
     * `null` when it could not be opened, which is the only thing this reports:
     * *why* is C's `errno` and there is no portable way to ask it from here.
     */
    export function fileOpen(path: string, mode: string): Pointer<File> | null;

    /**
     * Close a file and release its handle — C's `fclose`.
     *
     * Both halves, in one call. A standard stream is a no-op, so a function
     * that takes "a file" and closes it when it is done does not have to ask
     * which kind it was given.
     */
    export function fileClose(file: Pointer<File>): void;

    /**
     * Write a string's bytes. The count is how many actually moved, which on a
     * full disk or a closed pipe is less than the string's length.
     *
     * The string is **borrowed**, like every other string handed to a function:
     * the caller still owns it and its scope still releases it.
     */
    export function fileWrite(file: Pointer<File>, text: string): usize;

    /**
     * Read at most `max` bytes, as a `string` the calling scope owns.
     *
     * **An empty string means there is no more input**, and that is the whole
     * end-of-file story — one rule for a file and for `stdin()` alike, where a
     * `feof` would have had nothing to read.
     *
     * The bytes are whatever was in the file. A read that stops in the middle
     * of a multi-byte character produces a string that is not valid UTF-8, in
     * exactly the way `substring` through one does.
     */
    export function fileRead(file: Pointer<File>, max: usize): string;

    /**
     * Read from the position to the end, as a `string` the calling scope owns.
     *
     * **From the position, not from the start**, so it composes with
     * {@link fileSeek}: after reading a header, this is the rest, and reading a
     * whole file that has already been read from is `fileSeek(f, 0, Seek.Set)`
     * away.
     *
     * Works on `stdin()` too, where there is no size to ask for — the buffer
     * doubles instead. That is the case a `fileSize`-then-`fileRead` pair
     * cannot serve, and the reason this exists rather than being written out at
     * each call site.
     */
    export function fileReadAll(file: Pointer<File>): string;

    /** Where {@link fileSeek} measures from. */
    export enum Seek {
        /** The start of the file. `offset` is an absolute position. */
        Set = 0,
        /** Where the position is now. `offset` may be negative. */
        Current = 1,
        /** The end of the file. `offset` is usually zero or negative. */
        End = 2,
    }

    /**
     * Move the read/write position. `false` when it could not be moved.
     *
     * The offset is an `isize`, not a `long` — seeking past 2 GB works on every
     * platform, including the one whose `fseek` would silently have capped it.
     *
     * A standard stream is not seekable and answers `false` rather than
     * pretending to have moved.
     */
    export function fileSeek(file: Pointer<File>, offset: isize, from: Seek): boolean;

    /**
     * Where the position is now, in bytes from the start, or `-1` if the file
     * has no position — which a standard stream does not.
     */
    export function fileTell(file: Pointer<File>): isize;

    /**
     * How many bytes the file holds, or `-1` when that cannot be known.
     *
     * Asked by seeking to the end and back, and the position is restored
     * exactly — including when the answer is `-1`, so a failed size never also
     * moves the file.
     */
    export function fileSize(file: Pointer<File>): isize;

    /** Flush what is buffered. The standard streams are unbuffered already. */
    export function fileFlush(file: Pointer<File>): void;

    /** Standard input. Not closable. */
    export function stdin(): Pointer<File>;

    /** Standard output — the same stream `console.log` writes. Not closable. */
    export function stdout(): Pointer<File>;

    /** Standard error — the same stream `console.error` writes. Not closable. */
    export function stderr(): Pointer<File>;
}

// ---------------------------------------------------------------------------
// Scalar maths
//
// **Two of everything, and the prefix says which.** `dsin` takes an `f64`,
// `fsin` an `f32`:
//
//     import { datan2, dhypot, dsqrt } from "std/math";
//
//     const r = dhypot(x, y);
//     const bearing = datan2(y, x);
//
// There is no unprefixed `sin`, and that is the same rule the rest of the
// language follows rather than an inconvenience layered on top. A single `sin`
// would have to take one width, and every call with the other would either be
// refused — leaving you to write the conversion this module was supposed to
// spare you — or promoted silently, which is the thing fixed widths exist to
// stop. `f32` is not a smaller `f64`; `dsin(x)` on an `f32` costs a widening,
// and the name is where you can see it.
//
// The implementation is a MUSL port compiled into the runtime, not the
// platform's libm, so **every target gives the same bits**. Two consequences
// worth knowing: nothing has to be linked (a Goblin program never passes `-lm`,
// and would have failed on Linux if this called the system's), and a value
// printed on one machine is the value printed on another.
//
// Every one of these is **total**. `dsqrt(-1)` is a NaN, `dlog(0)` is negative
// infinity, and `dfmod(x, 0)` is a NaN — nothing here traps, raises, or has an
// error to report, exactly as in C. `disnan` is how you ask afterwards.
//
// The constants are functions because the language has no top-level `const` to
// bind one to. `dpi()` is a call, and a cheap one.
// ---------------------------------------------------------------------------

declare module "std/math" {
    // -- f64 -----------------------------------------------------------------

    /** Trigonometry, in radians. `dasin`/`dacos` are NaN outside [-1, 1]. */
    export function dsin(x: f64): f64;
    export function dcos(x: f64): f64;
    export function dtan(x: f64): f64;
    export function dasin(x: f64): f64;
    export function dacos(x: f64): f64;
    export function datan(x: f64): f64;

    /**
     * The angle to `(x, y)` from the positive x-axis, in `(-pi, pi]`.
     *
     * `y` first, as in C. It is the quadrant-correct `datan(y / x)`, and it is
     * the one to reach for: the division loses the quadrant and divides by zero
     * on the y-axis.
     */
    export function datan2(y: f64, x: f64): f64;

    export function dsinh(x: f64): f64;
    export function dcosh(x: f64): f64;
    export function dtanh(x: f64): f64;

    /** `dlog` is the natural logarithm. Negative input is a NaN, zero is -inf. */
    export function dexp(x: f64): f64;
    export function dexp2(x: f64): f64;
    export function dlog(x: f64): f64;
    export function dlog2(x: f64): f64;
    export function dlog10(x: f64): f64;
    export function dpow(base: f64, exponent: f64): f64;
    export function dsqrt(x: f64): f64;
    export function dcbrt(x: f64): f64;

    /**
     * `dsqrt(x*x + y*y)`, without the overflow.
     *
     * The intermediate square is what overflows, and at astronomical scale it
     * does so long before the answer would: a length that fits in an `f64`
     * comes back as infinity because the square of one leg did not.
     */
    export function dhypot(x: f64, y: f64): f64;

    /** `dround` goes away from zero at the halfway point, as C's does. */
    export function dfloor(x: f64): f64;
    export function dceil(x: f64): f64;
    export function dround(x: f64): f64;
    export function dtrunc(x: f64): f64;
    export function dabs(x: f64): f64;

    /** The remainder of `x / y`, taking its sign from `x`. NaN when `y` is zero. */
    export function dfmod(x: f64, y: f64): f64;

    /** A NaN operand loses: `dmin(nan, 3)` is 3, which is C's rule, not `<`'s. */
    export function dmin(x: f64, y: f64): f64;
    export function dmax(x: f64, y: f64): f64;

    /** The magnitude of `x` with the sign of `y` — including the sign of a zero. */
    export function dcopysign(x: f64, y: f64): f64;

    /**
     * `disnan` is the only way to ask: a NaN is not equal to itself, so
     * `x !== x` is the C idiom and `x === dnan()` is always false.
     */
    export function disnan(x: f64): boolean;
    export function disinf(x: f64): boolean;
    export function disfinite(x: f64): boolean;

    /** Constants, as calls. `de` is Euler's number; `dtau` is `2 * dpi()`. */
    export function dpi(): f64;
    export function dtau(): f64;
    export function de(): f64;
    export function dinf(): f64;
    export function dnan(): f64;

    // -- f32 -----------------------------------------------------------------
    //
    // The same set, to the bit where the width allows it. Reach for these when
    // the storage is `f32` and widening every call would be the only reason the
    // program touched an `f64` at all.

    export function fsin(x: f32): f32;
    export function fcos(x: f32): f32;
    export function ftan(x: f32): f32;
    export function fasin(x: f32): f32;
    export function facos(x: f32): f32;
    export function fatan(x: f32): f32;
    export function fatan2(y: f32, x: f32): f32;

    export function fsinh(x: f32): f32;
    export function fcosh(x: f32): f32;
    export function ftanh(x: f32): f32;

    export function fexp(x: f32): f32;
    export function fexp2(x: f32): f32;
    export function flog(x: f32): f32;
    export function flog2(x: f32): f32;
    export function flog10(x: f32): f32;
    export function fpow(base: f32, exponent: f32): f32;
    export function fsqrt(x: f32): f32;
    export function fcbrt(x: f32): f32;
    export function fhypot(x: f32, y: f32): f32;

    export function ffloor(x: f32): f32;
    export function fceil(x: f32): f32;
    export function fround(x: f32): f32;
    export function ftrunc(x: f32): f32;
    export function fabs(x: f32): f32;

    export function ffmod(x: f32, y: f32): f32;
    export function fmin(x: f32, y: f32): f32;
    export function fmax(x: f32, y: f32): f32;
    export function fcopysign(x: f32, y: f32): f32;

    export function fisnan(x: f32): boolean;
    export function fisinf(x: f32): boolean;
    export function fisfinite(x: f32): boolean;

    export function fpi(): f32;
    export function ftau(): f32;
    export function fe(): f32;
    export function finf(): f32;
    export function fnan(): f32;
}

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

// ---------------------------------------------------------------------------
// std/linalg
//
// GLM's shape, for a language with no operator overloading: `dvec3.add(a, b)`
// returns a copy, `a.add(b)` returns a copy, and `a.addMut(b)` mutates in place
// and hands back a reference so mutations chain.
//
// A type's *storage* is a plain struct — `dvec3` is three `f64` and nothing
// else, which is what a vertex buffer holds and what crosses the C boundary.
// Its *arithmetic* goes through the vector unit, and the `aligned_` forms are
// padded to a whole register so that arithmetic is one instruction rather than
// two. Nothing converts implicitly, in either direction.
//
// DECISIONS §22 is the reasoning. This block is generated; see gen-linalg.ts.
// ---------------------------------------------------------------------------
// <generated by gen-linalg.ts — do not edit by hand>
//
// Regenerate with `bun run build:linalg` after changing
// `packages/checker/src/linalg.ts`, which is where these come from.

declare module "std/linalg" {
    /**
     * `dvec2` — 2 `f64`.
     *
     * Exactly 2 components and no padding — 16 bytes — so an array of
     * them is the layout a vertex buffer wants.
     */
    export class dvec2 {
        private readonly __linalg: "dvec2";

        constructor(x: f64, y: f64);

        x: f64;
        y: f64;

        [index: number]: f64;

        /** Every component zero. */
        static zero(): dvec2;

        /** Every component one. */
        static one(): dvec2;

        /** Every component the same value. */
        static splat(value: f64): dvec2;

        /** The x-axis: 1 in component 0, 0 elsewhere. */
        static unitX(): dvec2;

        /** The y-axis: 1 in component 1, 0 elsewhere. */
        static unitY(): dvec2;

        /**
         * Convert from another 2-component vector.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: fvec2): dvec2;

        static add(a: dvec2, b: dvec2): dvec2;
        add(other: dvec2): dvec2;
        addMut(other: dvec2): Reference<dvec2>;

        static sub(a: dvec2, b: dvec2): dvec2;
        sub(other: dvec2): dvec2;
        subMut(other: dvec2): Reference<dvec2>;

        static mul(a: dvec2, b: dvec2): dvec2;
        mul(other: dvec2): dvec2;
        mulMut(other: dvec2): Reference<dvec2>;

        static div(a: dvec2, b: dvec2): dvec2;
        div(other: dvec2): dvec2;
        divMut(other: dvec2): Reference<dvec2>;

        static min(a: dvec2, b: dvec2): dvec2;
        min(other: dvec2): dvec2;
        minMut(other: dvec2): Reference<dvec2>;

        static max(a: dvec2, b: dvec2): dvec2;
        max(other: dvec2): dvec2;
        maxMut(other: dvec2): Reference<dvec2>;

        static scale(a: dvec2, by: f64): dvec2;
        scale(by: f64): dvec2;
        scaleMut(by: f64): Reference<dvec2>;

        static addScaled(a: dvec2, b: dvec2, t: f64): dvec2;
        addScaled(other: dvec2, t: f64): dvec2;
        addScaledMut(other: dvec2, t: f64): Reference<dvec2>;

        static negate(a: dvec2): dvec2;
        negate(): dvec2;
        negateMut(): Reference<dvec2>;

        static abs(a: dvec2): dvec2;
        abs(): dvec2;
        absMut(): Reference<dvec2>;

        static sqrt(a: dvec2): dvec2;
        sqrt(): dvec2;
        sqrtMut(): Reference<dvec2>;

        static floor(a: dvec2): dvec2;
        floor(): dvec2;
        floorMut(): Reference<dvec2>;

        static ceil(a: dvec2): dvec2;
        ceil(): dvec2;
        ceilMut(): Reference<dvec2>;

        static round(a: dvec2): dvec2;
        round(): dvec2;
        roundMut(): Reference<dvec2>;

        static trunc(a: dvec2): dvec2;
        trunc(): dvec2;
        truncMut(): Reference<dvec2>;

        static normalize(a: dvec2): dvec2;
        normalize(): dvec2;
        normalizeMut(): Reference<dvec2>;

        static lerp(a: dvec2, b: dvec2, t: f64): dvec2;
        lerp(other: dvec2, t: f64): dvec2;
        lerpMut(other: dvec2, t: f64): Reference<dvec2>;

        static clamp(a: dvec2, low: dvec2, high: dvec2): dvec2;
        clamp(low: dvec2, high: dvec2): dvec2;
        clampMut(low: dvec2, high: dvec2): Reference<dvec2>;

        static dot(a: dvec2, b: dvec2): f64;
        dot(other: dvec2): f64;

        static lengthSq(a: dvec2): f64;
        lengthSq(): f64;

        static length(a: dvec2): f64;
        length(): f64;

        static distance(a: dvec2, b: dvec2): f64;
        distance(other: dvec2): f64;

        static distanceSq(a: dvec2, b: dvec2): f64;
        distanceSq(other: dvec2): f64;

        static equals(a: dvec2, b: dvec2): boolean;
        equals(other: dvec2): boolean;
    }

    /**
     * `dvec3` — 3 `f64`.
     *
     * Exactly 3 components and no padding — 24 bytes — so an array of
     * them is the layout a vertex buffer wants.
     * `aligned_dvec3` is the same maths with a lane of padding, and faster.
     */
    export class dvec3 {
        private readonly __linalg: "dvec3";

        constructor(x: f64, y: f64, z: f64);

        x: f64;
        y: f64;
        z: f64;

        [index: number]: f64;

        /** Every component zero. */
        static zero(): dvec3;

        /** Every component one. */
        static one(): dvec3;

        /** Every component the same value. */
        static splat(value: f64): dvec3;

        /** The x-axis: 1 in component 0, 0 elsewhere. */
        static unitX(): dvec3;

        /** The y-axis: 1 in component 1, 0 elsewhere. */
        static unitY(): dvec3;

        /** The z-axis: 1 in component 2, 0 elsewhere. */
        static unitZ(): dvec3;

        /**
         * Convert from another 3-component vector.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: aligned_dvec3): dvec3;
        static from(value: fvec3): dvec3;
        static from(value: aligned_fvec3): dvec3;

        static add(a: dvec3, b: dvec3): dvec3;
        add(other: dvec3): dvec3;
        addMut(other: dvec3): Reference<dvec3>;

        static sub(a: dvec3, b: dvec3): dvec3;
        sub(other: dvec3): dvec3;
        subMut(other: dvec3): Reference<dvec3>;

        static mul(a: dvec3, b: dvec3): dvec3;
        mul(other: dvec3): dvec3;
        mulMut(other: dvec3): Reference<dvec3>;

        static div(a: dvec3, b: dvec3): dvec3;
        div(other: dvec3): dvec3;
        divMut(other: dvec3): Reference<dvec3>;

        static min(a: dvec3, b: dvec3): dvec3;
        min(other: dvec3): dvec3;
        minMut(other: dvec3): Reference<dvec3>;

        static max(a: dvec3, b: dvec3): dvec3;
        max(other: dvec3): dvec3;
        maxMut(other: dvec3): Reference<dvec3>;

        static scale(a: dvec3, by: f64): dvec3;
        scale(by: f64): dvec3;
        scaleMut(by: f64): Reference<dvec3>;

        static addScaled(a: dvec3, b: dvec3, t: f64): dvec3;
        addScaled(other: dvec3, t: f64): dvec3;
        addScaledMut(other: dvec3, t: f64): Reference<dvec3>;

        static negate(a: dvec3): dvec3;
        negate(): dvec3;
        negateMut(): Reference<dvec3>;

        static abs(a: dvec3): dvec3;
        abs(): dvec3;
        absMut(): Reference<dvec3>;

        static sqrt(a: dvec3): dvec3;
        sqrt(): dvec3;
        sqrtMut(): Reference<dvec3>;

        static floor(a: dvec3): dvec3;
        floor(): dvec3;
        floorMut(): Reference<dvec3>;

        static ceil(a: dvec3): dvec3;
        ceil(): dvec3;
        ceilMut(): Reference<dvec3>;

        static round(a: dvec3): dvec3;
        round(): dvec3;
        roundMut(): Reference<dvec3>;

        static trunc(a: dvec3): dvec3;
        trunc(): dvec3;
        truncMut(): Reference<dvec3>;

        static normalize(a: dvec3): dvec3;
        normalize(): dvec3;
        normalizeMut(): Reference<dvec3>;

        static lerp(a: dvec3, b: dvec3, t: f64): dvec3;
        lerp(other: dvec3, t: f64): dvec3;
        lerpMut(other: dvec3, t: f64): Reference<dvec3>;

        static clamp(a: dvec3, low: dvec3, high: dvec3): dvec3;
        clamp(low: dvec3, high: dvec3): dvec3;
        clampMut(low: dvec3, high: dvec3): Reference<dvec3>;

        static cross(a: dvec3, b: dvec3): dvec3;
        cross(other: dvec3): dvec3;
        crossMut(other: dvec3): Reference<dvec3>;

        static dot(a: dvec3, b: dvec3): f64;
        dot(other: dvec3): f64;

        static lengthSq(a: dvec3): f64;
        lengthSq(): f64;

        static length(a: dvec3): f64;
        length(): f64;

        static distance(a: dvec3, b: dvec3): f64;
        distance(other: dvec3): f64;

        static distanceSq(a: dvec3, b: dvec3): f64;
        distanceSq(other: dvec3): f64;

        static equals(a: dvec3, b: dvec3): boolean;
        equals(other: dvec3): boolean;
    }

    /**
     * `dvec4` — 4 `f64`.
     *
     * Exactly 4 components and no padding — 32 bytes — so an array of
     * them is the layout a vertex buffer wants.
     */
    export class dvec4 {
        private readonly __linalg: "dvec4";

        constructor(x: f64, y: f64, z: f64, w: f64);

        x: f64;
        y: f64;
        z: f64;
        w: f64;

        [index: number]: f64;

        /** Every component zero. */
        static zero(): dvec4;

        /** Every component one. */
        static one(): dvec4;

        /** Every component the same value. */
        static splat(value: f64): dvec4;

        /** The x-axis: 1 in component 0, 0 elsewhere. */
        static unitX(): dvec4;

        /** The y-axis: 1 in component 1, 0 elsewhere. */
        static unitY(): dvec4;

        /** The z-axis: 1 in component 2, 0 elsewhere. */
        static unitZ(): dvec4;

        /** The w-axis: 1 in component 3, 0 elsewhere. */
        static unitW(): dvec4;

        /**
         * Convert from another 4-component vector.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: fvec4): dvec4;

        static add(a: dvec4, b: dvec4): dvec4;
        add(other: dvec4): dvec4;
        addMut(other: dvec4): Reference<dvec4>;

        static sub(a: dvec4, b: dvec4): dvec4;
        sub(other: dvec4): dvec4;
        subMut(other: dvec4): Reference<dvec4>;

        static mul(a: dvec4, b: dvec4): dvec4;
        mul(other: dvec4): dvec4;
        mulMut(other: dvec4): Reference<dvec4>;

        static div(a: dvec4, b: dvec4): dvec4;
        div(other: dvec4): dvec4;
        divMut(other: dvec4): Reference<dvec4>;

        static min(a: dvec4, b: dvec4): dvec4;
        min(other: dvec4): dvec4;
        minMut(other: dvec4): Reference<dvec4>;

        static max(a: dvec4, b: dvec4): dvec4;
        max(other: dvec4): dvec4;
        maxMut(other: dvec4): Reference<dvec4>;

        static scale(a: dvec4, by: f64): dvec4;
        scale(by: f64): dvec4;
        scaleMut(by: f64): Reference<dvec4>;

        static addScaled(a: dvec4, b: dvec4, t: f64): dvec4;
        addScaled(other: dvec4, t: f64): dvec4;
        addScaledMut(other: dvec4, t: f64): Reference<dvec4>;

        static negate(a: dvec4): dvec4;
        negate(): dvec4;
        negateMut(): Reference<dvec4>;

        static abs(a: dvec4): dvec4;
        abs(): dvec4;
        absMut(): Reference<dvec4>;

        static sqrt(a: dvec4): dvec4;
        sqrt(): dvec4;
        sqrtMut(): Reference<dvec4>;

        static floor(a: dvec4): dvec4;
        floor(): dvec4;
        floorMut(): Reference<dvec4>;

        static ceil(a: dvec4): dvec4;
        ceil(): dvec4;
        ceilMut(): Reference<dvec4>;

        static round(a: dvec4): dvec4;
        round(): dvec4;
        roundMut(): Reference<dvec4>;

        static trunc(a: dvec4): dvec4;
        trunc(): dvec4;
        truncMut(): Reference<dvec4>;

        static normalize(a: dvec4): dvec4;
        normalize(): dvec4;
        normalizeMut(): Reference<dvec4>;

        static lerp(a: dvec4, b: dvec4, t: f64): dvec4;
        lerp(other: dvec4, t: f64): dvec4;
        lerpMut(other: dvec4, t: f64): Reference<dvec4>;

        static clamp(a: dvec4, low: dvec4, high: dvec4): dvec4;
        clamp(low: dvec4, high: dvec4): dvec4;
        clampMut(low: dvec4, high: dvec4): Reference<dvec4>;

        static dot(a: dvec4, b: dvec4): f64;
        dot(other: dvec4): f64;

        static lengthSq(a: dvec4): f64;
        lengthSq(): f64;

        static length(a: dvec4): f64;
        length(): f64;

        static distance(a: dvec4, b: dvec4): f64;
        distance(other: dvec4): f64;

        static distanceSq(a: dvec4, b: dvec4): f64;
        distanceSq(other: dvec4): f64;

        static equals(a: dvec4, b: dvec4): boolean;
        equals(other: dvec4): boolean;
    }

    /**
     * `aligned_dvec3` — 3 `f64`, padded to a whole register.
     *
     * Carries a lane of padding, so arithmetic is one instruction rather than a
     * 128-bit operation and a scalar one. 32 bytes against
     * `dvec3`'s 24: faster in a loop, wasteful in a vertex
     * buffer. Pick deliberately.
     */
    export class aligned_dvec3 {
        private readonly __linalg: "aligned_dvec3";

        constructor(x: f64, y: f64, z: f64);

        x: f64;
        y: f64;
        z: f64;

        [index: number]: f64;

        /** Every component zero. */
        static zero(): aligned_dvec3;

        /** Every component one. */
        static one(): aligned_dvec3;

        /** Every component the same value. */
        static splat(value: f64): aligned_dvec3;

        /** The x-axis: 1 in component 0, 0 elsewhere. */
        static unitX(): aligned_dvec3;

        /** The y-axis: 1 in component 1, 0 elsewhere. */
        static unitY(): aligned_dvec3;

        /** The z-axis: 1 in component 2, 0 elsewhere. */
        static unitZ(): aligned_dvec3;

        /**
         * Convert from another 3-component vector.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dvec3): aligned_dvec3;
        static from(value: fvec3): aligned_dvec3;
        static from(value: aligned_fvec3): aligned_dvec3;

        static add(a: aligned_dvec3, b: aligned_dvec3): aligned_dvec3;
        add(other: aligned_dvec3): aligned_dvec3;
        addMut(other: aligned_dvec3): Reference<aligned_dvec3>;

        static sub(a: aligned_dvec3, b: aligned_dvec3): aligned_dvec3;
        sub(other: aligned_dvec3): aligned_dvec3;
        subMut(other: aligned_dvec3): Reference<aligned_dvec3>;

        static mul(a: aligned_dvec3, b: aligned_dvec3): aligned_dvec3;
        mul(other: aligned_dvec3): aligned_dvec3;
        mulMut(other: aligned_dvec3): Reference<aligned_dvec3>;

        static div(a: aligned_dvec3, b: aligned_dvec3): aligned_dvec3;
        div(other: aligned_dvec3): aligned_dvec3;
        divMut(other: aligned_dvec3): Reference<aligned_dvec3>;

        static min(a: aligned_dvec3, b: aligned_dvec3): aligned_dvec3;
        min(other: aligned_dvec3): aligned_dvec3;
        minMut(other: aligned_dvec3): Reference<aligned_dvec3>;

        static max(a: aligned_dvec3, b: aligned_dvec3): aligned_dvec3;
        max(other: aligned_dvec3): aligned_dvec3;
        maxMut(other: aligned_dvec3): Reference<aligned_dvec3>;

        static scale(a: aligned_dvec3, by: f64): aligned_dvec3;
        scale(by: f64): aligned_dvec3;
        scaleMut(by: f64): Reference<aligned_dvec3>;

        static addScaled(a: aligned_dvec3, b: aligned_dvec3, t: f64): aligned_dvec3;
        addScaled(other: aligned_dvec3, t: f64): aligned_dvec3;
        addScaledMut(other: aligned_dvec3, t: f64): Reference<aligned_dvec3>;

        static negate(a: aligned_dvec3): aligned_dvec3;
        negate(): aligned_dvec3;
        negateMut(): Reference<aligned_dvec3>;

        static abs(a: aligned_dvec3): aligned_dvec3;
        abs(): aligned_dvec3;
        absMut(): Reference<aligned_dvec3>;

        static sqrt(a: aligned_dvec3): aligned_dvec3;
        sqrt(): aligned_dvec3;
        sqrtMut(): Reference<aligned_dvec3>;

        static floor(a: aligned_dvec3): aligned_dvec3;
        floor(): aligned_dvec3;
        floorMut(): Reference<aligned_dvec3>;

        static ceil(a: aligned_dvec3): aligned_dvec3;
        ceil(): aligned_dvec3;
        ceilMut(): Reference<aligned_dvec3>;

        static round(a: aligned_dvec3): aligned_dvec3;
        round(): aligned_dvec3;
        roundMut(): Reference<aligned_dvec3>;

        static trunc(a: aligned_dvec3): aligned_dvec3;
        trunc(): aligned_dvec3;
        truncMut(): Reference<aligned_dvec3>;

        static normalize(a: aligned_dvec3): aligned_dvec3;
        normalize(): aligned_dvec3;
        normalizeMut(): Reference<aligned_dvec3>;

        static lerp(a: aligned_dvec3, b: aligned_dvec3, t: f64): aligned_dvec3;
        lerp(other: aligned_dvec3, t: f64): aligned_dvec3;
        lerpMut(other: aligned_dvec3, t: f64): Reference<aligned_dvec3>;

        static clamp(a: aligned_dvec3, low: aligned_dvec3, high: aligned_dvec3): aligned_dvec3;
        clamp(low: aligned_dvec3, high: aligned_dvec3): aligned_dvec3;
        clampMut(low: aligned_dvec3, high: aligned_dvec3): Reference<aligned_dvec3>;

        static cross(a: aligned_dvec3, b: aligned_dvec3): aligned_dvec3;
        cross(other: aligned_dvec3): aligned_dvec3;
        crossMut(other: aligned_dvec3): Reference<aligned_dvec3>;

        static dot(a: aligned_dvec3, b: aligned_dvec3): f64;
        dot(other: aligned_dvec3): f64;

        static lengthSq(a: aligned_dvec3): f64;
        lengthSq(): f64;

        static length(a: aligned_dvec3): f64;
        length(): f64;

        static distance(a: aligned_dvec3, b: aligned_dvec3): f64;
        distance(other: aligned_dvec3): f64;

        static distanceSq(a: aligned_dvec3, b: aligned_dvec3): f64;
        distanceSq(other: aligned_dvec3): f64;

        static equals(a: aligned_dvec3, b: aligned_dvec3): boolean;
        equals(other: aligned_dvec3): boolean;
    }

    /**
     * `dmat2` — a 2x2 matrix: 2 `dvec2` columns.
     *
     * **Column-major, with column vectors.** `m.c0` is the first column and
     * `a.mul(b)` applies `b` first, which is GLM's convention and therefore what
     * every shader and every piece of reference code assumes.
     *
     * 32 bytes, packed — the layout a graphics API expects.
     */
    export class dmat2 {
        private readonly __linalg: "dmat2";

        constructor(c0: dvec2, c1: dvec2);

        c0: dvec2;
        c1: dvec2;

        [index: number]: dvec2;

        /** Every entry zero. */
        static zero(): dmat2;

        /** Ones on the diagonal, zero elsewhere. */
        static identity(): dmat2;

        /**
         * Convert from another 2x2 matrix.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: fmat2): dmat2;

        /** Built from its columns, left to right. */
        static fromColumns(c0: dvec2, c1: dvec2): dmat2;

        /** A counter-clockwise rotation by `angle` radians. */
        static fromRotation(angle: f64): dmat2;

        static add(a: dmat2, b: dmat2): dmat2;
        add(other: dmat2): dmat2;
        addMut(other: dmat2): Reference<dmat2>;

        static sub(a: dmat2, b: dmat2): dmat2;
        sub(other: dmat2): dmat2;
        subMut(other: dmat2): Reference<dmat2>;

        static scale(a: dmat2, by: f64): dmat2;
        scale(by: f64): dmat2;
        scaleMut(by: f64): Reference<dmat2>;

        static negate(a: dmat2): dmat2;
        negate(): dmat2;
        negateMut(): Reference<dmat2>;

        static mul(a: dmat2, b: dmat2): dmat2;
        mul(other: dmat2): dmat2;
        mulMut(other: dmat2): Reference<dmat2>;

        static mulVec(a: dmat2, v: dvec2): dvec2;
        mulVec(v: dvec2): dvec2;

        static transpose(a: dmat2): dmat2;
        transpose(): dmat2;
        transposeMut(): Reference<dmat2>;

        static inverse(a: dmat2): dmat2;
        inverse(): dmat2;
        inverseMut(): Reference<dmat2>;

        static determinant(a: dmat2): f64;
        determinant(): f64;

        static equals(a: dmat2, b: dmat2): boolean;
        equals(other: dmat2): boolean;
    }

    /**
     * `dmat3` — a 3x3 matrix: 3 `dvec3` columns.
     *
     * **Column-major, with column vectors.** `m.c0` is the first column and
     * `a.mul(b)` applies `b` first, which is GLM's convention and therefore what
     * every shader and every piece of reference code assumes.
     *
     * 72 bytes, packed — the layout a graphics API expects.
     * `aligned_dmat3` is the same maths with padded columns, and faster.
     */
    export class dmat3 {
        private readonly __linalg: "dmat3";

        constructor(c0: dvec3, c1: dvec3, c2: dvec3);

        c0: dvec3;
        c1: dvec3;
        c2: dvec3;

        [index: number]: dvec3;

        /** Every entry zero. */
        static zero(): dmat3;

        /** Ones on the diagonal, zero elsewhere. */
        static identity(): dmat3;

        /**
         * Convert from another 3x3 matrix.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: aligned_dmat3): dmat3;
        static from(value: fmat3): dmat3;
        static from(value: aligned_fmat3): dmat3;

        /** Built from its columns, left to right. */
        static fromColumns(c0: dvec3, c1: dvec3, c2: dvec3): dmat3;

        /** A scale along each axis. */
        static fromScale(scale: dvec3): dmat3;

        /** A right-handed rotation about the x-axis, in radians. */
        static fromRotationX(angle: f64): dmat3;

        /** A right-handed rotation about the y-axis, in radians. */
        static fromRotationY(angle: f64): dmat3;

        /** A right-handed rotation about the z-axis, in radians. */
        static fromRotationZ(angle: f64): dmat3;

        /** A right-handed rotation about an arbitrary axis. The axis is normalised first. */
        static fromAxisAngle(axis: dvec3, angle: f64): dmat3;

        static add(a: dmat3, b: dmat3): dmat3;
        add(other: dmat3): dmat3;
        addMut(other: dmat3): Reference<dmat3>;

        static sub(a: dmat3, b: dmat3): dmat3;
        sub(other: dmat3): dmat3;
        subMut(other: dmat3): Reference<dmat3>;

        static scale(a: dmat3, by: f64): dmat3;
        scale(by: f64): dmat3;
        scaleMut(by: f64): Reference<dmat3>;

        static negate(a: dmat3): dmat3;
        negate(): dmat3;
        negateMut(): Reference<dmat3>;

        static mul(a: dmat3, b: dmat3): dmat3;
        mul(other: dmat3): dmat3;
        mulMut(other: dmat3): Reference<dmat3>;

        static mulVec(a: dmat3, v: dvec3): dvec3;
        mulVec(v: dvec3): dvec3;

        static transpose(a: dmat3): dmat3;
        transpose(): dmat3;
        transposeMut(): Reference<dmat3>;

        static inverse(a: dmat3): dmat3;
        inverse(): dmat3;
        inverseMut(): Reference<dmat3>;

        static determinant(a: dmat3): f64;
        determinant(): f64;

        static equals(a: dmat3, b: dmat3): boolean;
        equals(other: dmat3): boolean;
    }

    /**
     * `dmat4` — a 4x4 matrix: 4 `dvec4` columns.
     *
     * **Column-major, with column vectors.** `m.c0` is the first column and
     * `a.mul(b)` applies `b` first, which is GLM's convention and therefore what
     * every shader and every piece of reference code assumes.
     *
     * 128 bytes, packed — the layout a graphics API expects.
     */
    export class dmat4 {
        private readonly __linalg: "dmat4";

        constructor(c0: dvec4, c1: dvec4, c2: dvec4, c3: dvec4);

        c0: dvec4;
        c1: dvec4;
        c2: dvec4;
        c3: dvec4;

        [index: number]: dvec4;

        /** Every entry zero. */
        static zero(): dmat4;

        /** Ones on the diagonal, zero elsewhere. */
        static identity(): dmat4;

        /**
         * Convert from another 4x4 matrix.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: fmat4): dmat4;

        /** Built from its columns, left to right. */
        static fromColumns(c0: dvec4, c1: dvec4, c2: dvec4, c3: dvec4): dmat4;

        /** A scale along each axis. */
        static fromScale(scale: dvec3): dmat4;

        /** A right-handed rotation about the x-axis, in radians. */
        static fromRotationX(angle: f64): dmat4;

        /** A right-handed rotation about the y-axis, in radians. */
        static fromRotationY(angle: f64): dmat4;

        /** A right-handed rotation about the z-axis, in radians. */
        static fromRotationZ(angle: f64): dmat4;

        /** A right-handed rotation about an arbitrary axis. The axis is normalised first. */
        static fromAxisAngle(axis: dvec3, angle: f64): dmat4;

        /** An affine translation. */
        static fromTranslation(offset: dvec3): dmat4;

        /** A right-handed view matrix looking from `eye` towards `center`. */
        static lookAt(eye: dvec3, center: dvec3, up: dvec3): dmat4;

        /** A right-handed perspective projection: vertical field of view in radians, aspect ratio, near and far. Depth maps to `[0, 1]` and `+Y` stays up. */
        static perspective(fovY: f64, aspect: f64, near: f64, far: f64): dmat4;

        /** A right-handed orthographic projection from `left`, `right`, `bottom`, `top`, `near`, `far`. Depth maps to `[0, 1]` and `+Y` stays up. */
        static ortho(left: f64, right: f64, bottom: f64, top: f64, near: f64, far: f64): dmat4;

        static add(a: dmat4, b: dmat4): dmat4;
        add(other: dmat4): dmat4;
        addMut(other: dmat4): Reference<dmat4>;

        static sub(a: dmat4, b: dmat4): dmat4;
        sub(other: dmat4): dmat4;
        subMut(other: dmat4): Reference<dmat4>;

        static scale(a: dmat4, by: f64): dmat4;
        scale(by: f64): dmat4;
        scaleMut(by: f64): Reference<dmat4>;

        static negate(a: dmat4): dmat4;
        negate(): dmat4;
        negateMut(): Reference<dmat4>;

        static mul(a: dmat4, b: dmat4): dmat4;
        mul(other: dmat4): dmat4;
        mulMut(other: dmat4): Reference<dmat4>;

        static mulVec(a: dmat4, v: dvec4): dvec4;
        mulVec(v: dvec4): dvec4;

        static transpose(a: dmat4): dmat4;
        transpose(): dmat4;
        transposeMut(): Reference<dmat4>;

        static inverse(a: dmat4): dmat4;
        inverse(): dmat4;
        inverseMut(): Reference<dmat4>;

        static determinant(a: dmat4): f64;
        determinant(): f64;

        static equals(a: dmat4, b: dmat4): boolean;
        equals(other: dmat4): boolean;
    }

    /**
     * `aligned_dmat3` — a 3x3 matrix: 3 `aligned_dvec3` columns.
     *
     * **Column-major, with column vectors.** `m.c0` is the first column and
     * `a.mul(b)` applies `b` first, which is GLM's convention and therefore what
     * every shader and every piece of reference code assumes.
     *
     * Each column carries a lane of padding: 96 bytes against `dmat3`'s
     * 72, and every column operation is one instruction rather than two.
     */
    export class aligned_dmat3 {
        private readonly __linalg: "aligned_dmat3";

        constructor(c0: aligned_dvec3, c1: aligned_dvec3, c2: aligned_dvec3);

        c0: aligned_dvec3;
        c1: aligned_dvec3;
        c2: aligned_dvec3;

        [index: number]: aligned_dvec3;

        /** Every entry zero. */
        static zero(): aligned_dmat3;

        /** Ones on the diagonal, zero elsewhere. */
        static identity(): aligned_dmat3;

        /**
         * Convert from another 3x3 matrix.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dmat3): aligned_dmat3;
        static from(value: fmat3): aligned_dmat3;
        static from(value: aligned_fmat3): aligned_dmat3;

        /** Built from its columns, left to right. */
        static fromColumns(c0: aligned_dvec3, c1: aligned_dvec3, c2: aligned_dvec3): aligned_dmat3;

        /** A scale along each axis. */
        static fromScale(scale: dvec3): aligned_dmat3;

        /** A right-handed rotation about the x-axis, in radians. */
        static fromRotationX(angle: f64): aligned_dmat3;

        /** A right-handed rotation about the y-axis, in radians. */
        static fromRotationY(angle: f64): aligned_dmat3;

        /** A right-handed rotation about the z-axis, in radians. */
        static fromRotationZ(angle: f64): aligned_dmat3;

        /** A right-handed rotation about an arbitrary axis. The axis is normalised first. */
        static fromAxisAngle(axis: dvec3, angle: f64): aligned_dmat3;

        static add(a: aligned_dmat3, b: aligned_dmat3): aligned_dmat3;
        add(other: aligned_dmat3): aligned_dmat3;
        addMut(other: aligned_dmat3): Reference<aligned_dmat3>;

        static sub(a: aligned_dmat3, b: aligned_dmat3): aligned_dmat3;
        sub(other: aligned_dmat3): aligned_dmat3;
        subMut(other: aligned_dmat3): Reference<aligned_dmat3>;

        static scale(a: aligned_dmat3, by: f64): aligned_dmat3;
        scale(by: f64): aligned_dmat3;
        scaleMut(by: f64): Reference<aligned_dmat3>;

        static negate(a: aligned_dmat3): aligned_dmat3;
        negate(): aligned_dmat3;
        negateMut(): Reference<aligned_dmat3>;

        static mul(a: aligned_dmat3, b: aligned_dmat3): aligned_dmat3;
        mul(other: aligned_dmat3): aligned_dmat3;
        mulMut(other: aligned_dmat3): Reference<aligned_dmat3>;

        static mulVec(a: aligned_dmat3, v: aligned_dvec3): aligned_dvec3;
        mulVec(v: aligned_dvec3): aligned_dvec3;

        static transpose(a: aligned_dmat3): aligned_dmat3;
        transpose(): aligned_dmat3;
        transposeMut(): Reference<aligned_dmat3>;

        static inverse(a: aligned_dmat3): aligned_dmat3;
        inverse(): aligned_dmat3;
        inverseMut(): Reference<aligned_dmat3>;

        static determinant(a: aligned_dmat3): f64;
        determinant(): f64;

        static equals(a: aligned_dmat3, b: aligned_dmat3): boolean;
        equals(other: aligned_dmat3): boolean;
    }

    /**
     * `fvec2` — 2 `f32`.
     *
     * Exactly 2 components and no padding — 8 bytes — so an array of
     * them is the layout a vertex buffer wants.
     */
    export class fvec2 {
        private readonly __linalg: "fvec2";

        constructor(x: f32, y: f32);

        x: f32;
        y: f32;

        [index: number]: f32;

        /** Every component zero. */
        static zero(): fvec2;

        /** Every component one. */
        static one(): fvec2;

        /** Every component the same value. */
        static splat(value: f32): fvec2;

        /** The x-axis: 1 in component 0, 0 elsewhere. */
        static unitX(): fvec2;

        /** The y-axis: 1 in component 1, 0 elsewhere. */
        static unitY(): fvec2;

        /**
         * Convert from another 2-component vector.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dvec2): fvec2;

        static add(a: fvec2, b: fvec2): fvec2;
        add(other: fvec2): fvec2;
        addMut(other: fvec2): Reference<fvec2>;

        static sub(a: fvec2, b: fvec2): fvec2;
        sub(other: fvec2): fvec2;
        subMut(other: fvec2): Reference<fvec2>;

        static mul(a: fvec2, b: fvec2): fvec2;
        mul(other: fvec2): fvec2;
        mulMut(other: fvec2): Reference<fvec2>;

        static div(a: fvec2, b: fvec2): fvec2;
        div(other: fvec2): fvec2;
        divMut(other: fvec2): Reference<fvec2>;

        static min(a: fvec2, b: fvec2): fvec2;
        min(other: fvec2): fvec2;
        minMut(other: fvec2): Reference<fvec2>;

        static max(a: fvec2, b: fvec2): fvec2;
        max(other: fvec2): fvec2;
        maxMut(other: fvec2): Reference<fvec2>;

        static scale(a: fvec2, by: f32): fvec2;
        scale(by: f32): fvec2;
        scaleMut(by: f32): Reference<fvec2>;

        static addScaled(a: fvec2, b: fvec2, t: f32): fvec2;
        addScaled(other: fvec2, t: f32): fvec2;
        addScaledMut(other: fvec2, t: f32): Reference<fvec2>;

        static negate(a: fvec2): fvec2;
        negate(): fvec2;
        negateMut(): Reference<fvec2>;

        static abs(a: fvec2): fvec2;
        abs(): fvec2;
        absMut(): Reference<fvec2>;

        static sqrt(a: fvec2): fvec2;
        sqrt(): fvec2;
        sqrtMut(): Reference<fvec2>;

        static floor(a: fvec2): fvec2;
        floor(): fvec2;
        floorMut(): Reference<fvec2>;

        static ceil(a: fvec2): fvec2;
        ceil(): fvec2;
        ceilMut(): Reference<fvec2>;

        static round(a: fvec2): fvec2;
        round(): fvec2;
        roundMut(): Reference<fvec2>;

        static trunc(a: fvec2): fvec2;
        trunc(): fvec2;
        truncMut(): Reference<fvec2>;

        static normalize(a: fvec2): fvec2;
        normalize(): fvec2;
        normalizeMut(): Reference<fvec2>;

        static lerp(a: fvec2, b: fvec2, t: f32): fvec2;
        lerp(other: fvec2, t: f32): fvec2;
        lerpMut(other: fvec2, t: f32): Reference<fvec2>;

        static clamp(a: fvec2, low: fvec2, high: fvec2): fvec2;
        clamp(low: fvec2, high: fvec2): fvec2;
        clampMut(low: fvec2, high: fvec2): Reference<fvec2>;

        static dot(a: fvec2, b: fvec2): f32;
        dot(other: fvec2): f32;

        static lengthSq(a: fvec2): f32;
        lengthSq(): f32;

        static length(a: fvec2): f32;
        length(): f32;

        static distance(a: fvec2, b: fvec2): f32;
        distance(other: fvec2): f32;

        static distanceSq(a: fvec2, b: fvec2): f32;
        distanceSq(other: fvec2): f32;

        static equals(a: fvec2, b: fvec2): boolean;
        equals(other: fvec2): boolean;
    }

    /**
     * `fvec3` — 3 `f32`.
     *
     * Exactly 3 components and no padding — 12 bytes — so an array of
     * them is the layout a vertex buffer wants.
     * `aligned_fvec3` is the same maths with a lane of padding, and faster.
     */
    export class fvec3 {
        private readonly __linalg: "fvec3";

        constructor(x: f32, y: f32, z: f32);

        x: f32;
        y: f32;
        z: f32;

        [index: number]: f32;

        /** Every component zero. */
        static zero(): fvec3;

        /** Every component one. */
        static one(): fvec3;

        /** Every component the same value. */
        static splat(value: f32): fvec3;

        /** The x-axis: 1 in component 0, 0 elsewhere. */
        static unitX(): fvec3;

        /** The y-axis: 1 in component 1, 0 elsewhere. */
        static unitY(): fvec3;

        /** The z-axis: 1 in component 2, 0 elsewhere. */
        static unitZ(): fvec3;

        /**
         * Convert from another 3-component vector.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dvec3): fvec3;
        static from(value: aligned_dvec3): fvec3;
        static from(value: aligned_fvec3): fvec3;

        static add(a: fvec3, b: fvec3): fvec3;
        add(other: fvec3): fvec3;
        addMut(other: fvec3): Reference<fvec3>;

        static sub(a: fvec3, b: fvec3): fvec3;
        sub(other: fvec3): fvec3;
        subMut(other: fvec3): Reference<fvec3>;

        static mul(a: fvec3, b: fvec3): fvec3;
        mul(other: fvec3): fvec3;
        mulMut(other: fvec3): Reference<fvec3>;

        static div(a: fvec3, b: fvec3): fvec3;
        div(other: fvec3): fvec3;
        divMut(other: fvec3): Reference<fvec3>;

        static min(a: fvec3, b: fvec3): fvec3;
        min(other: fvec3): fvec3;
        minMut(other: fvec3): Reference<fvec3>;

        static max(a: fvec3, b: fvec3): fvec3;
        max(other: fvec3): fvec3;
        maxMut(other: fvec3): Reference<fvec3>;

        static scale(a: fvec3, by: f32): fvec3;
        scale(by: f32): fvec3;
        scaleMut(by: f32): Reference<fvec3>;

        static addScaled(a: fvec3, b: fvec3, t: f32): fvec3;
        addScaled(other: fvec3, t: f32): fvec3;
        addScaledMut(other: fvec3, t: f32): Reference<fvec3>;

        static negate(a: fvec3): fvec3;
        negate(): fvec3;
        negateMut(): Reference<fvec3>;

        static abs(a: fvec3): fvec3;
        abs(): fvec3;
        absMut(): Reference<fvec3>;

        static sqrt(a: fvec3): fvec3;
        sqrt(): fvec3;
        sqrtMut(): Reference<fvec3>;

        static floor(a: fvec3): fvec3;
        floor(): fvec3;
        floorMut(): Reference<fvec3>;

        static ceil(a: fvec3): fvec3;
        ceil(): fvec3;
        ceilMut(): Reference<fvec3>;

        static round(a: fvec3): fvec3;
        round(): fvec3;
        roundMut(): Reference<fvec3>;

        static trunc(a: fvec3): fvec3;
        trunc(): fvec3;
        truncMut(): Reference<fvec3>;

        static normalize(a: fvec3): fvec3;
        normalize(): fvec3;
        normalizeMut(): Reference<fvec3>;

        static lerp(a: fvec3, b: fvec3, t: f32): fvec3;
        lerp(other: fvec3, t: f32): fvec3;
        lerpMut(other: fvec3, t: f32): Reference<fvec3>;

        static clamp(a: fvec3, low: fvec3, high: fvec3): fvec3;
        clamp(low: fvec3, high: fvec3): fvec3;
        clampMut(low: fvec3, high: fvec3): Reference<fvec3>;

        static cross(a: fvec3, b: fvec3): fvec3;
        cross(other: fvec3): fvec3;
        crossMut(other: fvec3): Reference<fvec3>;

        static dot(a: fvec3, b: fvec3): f32;
        dot(other: fvec3): f32;

        static lengthSq(a: fvec3): f32;
        lengthSq(): f32;

        static length(a: fvec3): f32;
        length(): f32;

        static distance(a: fvec3, b: fvec3): f32;
        distance(other: fvec3): f32;

        static distanceSq(a: fvec3, b: fvec3): f32;
        distanceSq(other: fvec3): f32;

        static equals(a: fvec3, b: fvec3): boolean;
        equals(other: fvec3): boolean;
    }

    /**
     * `fvec4` — 4 `f32`.
     *
     * Exactly 4 components and no padding — 16 bytes — so an array of
     * them is the layout a vertex buffer wants.
     */
    export class fvec4 {
        private readonly __linalg: "fvec4";

        constructor(x: f32, y: f32, z: f32, w: f32);

        x: f32;
        y: f32;
        z: f32;
        w: f32;

        [index: number]: f32;

        /** Every component zero. */
        static zero(): fvec4;

        /** Every component one. */
        static one(): fvec4;

        /** Every component the same value. */
        static splat(value: f32): fvec4;

        /** The x-axis: 1 in component 0, 0 elsewhere. */
        static unitX(): fvec4;

        /** The y-axis: 1 in component 1, 0 elsewhere. */
        static unitY(): fvec4;

        /** The z-axis: 1 in component 2, 0 elsewhere. */
        static unitZ(): fvec4;

        /** The w-axis: 1 in component 3, 0 elsewhere. */
        static unitW(): fvec4;

        /**
         * Convert from another 4-component vector.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dvec4): fvec4;

        static add(a: fvec4, b: fvec4): fvec4;
        add(other: fvec4): fvec4;
        addMut(other: fvec4): Reference<fvec4>;

        static sub(a: fvec4, b: fvec4): fvec4;
        sub(other: fvec4): fvec4;
        subMut(other: fvec4): Reference<fvec4>;

        static mul(a: fvec4, b: fvec4): fvec4;
        mul(other: fvec4): fvec4;
        mulMut(other: fvec4): Reference<fvec4>;

        static div(a: fvec4, b: fvec4): fvec4;
        div(other: fvec4): fvec4;
        divMut(other: fvec4): Reference<fvec4>;

        static min(a: fvec4, b: fvec4): fvec4;
        min(other: fvec4): fvec4;
        minMut(other: fvec4): Reference<fvec4>;

        static max(a: fvec4, b: fvec4): fvec4;
        max(other: fvec4): fvec4;
        maxMut(other: fvec4): Reference<fvec4>;

        static scale(a: fvec4, by: f32): fvec4;
        scale(by: f32): fvec4;
        scaleMut(by: f32): Reference<fvec4>;

        static addScaled(a: fvec4, b: fvec4, t: f32): fvec4;
        addScaled(other: fvec4, t: f32): fvec4;
        addScaledMut(other: fvec4, t: f32): Reference<fvec4>;

        static negate(a: fvec4): fvec4;
        negate(): fvec4;
        negateMut(): Reference<fvec4>;

        static abs(a: fvec4): fvec4;
        abs(): fvec4;
        absMut(): Reference<fvec4>;

        static sqrt(a: fvec4): fvec4;
        sqrt(): fvec4;
        sqrtMut(): Reference<fvec4>;

        static floor(a: fvec4): fvec4;
        floor(): fvec4;
        floorMut(): Reference<fvec4>;

        static ceil(a: fvec4): fvec4;
        ceil(): fvec4;
        ceilMut(): Reference<fvec4>;

        static round(a: fvec4): fvec4;
        round(): fvec4;
        roundMut(): Reference<fvec4>;

        static trunc(a: fvec4): fvec4;
        trunc(): fvec4;
        truncMut(): Reference<fvec4>;

        static normalize(a: fvec4): fvec4;
        normalize(): fvec4;
        normalizeMut(): Reference<fvec4>;

        static lerp(a: fvec4, b: fvec4, t: f32): fvec4;
        lerp(other: fvec4, t: f32): fvec4;
        lerpMut(other: fvec4, t: f32): Reference<fvec4>;

        static clamp(a: fvec4, low: fvec4, high: fvec4): fvec4;
        clamp(low: fvec4, high: fvec4): fvec4;
        clampMut(low: fvec4, high: fvec4): Reference<fvec4>;

        static dot(a: fvec4, b: fvec4): f32;
        dot(other: fvec4): f32;

        static lengthSq(a: fvec4): f32;
        lengthSq(): f32;

        static length(a: fvec4): f32;
        length(): f32;

        static distance(a: fvec4, b: fvec4): f32;
        distance(other: fvec4): f32;

        static distanceSq(a: fvec4, b: fvec4): f32;
        distanceSq(other: fvec4): f32;

        static equals(a: fvec4, b: fvec4): boolean;
        equals(other: fvec4): boolean;
    }

    /**
     * `aligned_fvec3` — 3 `f32`, padded to a whole register.
     *
     * Carries a lane of padding, so arithmetic is one instruction rather than a
     * 128-bit operation and a scalar one. 16 bytes against
     * `fvec3`'s 12: faster in a loop, wasteful in a vertex
     * buffer. Pick deliberately.
     */
    export class aligned_fvec3 {
        private readonly __linalg: "aligned_fvec3";

        constructor(x: f32, y: f32, z: f32);

        x: f32;
        y: f32;
        z: f32;

        [index: number]: f32;

        /** Every component zero. */
        static zero(): aligned_fvec3;

        /** Every component one. */
        static one(): aligned_fvec3;

        /** Every component the same value. */
        static splat(value: f32): aligned_fvec3;

        /** The x-axis: 1 in component 0, 0 elsewhere. */
        static unitX(): aligned_fvec3;

        /** The y-axis: 1 in component 1, 0 elsewhere. */
        static unitY(): aligned_fvec3;

        /** The z-axis: 1 in component 2, 0 elsewhere. */
        static unitZ(): aligned_fvec3;

        /**
         * Convert from another 3-component vector.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dvec3): aligned_fvec3;
        static from(value: aligned_dvec3): aligned_fvec3;
        static from(value: fvec3): aligned_fvec3;

        static add(a: aligned_fvec3, b: aligned_fvec3): aligned_fvec3;
        add(other: aligned_fvec3): aligned_fvec3;
        addMut(other: aligned_fvec3): Reference<aligned_fvec3>;

        static sub(a: aligned_fvec3, b: aligned_fvec3): aligned_fvec3;
        sub(other: aligned_fvec3): aligned_fvec3;
        subMut(other: aligned_fvec3): Reference<aligned_fvec3>;

        static mul(a: aligned_fvec3, b: aligned_fvec3): aligned_fvec3;
        mul(other: aligned_fvec3): aligned_fvec3;
        mulMut(other: aligned_fvec3): Reference<aligned_fvec3>;

        static div(a: aligned_fvec3, b: aligned_fvec3): aligned_fvec3;
        div(other: aligned_fvec3): aligned_fvec3;
        divMut(other: aligned_fvec3): Reference<aligned_fvec3>;

        static min(a: aligned_fvec3, b: aligned_fvec3): aligned_fvec3;
        min(other: aligned_fvec3): aligned_fvec3;
        minMut(other: aligned_fvec3): Reference<aligned_fvec3>;

        static max(a: aligned_fvec3, b: aligned_fvec3): aligned_fvec3;
        max(other: aligned_fvec3): aligned_fvec3;
        maxMut(other: aligned_fvec3): Reference<aligned_fvec3>;

        static scale(a: aligned_fvec3, by: f32): aligned_fvec3;
        scale(by: f32): aligned_fvec3;
        scaleMut(by: f32): Reference<aligned_fvec3>;

        static addScaled(a: aligned_fvec3, b: aligned_fvec3, t: f32): aligned_fvec3;
        addScaled(other: aligned_fvec3, t: f32): aligned_fvec3;
        addScaledMut(other: aligned_fvec3, t: f32): Reference<aligned_fvec3>;

        static negate(a: aligned_fvec3): aligned_fvec3;
        negate(): aligned_fvec3;
        negateMut(): Reference<aligned_fvec3>;

        static abs(a: aligned_fvec3): aligned_fvec3;
        abs(): aligned_fvec3;
        absMut(): Reference<aligned_fvec3>;

        static sqrt(a: aligned_fvec3): aligned_fvec3;
        sqrt(): aligned_fvec3;
        sqrtMut(): Reference<aligned_fvec3>;

        static floor(a: aligned_fvec3): aligned_fvec3;
        floor(): aligned_fvec3;
        floorMut(): Reference<aligned_fvec3>;

        static ceil(a: aligned_fvec3): aligned_fvec3;
        ceil(): aligned_fvec3;
        ceilMut(): Reference<aligned_fvec3>;

        static round(a: aligned_fvec3): aligned_fvec3;
        round(): aligned_fvec3;
        roundMut(): Reference<aligned_fvec3>;

        static trunc(a: aligned_fvec3): aligned_fvec3;
        trunc(): aligned_fvec3;
        truncMut(): Reference<aligned_fvec3>;

        static normalize(a: aligned_fvec3): aligned_fvec3;
        normalize(): aligned_fvec3;
        normalizeMut(): Reference<aligned_fvec3>;

        static lerp(a: aligned_fvec3, b: aligned_fvec3, t: f32): aligned_fvec3;
        lerp(other: aligned_fvec3, t: f32): aligned_fvec3;
        lerpMut(other: aligned_fvec3, t: f32): Reference<aligned_fvec3>;

        static clamp(a: aligned_fvec3, low: aligned_fvec3, high: aligned_fvec3): aligned_fvec3;
        clamp(low: aligned_fvec3, high: aligned_fvec3): aligned_fvec3;
        clampMut(low: aligned_fvec3, high: aligned_fvec3): Reference<aligned_fvec3>;

        static cross(a: aligned_fvec3, b: aligned_fvec3): aligned_fvec3;
        cross(other: aligned_fvec3): aligned_fvec3;
        crossMut(other: aligned_fvec3): Reference<aligned_fvec3>;

        static dot(a: aligned_fvec3, b: aligned_fvec3): f32;
        dot(other: aligned_fvec3): f32;

        static lengthSq(a: aligned_fvec3): f32;
        lengthSq(): f32;

        static length(a: aligned_fvec3): f32;
        length(): f32;

        static distance(a: aligned_fvec3, b: aligned_fvec3): f32;
        distance(other: aligned_fvec3): f32;

        static distanceSq(a: aligned_fvec3, b: aligned_fvec3): f32;
        distanceSq(other: aligned_fvec3): f32;

        static equals(a: aligned_fvec3, b: aligned_fvec3): boolean;
        equals(other: aligned_fvec3): boolean;
    }

    /**
     * `fmat2` — a 2x2 matrix: 2 `fvec2` columns.
     *
     * **Column-major, with column vectors.** `m.c0` is the first column and
     * `a.mul(b)` applies `b` first, which is GLM's convention and therefore what
     * every shader and every piece of reference code assumes.
     *
     * 16 bytes, packed — the layout a graphics API expects.
     */
    export class fmat2 {
        private readonly __linalg: "fmat2";

        constructor(c0: fvec2, c1: fvec2);

        c0: fvec2;
        c1: fvec2;

        [index: number]: fvec2;

        /** Every entry zero. */
        static zero(): fmat2;

        /** Ones on the diagonal, zero elsewhere. */
        static identity(): fmat2;

        /**
         * Convert from another 2x2 matrix.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dmat2): fmat2;

        /** Built from its columns, left to right. */
        static fromColumns(c0: fvec2, c1: fvec2): fmat2;

        /** A counter-clockwise rotation by `angle` radians. */
        static fromRotation(angle: f32): fmat2;

        static add(a: fmat2, b: fmat2): fmat2;
        add(other: fmat2): fmat2;
        addMut(other: fmat2): Reference<fmat2>;

        static sub(a: fmat2, b: fmat2): fmat2;
        sub(other: fmat2): fmat2;
        subMut(other: fmat2): Reference<fmat2>;

        static scale(a: fmat2, by: f32): fmat2;
        scale(by: f32): fmat2;
        scaleMut(by: f32): Reference<fmat2>;

        static negate(a: fmat2): fmat2;
        negate(): fmat2;
        negateMut(): Reference<fmat2>;

        static mul(a: fmat2, b: fmat2): fmat2;
        mul(other: fmat2): fmat2;
        mulMut(other: fmat2): Reference<fmat2>;

        static mulVec(a: fmat2, v: fvec2): fvec2;
        mulVec(v: fvec2): fvec2;

        static transpose(a: fmat2): fmat2;
        transpose(): fmat2;
        transposeMut(): Reference<fmat2>;

        static inverse(a: fmat2): fmat2;
        inverse(): fmat2;
        inverseMut(): Reference<fmat2>;

        static determinant(a: fmat2): f32;
        determinant(): f32;

        static equals(a: fmat2, b: fmat2): boolean;
        equals(other: fmat2): boolean;
    }

    /**
     * `fmat3` — a 3x3 matrix: 3 `fvec3` columns.
     *
     * **Column-major, with column vectors.** `m.c0` is the first column and
     * `a.mul(b)` applies `b` first, which is GLM's convention and therefore what
     * every shader and every piece of reference code assumes.
     *
     * 36 bytes, packed — the layout a graphics API expects.
     * `aligned_fmat3` is the same maths with padded columns, and faster.
     */
    export class fmat3 {
        private readonly __linalg: "fmat3";

        constructor(c0: fvec3, c1: fvec3, c2: fvec3);

        c0: fvec3;
        c1: fvec3;
        c2: fvec3;

        [index: number]: fvec3;

        /** Every entry zero. */
        static zero(): fmat3;

        /** Ones on the diagonal, zero elsewhere. */
        static identity(): fmat3;

        /**
         * Convert from another 3x3 matrix.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dmat3): fmat3;
        static from(value: aligned_dmat3): fmat3;
        static from(value: aligned_fmat3): fmat3;

        /** Built from its columns, left to right. */
        static fromColumns(c0: fvec3, c1: fvec3, c2: fvec3): fmat3;

        /** A scale along each axis. */
        static fromScale(scale: fvec3): fmat3;

        /** A right-handed rotation about the x-axis, in radians. */
        static fromRotationX(angle: f32): fmat3;

        /** A right-handed rotation about the y-axis, in radians. */
        static fromRotationY(angle: f32): fmat3;

        /** A right-handed rotation about the z-axis, in radians. */
        static fromRotationZ(angle: f32): fmat3;

        /** A right-handed rotation about an arbitrary axis. The axis is normalised first. */
        static fromAxisAngle(axis: fvec3, angle: f32): fmat3;

        static add(a: fmat3, b: fmat3): fmat3;
        add(other: fmat3): fmat3;
        addMut(other: fmat3): Reference<fmat3>;

        static sub(a: fmat3, b: fmat3): fmat3;
        sub(other: fmat3): fmat3;
        subMut(other: fmat3): Reference<fmat3>;

        static scale(a: fmat3, by: f32): fmat3;
        scale(by: f32): fmat3;
        scaleMut(by: f32): Reference<fmat3>;

        static negate(a: fmat3): fmat3;
        negate(): fmat3;
        negateMut(): Reference<fmat3>;

        static mul(a: fmat3, b: fmat3): fmat3;
        mul(other: fmat3): fmat3;
        mulMut(other: fmat3): Reference<fmat3>;

        static mulVec(a: fmat3, v: fvec3): fvec3;
        mulVec(v: fvec3): fvec3;

        static transpose(a: fmat3): fmat3;
        transpose(): fmat3;
        transposeMut(): Reference<fmat3>;

        static inverse(a: fmat3): fmat3;
        inverse(): fmat3;
        inverseMut(): Reference<fmat3>;

        static determinant(a: fmat3): f32;
        determinant(): f32;

        static equals(a: fmat3, b: fmat3): boolean;
        equals(other: fmat3): boolean;
    }

    /**
     * `fmat4` — a 4x4 matrix: 4 `fvec4` columns.
     *
     * **Column-major, with column vectors.** `m.c0` is the first column and
     * `a.mul(b)` applies `b` first, which is GLM's convention and therefore what
     * every shader and every piece of reference code assumes.
     *
     * 64 bytes, packed — the layout a graphics API expects.
     */
    export class fmat4 {
        private readonly __linalg: "fmat4";

        constructor(c0: fvec4, c1: fvec4, c2: fvec4, c3: fvec4);

        c0: fvec4;
        c1: fvec4;
        c2: fvec4;
        c3: fvec4;

        [index: number]: fvec4;

        /** Every entry zero. */
        static zero(): fmat4;

        /** Ones on the diagonal, zero elsewhere. */
        static identity(): fmat4;

        /**
         * Convert from another 4x4 matrix.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dmat4): fmat4;

        /** Built from its columns, left to right. */
        static fromColumns(c0: fvec4, c1: fvec4, c2: fvec4, c3: fvec4): fmat4;

        /** A scale along each axis. */
        static fromScale(scale: fvec3): fmat4;

        /** A right-handed rotation about the x-axis, in radians. */
        static fromRotationX(angle: f32): fmat4;

        /** A right-handed rotation about the y-axis, in radians. */
        static fromRotationY(angle: f32): fmat4;

        /** A right-handed rotation about the z-axis, in radians. */
        static fromRotationZ(angle: f32): fmat4;

        /** A right-handed rotation about an arbitrary axis. The axis is normalised first. */
        static fromAxisAngle(axis: fvec3, angle: f32): fmat4;

        /** An affine translation. */
        static fromTranslation(offset: fvec3): fmat4;

        /** A right-handed view matrix looking from `eye` towards `center`. */
        static lookAt(eye: fvec3, center: fvec3, up: fvec3): fmat4;

        /** A right-handed perspective projection: vertical field of view in radians, aspect ratio, near and far. Depth maps to `[0, 1]` and `+Y` stays up. */
        static perspective(fovY: f32, aspect: f32, near: f32, far: f32): fmat4;

        /** A right-handed orthographic projection from `left`, `right`, `bottom`, `top`, `near`, `far`. Depth maps to `[0, 1]` and `+Y` stays up. */
        static ortho(left: f32, right: f32, bottom: f32, top: f32, near: f32, far: f32): fmat4;

        static add(a: fmat4, b: fmat4): fmat4;
        add(other: fmat4): fmat4;
        addMut(other: fmat4): Reference<fmat4>;

        static sub(a: fmat4, b: fmat4): fmat4;
        sub(other: fmat4): fmat4;
        subMut(other: fmat4): Reference<fmat4>;

        static scale(a: fmat4, by: f32): fmat4;
        scale(by: f32): fmat4;
        scaleMut(by: f32): Reference<fmat4>;

        static negate(a: fmat4): fmat4;
        negate(): fmat4;
        negateMut(): Reference<fmat4>;

        static mul(a: fmat4, b: fmat4): fmat4;
        mul(other: fmat4): fmat4;
        mulMut(other: fmat4): Reference<fmat4>;

        static mulVec(a: fmat4, v: fvec4): fvec4;
        mulVec(v: fvec4): fvec4;

        static transpose(a: fmat4): fmat4;
        transpose(): fmat4;
        transposeMut(): Reference<fmat4>;

        static inverse(a: fmat4): fmat4;
        inverse(): fmat4;
        inverseMut(): Reference<fmat4>;

        static determinant(a: fmat4): f32;
        determinant(): f32;

        static equals(a: fmat4, b: fmat4): boolean;
        equals(other: fmat4): boolean;
    }

    /**
     * `aligned_fmat3` — a 3x3 matrix: 3 `aligned_fvec3` columns.
     *
     * **Column-major, with column vectors.** `m.c0` is the first column and
     * `a.mul(b)` applies `b` first, which is GLM's convention and therefore what
     * every shader and every piece of reference code assumes.
     *
     * Each column carries a lane of padding: 48 bytes against `fmat3`'s
     * 36, and every column operation is one instruction rather than two.
     */
    export class aligned_fmat3 {
        private readonly __linalg: "aligned_fmat3";

        constructor(c0: aligned_fvec3, c1: aligned_fvec3, c2: aligned_fvec3);

        c0: aligned_fvec3;
        c1: aligned_fvec3;
        c2: aligned_fvec3;

        [index: number]: aligned_fvec3;

        /** Every entry zero. */
        static zero(): aligned_fmat3;

        /** Ones on the diagonal, zero elsewhere. */
        static identity(): aligned_fmat3;

        /**
         * Convert from another 3x3 matrix.
         *
         * Explicit because nothing here converts on its own: an `fvec3` is not a
         * narrower `dvec3`, and a conversion that costs precision should cost a
         * word at the site that pays for it.
         */
        static from(value: dmat3): aligned_fmat3;
        static from(value: aligned_dmat3): aligned_fmat3;
        static from(value: fmat3): aligned_fmat3;

        /** Built from its columns, left to right. */
        static fromColumns(c0: aligned_fvec3, c1: aligned_fvec3, c2: aligned_fvec3): aligned_fmat3;

        /** A scale along each axis. */
        static fromScale(scale: fvec3): aligned_fmat3;

        /** A right-handed rotation about the x-axis, in radians. */
        static fromRotationX(angle: f32): aligned_fmat3;

        /** A right-handed rotation about the y-axis, in radians. */
        static fromRotationY(angle: f32): aligned_fmat3;

        /** A right-handed rotation about the z-axis, in radians. */
        static fromRotationZ(angle: f32): aligned_fmat3;

        /** A right-handed rotation about an arbitrary axis. The axis is normalised first. */
        static fromAxisAngle(axis: fvec3, angle: f32): aligned_fmat3;

        static add(a: aligned_fmat3, b: aligned_fmat3): aligned_fmat3;
        add(other: aligned_fmat3): aligned_fmat3;
        addMut(other: aligned_fmat3): Reference<aligned_fmat3>;

        static sub(a: aligned_fmat3, b: aligned_fmat3): aligned_fmat3;
        sub(other: aligned_fmat3): aligned_fmat3;
        subMut(other: aligned_fmat3): Reference<aligned_fmat3>;

        static scale(a: aligned_fmat3, by: f32): aligned_fmat3;
        scale(by: f32): aligned_fmat3;
        scaleMut(by: f32): Reference<aligned_fmat3>;

        static negate(a: aligned_fmat3): aligned_fmat3;
        negate(): aligned_fmat3;
        negateMut(): Reference<aligned_fmat3>;

        static mul(a: aligned_fmat3, b: aligned_fmat3): aligned_fmat3;
        mul(other: aligned_fmat3): aligned_fmat3;
        mulMut(other: aligned_fmat3): Reference<aligned_fmat3>;

        static mulVec(a: aligned_fmat3, v: aligned_fvec3): aligned_fvec3;
        mulVec(v: aligned_fvec3): aligned_fvec3;

        static transpose(a: aligned_fmat3): aligned_fmat3;
        transpose(): aligned_fmat3;
        transposeMut(): Reference<aligned_fmat3>;

        static inverse(a: aligned_fmat3): aligned_fmat3;
        inverse(): aligned_fmat3;
        inverseMut(): Reference<aligned_fmat3>;

        static determinant(a: aligned_fmat3): f32;
        determinant(): f32;

        static equals(a: aligned_fmat3, b: aligned_fmat3): boolean;
        equals(other: aligned_fmat3): boolean;
    }
}

// </generated by gen-linalg.ts>
