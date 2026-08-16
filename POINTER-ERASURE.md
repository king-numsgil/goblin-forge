# Pointer erasure: `erase()` / `reify<U>()`

Working notes, kept for the reasoning rather than for the conclusion.
**Answered on 2026-08-16 — DECISIONS §13 is what landed**, and where the two
disagree, that one is right.

The short version of the outcome: option 1 below, `Pointer<unknown>` erasing to
`Pointer<void>`; erasure implicit and reification written; `reify` refused on a
pointer that never lost its type. Two things this file gets wrong are worth
knowing before reading it, because both were true when it was written:

- **The five hand-written guards are one.** By the time this was implemented the
  opaque-handle work had already funnelled every layout-needing operation
  through `requireKnownLayout`, so the refusals below are inherited from a
  single arm rather than written five times.
- **The mechanical blocker was not the one described.** `erase()` does not fall
  past every branch and reach the final throw. `pointeeOf` calls
  `getNonNullableType`, and `NonNullable<unknown>` is `{}` — so the failure was
  "an object with no fields has no machine representation", which is true of
  `{}` and says nothing about the program.

Everything else on the pointer was already implemented when this was written:
`address`, `deref()`, `offset()`, `free()`, `freeArray()`, indexing,
`Pointer<T> | null`, `allocArray`.

## What the two are for

```ts
erase(): Pointer<unknown>;   // Pointer<T>       →  Pointer<unknown>
reify<U>(): Pointer<U>;      // Pointer<unknown> →  Pointer<U>
```

C's `void *`, round trip. The prelude calls the pair "the only escape hatch in
the ambient surface — there is deliberately no `any` and no unchecked cast
between two concrete pointee types." The uses are C-shaped: callback userdata,
`memcpy`, a `qsort` comparator, any C parameter declared `void *`.

Opaque *handles* are not one of the uses. Those have a better answer —
`declare class MetisWorld { private _opaque: never }` — which stays nominal and
is **implemented**: it erases to `TyKind::Opaque`, a type with no layout, and
every operation that would need one is `GF0302` rather than a wrong stride. The
`free()` hazard below is the reason it is its own MIR variant instead of a
`void` pointee.

## Why they are stuck

`Pointer<T>` is `T extends GfPrimitive ? CorePointer<T> : T & CorePointer<T>`,
so `Pointer<unknown>` is `CorePointer<unknown>` and the pointee the brand
carries is `unknown`.

Run `unknown` through `erase()` in `packages/checker/src/types.ts` and it falls
past every branch — not void, not scalar, not a class, not a reference, not an
array, and not even `TypeFlags.Object`, which `Unknown` is not — and lands on
the final throw. **There is no `MachineType` for a pointee with no type.**

That is the mechanical blocker, and it is the easy half. The hard half is what
such a pointer is still allowed to *do*, because `CorePointer<T>` gives it six
other members that all need `T`:

| Member | Needs from `T` |
|---|---|
| `p[i]`, `p.offset(n)` | the stride |
| `p.free()` | the size and alignment, for `gf_free` |
| `p.freeArray()` | the size, and a destructor per element |
| `p.deref()` | a `Reference<T>` to hand back |

### The `free()` hazard, which is the real one

`gf_free(pointer, size, align)` is Rust's `dealloc`, which **must** be given the
layout the block was allocated with. So:

```ts
const p = alloc<Big>();
const raw = p.erase();
raw.free();              // gf_free(raw, ?, ?) — mismatched layout
```

A mismatched layout is undefined behaviour in the allocator: a corrupted heap,
not a wrong number. C++ makes `delete (void *)p` undefined for exactly this
reason. Whatever the design, this call has to be **refused**, and it has to be
refused by the frontend — the backend does not report user errors.

## What `Pointer<unknown>` could erase to

Three answers, and the choice is really "which operations become wrong answers
rather than diagnostics".

**1. `pointee: { kind: "void" }` — literally `void *`.** Costs nothing new:
`void` is already a `MachineType` and a `TyKind`, `TyKind::Pointer(Void)` is
already expressible, the layout engine already answers for it, and the C header
generator emits `void *` on its own. But `void` has size 0 and align 1, so
**nothing throws**: `stride()` is 0, `p[i]` silently returns the same address
for every `i`, `offset(n)` adds nothing, and `free()` passes size 0. Every
dangerous operation needs an **explicit guard**; none of them refuses itself.
This was the assumption I got wrong first time round — "the pointee has no
layout so the layout queries will fail" is false, because `void` *has* a layout.

**2. `pointee: { kind: "scalar", name: "u8" }` — `char *`.** Stride 1, so
arithmetic and indexing are honest byte arithmetic and need no guard. But
`Pointer<unknown>` and `Pointer<u8>` become the same machine type, so erasure
stops being visible to the compiler at all, and `free()` still passes the wrong
size.

**3. A new opaque `MachineType` kind with no layout.** Then every layout query
fails at the existing wall and the refusals are inherited rather than written.
Costs a new kind threaded through `erase`, `tyOf`, the layout engine, the header
generator and the codegen's type switch — five files that currently have
exhaustive matches.

Option 1 plus five hand-written guards is cheaper than option 3 and ends up in
the same place. The guards go in `#free`, `#freeArray`, `#offset`, `#deref` and
the element-access path, all in `packages/forge/src/lower.ts`.

## The wart to fix at the same time

`reify<U>()` is declared on `CorePointer<T>`, so it is callable on **any**
pointer:

```ts
somePointerToI32.reify<Rect>();   // type-checks today
```

That is precisely the "unchecked cast between two concrete pointee types" the
prelude says does not exist. Whatever spelling is chosen, the round trip should
have to be written out, so the escape hatch is visible at the site that uses it.

## The design that was probed, and rejected

The idea: drop both methods and fold them into `cast`, since erasure is a
`reinterpret_cast` and `cast` is already the language's written conversion.

```ts
const raw  = cast<Pointer<unknown>>(p);      // reinterpret_cast<void*>(p)
const back = cast<Pointer<Rect>>(raw);       // reinterpret_cast<Rect*>(raw)
```

Spelled `cast<Pointer<unknown>>` rather than `cast<unknown>` so that `cast<T>`
keeps its one meaning, "gives you a `T`". `cast<unknown>(p)` returning
`Pointer<unknown>` would make the rule "gives you a `T`, unless the argument is
a pointer, in which case a `Pointer<T>`".

Why it fitted better than the methods:

* **It kills the `reify` wart structurally.** A pointer cast can be made legal
  only when one side's pointee is `void`; two concrete pointees is a `GF0002`
  telling you to write the round trip out. As a method on `CorePointer<T>` there
  is no natural place for that rule.
* **`CastKind::PtrToPtr` already exists and is already used** — `cstring(s)` is
  one — so the backend needs nothing.
* The rest is small: a `#castKind` arm, the `unknown` → `void` pointee in
  `erase()`, the one-side-must-be-`void` rule, and the five guards above.

### The probe

Run against real tsc with the actual prelude and `tsconfig.base.json`, because
the branded widths make overload resolution surprising often enough that this
codebase already carries a "verified against real tsc, not assumed" comment.

**The signature you would naturally write is broken:**

```ts
declare function cast<T extends number>(value: number): T;
declare function cast<T>(value: CorePointer<unknown>): T;   // WRONG
```

`T` is unconstrained, so `cast<i32>(p)` compiles — `i32` satisfies `T` and the
pointer matches the parameter. That is `reinterpret_cast<int>(ptr)`, the exact
class of thing the design refuses. It is silent.

**Constraining `T` closes it:**

```ts
declare function cast<T extends number>(value: number): T;
declare function cast<T extends CorePointer<unknown>>(value: CorePointer<unknown>): T;
```

With that, every case behaves:

| Written | Want | tsc |
|---|---|---|
| `cast<i32>(someI64)` | ok | ok |
| `cast<u8>(someI32)` | ok | ok |
| `const x: i32 = cast<u8>(w)` | error | error |
| `cast<Pointer<unknown>>(p)` — erase | ok | ok |
| `cast<Pointer<Rect>>(raw)` — reify | ok | ok |
| `cast<Pointer<Other>>(p)` — concrete→concrete | ok, compiler's job | ok |
| `cast<Pointer<Rect>>(someI64)` | error | error |
| `cast<i32>(p)` | error | error |
| `cast<string>(p)` | error | error |
| `cast<CString>(p)` | error | error |
| `cast<i32>(someCString)` | error | error |
| `const y: Pointer<Rect> = cast<Pointer<unknown>>(p)` | error | error |

### Two side effects the probe turned up

* **Fixed-array decay gets a spelling for free.** `FixedArray<T, N> extends
  CorePointer<T>`, so `cast<Pointer<u8>>(buf)` type-checks. That is `GF0161`
  today and a documented gap. It is *not* free in the lowerer: a fixed array
  **is** the bytes, so it lowers to an `AddrOf` of the array's place, not a
  `PtrToPtr` of a value. Its own decision, and its own change.

  *Made on 2026-08-16 — DECISIONS §14. Decay is implicit rather than a cast, to
  the element type or to `void`, and the `AddrOf` prediction above is exactly
  what it turned out to need.*
* **`CString` converts in neither direction.** It carries its own brand and no
  `PointerBrand`, so `cast<Pointer<u8>>(someCString)` is a type error. Probably
  right — `cstring` and `stringFromCString` already own that boundary — but raw
  byte access to a `CString` would need a third overload.

### One thing that gets worse

With the constraint, `cast<i32>(p)` reports against the *first* overload only:

```
Argument of type 'Rect & CorePointer<Rect>' is not assignable to parameter of type 'number'.
```

It says `number` when you asked for `i32`, which reads oddly. Unconstrained it
was a `TS2769` naming both arms — more informative, and also the version that
let the bad cast through. The compiler cannot improve a tsc message.

### The probe itself

`tsconfig.json` extends `packages/runtime/tsconfig.base.json` with
`"files": ["prelude.d.ts", "probe.ts"]`, where `prelude.d.ts` is a copy of
`packages/runtime/global.d.ts` with the second `cast` overload added.

```ts
declare class Rect { w: i32; }
declare class Other { y: i32; }

export function probe(): void {
  const n: i64 = 300;
  const w: i32 = 1;
  const p: Pointer<Rect> = alloc(Rect);
  const buf: FixedArray<u8, 4> = fixedArray(4, 0);
  const c: CString = cstring("x");

  const a: i32 = cast<i32>(n);                      // WANT-OK
  const b: u8 = cast<u8>(w);                        // WANT-OK
  const f: f64 = cast<f64>(w);                      // WANT-OK
  const bad1: i32 = cast<u8>(w);                    // WANT-ERR

  const raw: Pointer<unknown> = cast<Pointer<unknown>>(p);   // WANT-OK  erase
  const back: Pointer<Rect> = cast<Pointer<Rect>>(raw);      // WANT-OK  reify
  const cross: Pointer<Other> = cast<Pointer<Other>>(p);     // WANT-OK  compiler refuses

  const bad2: Pointer<Rect> = cast<Pointer<Rect>>(n);        // WANT-ERR
  const bad3: i32 = cast<i32>(p);                            // WANT-ERR
  const bad4: i32 = cast<i32>(c);                            // WANT-ERR
  const bad7: string = cast<string>(p);                      // WANT-ERR
  const bad8: CString = cast<CString>(p);                    // WANT-ERR

  const decay: Pointer<u8> = cast<Pointer<u8>>(buf);         // ?  type-checks
  const fromC: Pointer<u8> = cast<Pointer<u8>>(c);           // ?  error

  const bad5: Pointer<Rect> = cast<Pointer<unknown>>(p);     // WANT-ERR
  const bad6: string = cast<Pointer<Rect>>(raw);             // WANT-ERR

  // every binding read once, so nothing is elided
  console.log(`${a} ${b} ${f} ${bad1}`);
  console.log(`${raw.address} ${back.w} ${cross.y} ${bad2.w} ${bad3} ${bad4}`);
  console.log(`${decay.address} ${fromC.address} ${bad5.w} ${bad6}`);
}
```

## Where it stands

Settled and built, 2026-08-16, on the four questions this section used to leave
open. DECISIONS §13 has the reasoning; this is the tally.

1. **What `Pointer<unknown>` erases to** — `void`. Option 1, and the backend
   needed nothing at all for it.
2. **Whether the operations are refused, and whether the refusals are written**
   — refused, `GF0305`, and inherited from the one guard the opaque handle
   already goes through.
3. **Whether the round trip has to be written out** — yes. `reify` on a pointer
   that never lost its type is `GF0306`, so a concrete-to-concrete
   reinterpretation is `p.erase().reify<Other>()` and is visible.
4. **Whether tsc should enforce (2) instead** — no. A distinct type carrying
   only `address` is cleaner in an editor, but it is not spelled
   `Pointer<unknown>` any more, and the compiler's refusal arrives with a line
   and a reason where a missing member arrives with neither.

One thing this section did not ask, and it turned out to matter more than any of
the four: **whether erasure is implicit.** It is. `CorePointer<T>` is covariant
in `T`, so tsc already permits `Pointer<Rect>` → `Pointer<unknown>` and already
refuses the reverse — C's asymmetry, arrived at for free. A binding that has to
write `.erase()` at every `void *` parameter is a binding nobody wants to
maintain.

The `cast<Pointer<T>>` design above stays rejected, and now for a stated reason
rather than taste: `GF0163`'s own explanation in the code table already says
`cast` is not a reinterpretation and that converting a pointer is a different
operation with its own spelling.
