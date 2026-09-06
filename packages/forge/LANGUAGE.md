# Goblin {{VERSION}} — what the compiler supports

<!--
    The version above is substituted by `packages/forge/build.ts` when this is
    copied into `dist`, for the reason `dist/package.json` is generated: a version
    written by hand here would claim the wrong one within a release, and nothing
    would show it. Do not replace the placeholder.
-->


Goblin is a **subset of TypeScript compiled to native code** with C++ value
semantics. You write `.ts`, tsc type-checks it against a prelude that replaces the
JavaScript standard library entirely (`noLib`), and the compiler lowers it to LLVM
IR and links a real binary. There is no GC, no runtime type information beyond
class vtables, and no JavaScript semantics anywhere.

Read the two rules first; most mistakes come from assuming JS or assuming C.

1. **Every value has C++ semantics.** Binding copies. A `string` copy clones its
   buffer. A class copy slices. A scope releases what it owns. Nothing is shared
   implicitly.
2. **Types are written down, never inferred by the compiler.** A number needs a
   width (`i32`, not `number`). Ownership is a property of the type, not of how a
   value is used.

---

## Building

Two ways, and they compile identically.

**CLI** — `goblin-forge` in a project directory. `goblin-forge init` scaffolds one.

**Build script** — `build.ts` calling the packaged library, which is what to use
when the build needs logic (shaders, asset bundling, several artefacts):

```ts
import { compile, formatAll, globalDeclarations, tsconfigBase } from "goblin-forge";

const result = await compile({
    entry: "src/main.ts",
    tsconfig: "src/tsconfig.json",
    output: "bin/game",
    type: "bin",              // "bin" | "static-lib" | "shared-lib"
    optLevel: "O2",           // O0 O1 O2 O3 Os Oz
    target: undefined,        // a triple; host by default
    debugInfo: true,
    checked: false,           // bounds/null checks
    nativeLibs: ["lib/SDL3.lib"],
    runtime: "static",        // "static" | "shared"
    emit: {ir: false},        // keep the .ll beside each object
});
if (!result.ok) {
    console.error(formatAll(result.diagnostics));
    process.exit(1);
}
```

The project's `tsconfig.json` must `extends` the shipped `tsconfig.base.json` and
list the prelude in `files` — `globalDeclarations()` and `tsconfigBase()` give you
both paths. Without them tsc silently puts the DOM back and you are type-checking
against a different language (`GF0003` catches the common cases).

**Needs on `PATH`**: `clang` (the backend emits IR text and calls `clang -c`), a
linker, and `cargo` (the runtime crate is built for your target on demand).
Missing tools are reported as `GF0006` *before* the type-check.

---

## Numbers

Twelve widths. A bare `number` is not a type you can use.

| | |
|---|---|
| signed | `i8` `i16` `i32` `i64` `isize` |
| unsigned | `u8` `u16` `u32` `u64` `usize` |
| float | `f32` `f64` |

They are mutually unassignable. Arithmetic promotes to a common type; narrowing is
refused (`GF0160`) and needs `cast<T>(x)`. `cast` converts between widths and from
`boolean`; it is not a reinterpretation.

```ts
const a: i32 = 1000;
const b: i8 = cast<i8>(a);       // required
const c: f64 = 3 / 2;            // 1.5 — literals take the annotated width
const d: i32 = 3 / 2;            // 1   — integer division
```

Gotchas: `%` on a float is `GF0162`. Unary minus on an unsigned type is `GF0165`.
A literal out of range for its width is `GF0164`. `>>>` does not exist — an
unsigned width already makes `>>` logical.

**Integer enums only**, with an explicit width:

```ts
enum Level { Low = 1, High = 9 }
declare namespace Level { type Underlying = u8 }
```

Members are constants folded at each use. String enums do not exist.

---

## Strings

`string` is one machine word: a pointer to NUL-terminated UTF-8 with a length
header behind it. **Value semantics** — copying clones the buffer. `length` is
O(1) and counts *bytes*. The same pointer is a valid C `char *`.

Members: `length`, `substring(start, end?)`, `indexOf(search, from?)`,
`codePointAt(index)`. Concatenation with `+`, and template literals with `${}`
interpolation of strings, numbers and booleans.

`CString` is a borrowed `const char *` that nothing tracks — the unsafe escape
hatch. `cstring(s)` borrows a `string`'s bytes; `cstringFree(c)` releases one that
came from a Goblin string. Coming the other way: `stringFromCString(p)` (scans for
NUL) and `stringFromBytes(p, len)` (no scan — prefer it when you have the length).

---

## Arrays

Two kinds, and picking the wrong one is the most common design mistake.

**`T[]`** — this language's `std::vector`. Owning, growable, a **value**. One
machine word; `length` is a load. Copying allocates and deep-copies every element.

```ts
const xs: i32[] = [1, 2, 3];
xs.push(4);
const last = xs.pop();
xs.reserve(4096);                  // amortise growth; see the tip below
const ys = xs;                     // a second buffer, not a second name
xs.forEach((x) => { total += x; });
for (const x of xs) { … }          // works over T[] and Reference<T[]>
```

Members: `length`, `capacity`, `reserve`, `push`, `pop`, `forEach`. **No `map`,
`filter`, `reduce`, `find`, `slice`, `concat`, `join`, `sort`, `indexOf`.** Write
the loop.

**`readonly T[]`** is the same value with the mutating half removed — no `push`,
no `pop`, no `reserve`, and writing an element is a tsc error. Use it for
parameters you will not change; it costs nothing.

**`FixedArray<T, N>`** — C's `T x[N]`. **Is** the bytes, not a pointer to them:
`sizeOf<FixedArray<u8, 128>>()` is 128. As a struct field it occupies its whole
layout inline. No allocation, ever.

```ts
const buf: FixedArray<u8, 1024> = fixedArray(1024, 0);       // uniform fill
const m: FixedArray<f64, 4> = fixedArrayOf(1, 0, 0, 1);      // written out
const n: usize = buf.length;                                  // compile-time
const heap: u8[] = buf.toArray();                             // copies
```

`FixedArray<T, N>` **decays to `Pointer<T>`** (and to `Pointer<unknown>`), which is
what makes it the right type for a C out-parameter. The relation is one-way: a
pointer never becomes a `FixedArray`.

`= [1, 2, 3]` against a `FixedArray` annotation **cannot work** — an array literal
is a `T[]` and has none of the pointer members `FixedArray` carries. Use
`fixedArrayOf`. There is no 2-D `FixedArray` spelling yet.

---

## Pointers and references

**`Pointer<T>`** — an address and nothing else, from `alloc` / `allocArray` only.
Unchecked, arbitrary arithmetic, covariant. This is the escape hatch and the
compiler vouches for nothing through it.

```ts
const p: Pointer<Body> = alloc<Body>();               // default-initialised
const q: Pointer<Body> = alloc<Body>({mass: 1.5});    // partial initialiser
const r: Pointer<Body> = alloc(Body, 1.5, 2);         // runs a constructor
const many: Pointer<f64> = allocArray<f64>(1024);
p.free();                                              // runs the destructor
many.freeArray();                                      // delete[]
```

Members: `address`, `deref()`, `p[i]`, `offset(n)`, `erase()` → `Pointer<unknown>`,
`reify<U>()`, `free()`, `freeArray()`. A `Pointer<C>` to a class auto-dereferences
for field and method access. Reinterpreting requires `erase().reify<U>()` — the
visible two-step is the rule (`GF0306`).

**`Reference<T>`** — a borrow, one machine word, bound once and read through
without asking. Only for a **class** or a **contract** today (not structs, not
`string`). Passing a class by value slices it; take a `Reference<T>` when you mean
the object.

**`ConstReference<T>`** — `const T &`. Converts from `Reference<T>` and never
back; refuses field writes and methods that want a mutable receiver.

**`Readonly<T>`** — a view; erases to exactly what `T` erases to.
`Readonly<T[]>` *is* `readonly T[]`. Do not put one inside an address:
`Pointer<Readonly<T>>` is `GF0242`, because it stops nothing.

Declare a method's receiver to mark it const:

```ts
class Body {
    readonly mass: f64 = 1;
    centre(this: ConstReference<Body>): f64 { return this.mass; }
}
```

**A const receiver cannot see `#private` or `private` members.** `Readonly<T>` maps
over `keyof T`, and `keyof` drops them — so `this.#mass` through a
`ConstReference<Body>` is `TS2551`. Use non-private fields on a type whose methods
take a const receiver. A getter cannot be marked at all (`get x(this: …)` is
`TS2784`), so a getter that writes is callable through a read-only borrow — the same
hole C++ has through `mutable`.

**There is no way to take the address of a local.** `alloc<T>()` and a `.free()`
is how you get an out-parameter that C would have put on the stack.

---

## Ownership

`move(x)` transfers; the source becomes unreadable (`GF0235`). `take(x)` pulls a
value out of a slot **that owns something** and leaves the default behind — the way
to get a `string` or a `T[]` out of an array element or a field without copying.

```ts
const owned: string = move(other);       // `other` is dead
const s = take(names[i]);                // `names[i]` is now the empty string
const n = take(counts[i]);               // an i32: a plain read, `counts[i]` unchanged
```

**On a trivial type `take` is just a read** and writes nothing back — there is
nothing to take and nothing to put back, so it costs what a read costs. Do not rely
on it zeroing a scalar slot. `take` refuses a class (an object whose constructor
never ran is what it would have to leave behind).

A by-value parameter cannot be moved out of (`GF0236`). A reference cannot borrow
a temporary (`GF0234`).

**Destructors are generated, not written.** A class whose fields own anything gets
one; there is no syntax for writing your own. A container releases what it holds
because the compiler generated the code, so the way to own memory is to hold it in
a field of an owning type — not to write cleanup.

---

## Module-level constants

A `const` at file scope is **one symbol in `.rodata`**. No initialiser ever runs:
the value has to be resolvable at compile time, which is C++'s constant
initialisation and means there is no startup code and no initialisation order.

```ts
const EPHEMERIS: FixedArray<f64, 256> = fixedArrayOf(/* … */);
const NAME: string = "sol";
const PLANETS: readonly string[] = ["mercury", "venus", "earth"];
const UP: dvec3 = new dvec3(0, 1, 0);
const LIMIT: i32 = 60;
const BUDGET: i32 = LIMIT * 2;             // reads another constant
const STRIDE: usize = sizeOf<Body>();      // resolved by the backend
```

**What folds**: literals, enum members, arithmetic over them, `sizeOf`/`alignOf`
as a whole initialiser, other constants of the same module, `zeroed<T>()`,
`fixedArray`/`fixedArrayOf`, object literals, `new dvec3(…)` and `dvec3.zero()`,
string literals, array literals, and **a named function's address**.

**A dispatch table** — C's `int (*fns[])(int)`:

```ts
const HANDLERS: FixedArray<(e: Event) => void, 4> =
    fixedArrayOf(onKey, onMouse, onQuit, onResize);
HANDLERS[kind](event);
```

**Rules to know**
- An array constant must be `readonly` — `const` only stops the name being
  rebound, and `push`/`xs[0] = v` would write into read-only memory.
- Types allowed: scalars, `boolean`, enums, pointers, function pointers, structs,
  `FixedArray`, `string`, `readonly T[]`. Not classes.
- An array **nested** in a struct constant is refused.
- A closure cannot be one (it captures a frame that does not exist yet).
- `sizeOf<T>() * 2` does not fold — the size is the backend's to resolve.
- String concatenation does not fold.
- No top-level `let`. `GF0007` is "value not known at compile time"; `GF0008` is
  "this type cannot be one, or it is a cycle".

**`static` fields**: `static readonly` is a constant; a plain `static` is
**writable**, in `.data`. A derived class shares the variable rather than copying
it. A `static` on a generic class is refused.

```ts
class Counter {
    static frames: u64 = 0;
    static readonly limit: i32 = 60;
}
Counter.frames++;
```

**Across files**: `export const` is read by an importing module with nothing to
declare. From a *library*, import its **source** and the value folds into you.
`declare const NAME: i32` names a foreign data symbol verbatim, like
`declare function`.

---

## Structs, classes and interfaces

**An interface with only data is a struct** — C-compatible layout, fields in
declaration order, naturally aligned, never reordered, nested aggregates inline.

```ts
interface Body { mass: f64; position: dvec3; }
const b: Body = {mass: 1.5, position: dvec3.zero()};
```

**An interface with methods is a contract** — dispatched through an itab, and a
`Reference<Shape>` is two words. **You cannot mix data and methods** in one
interface; that is a rule, not a gap.

**A class** is nominal, has a vtable pointer at offset 0, and slices when copied.
Supported: fields with initialisers, constructors, parameter properties
(`constructor(private x: i32)`), methods, `override`, accessors (`get`/`set`),
`static` methods and fields, `static` accessors, single inheritance,
`implements`, `private`/`protected`/`readonly`.

**`instanceof` does not exist.** `tryCast<T>(x)` is the checked downcast — it
returns `Reference<T> | null` and searches the object's real type at run time,
which works for a base class and for a contract:

```ts
const dog = tryCast<Dog>(animal);
if (dog !== null) { dog.bark(); }
```

A constructor is **not inherited** (`GF0241`) — a derived class whose base takes
arguments must declare its own and forward. `abstract` methods are not supported
(no body to emit). Two classes with the same name in two modules is a stated
restriction.

**Unions**: `interface E extends Union { … }` — every member at offset 0, members
must be plain data.

---

## Generics

Monomorphised: one copy per set of type arguments, made on demand. Functions,
classes and methods. Constraints are tsc's business.

```ts
function max<T extends number>(a: T, b: T): T { return a > b ? a : b; }
class Box<T> { constructor(readonly value: T) {} }
```

`hashOf<T>(v)` and `equalsOf<T>(a, b)` work over any key type; a class becomes a
key by declaring `hash(): u64` and `equals(other: Reference<T>): boolean`. Floats
are not keys (`GF0407`).

Not supported: a generic base class (`class D extends Box<i32>`), a `static` on a
generic class, a body-less generic (`GF0403`), a conditional type whose condition
mentions a type parameter.

`std/collection` is ordinary Goblin source compiled into whoever imports it. There
is no `Vec` — `T[]` is already the growable array.

| | |
|---|---|
| `HashMap<K, V>` | `size` · `set(k, v)` · `has(k)` · `getOr(k, fallback)` · `indexOf(k): isize` · `keyAt(i: usize)` · `valueAt(i: usize)` · `setAt(i, v)` · `remove(k)` · `clear()` · `reserve(n)` · `forEach(f)` |
| `HashSet<T>` | `size` · `add(v)` · `has(v)` · `remove(v)` · `at(i)` · `clear()` · `reserve(n)` · `forEach(f)` |
| `BinaryHeap<T>` | **`new BinaryHeap<T>(minFirst)`** — a comparator is required, and it must be a **named function** · `size` · `peek()` · `push(v)` · `pop()` · `clear()` · `reserve(n)` |
| `RingBuffer<T>` | `size` · `capacity` · and the rest — read the source |

**There is no `get(k)` returning an optional**, because this language has no
`undefined`. Two shapes instead: `getOr(k, fallback)`, or an index lookup —
`indexOf` returns an **`isize`** that is negative when absent, and `valueAt` takes
a `usize`, so the check and the cast are both required:

```ts
const at = orbits.indexOf("mars");
if (at >= 0) {
    console.log(`${orbits.valueAt(cast<usize>(at))}`);
}
```

A key type answers `hashOf`/`equalsOf`; a class becomes a key by declaring
`hash(): u64` and `equals(other: Reference<K>): boolean`. A float is not a key.

---

## Closures

`LocalFn<F>` — captures by reference into the caller's frame, so it **must not
outlive the call** (`GF0239`). Zero allocation. This is what `forEach` takes.

```ts
function each(f: LocalFn<(x: i32) => void>): void { … }
each((x) => { total += x; });          // written at the call site, no annotation
```

A plain function type `(a: i32) => i32` is a **code address** — a named function
or a `static`, never a closure. Escaping closures (`HeapFn`) and `RefCount<T>` do
not exist yet.

**This distinction bites at any API taking a bare `F` rather than a `LocalFn<F>`.**
`BinaryHeap`'s comparator is the one in the shipped library:

```ts
function minFirst(a: i32, b: i32): boolean { return a < b; }
const heap = new BinaryHeap<i32>(minFirst);        // yes
const bad  = new BinaryHeap<i32>((a, b) => a < b); // GF0001 — that is a closure
```

Rule of thumb: if the parameter type is `LocalFn<…>`, write a lambda; if it is a
bare function type, pass a named function.

---

## The C boundary

Declare the symbol and call it:

```ts
declare function SDL_CreateWindow(title: CString, w: i32, h: i32, flags: u64): Pointer<SDL_Window>;
declare const SDL_ALPHA_OPAQUE: u8;      // a foreign data symbol
```

An `export function` in the entry module is a C entry point classified by C rules.
What may cross is checked (`GF0301`): plain data all the way down. An opaque handle
is a `declare class` with a private member — no layout, no destructor, and
`Pointer<Handle>` is how you hold one.

Link with `nativeLibs: ["lib/SDL3.lib"]`, or `manifests` for pkg-config-style
descriptions. `systemLib(name)` names a platform library.

Useful shapes:

```ts
// An out-parameter C would put on the stack.
const size: FixedArray<usize, 1> = fixedArray(1, 0);
const data = SDL_LoadFile_IO(io, size, false);
if (data !== null) {
    console.log(stringFromBytes(data.reify<u8>(), size[0]));
    SDL_free(data);
}
```

---

## Standard library

**`std/alloc`** — `mi_malloc`, `mi_calloc`, `mi_realloc`, `mi_free`, `mi_zalloc`,
`mi_malloc_aligned`, `mi_realloc_aligned`, `mi_usable_size`. The same mimalloc the
runtime uses, so a pointer crosses freely.

**`std/io`** — `fileOpen(path, mode)`, `fileClose`, `fileWrite`, `fileRead`,
`fileReadAll`, `fileSeek(file, offset, Seek.Set | Seek.Current | Seek.End)`,
`fileTell`, `fileSize`, `fileFlush`, `stdin()`, `stdout()`, `stderr()`, and the
`Seek` enum. A `Pointer<File>` is closed by `fileClose` and by nothing else —
never `.free()` it, which would release the handle and leave the descriptor open.
Unclosed files are caught by the leak check. The three standard streams are
functions, and closing one is a no-op.

**`std/math`** — every function twice, `d` for `f64` and `f` for `f32`:
`sin cos tan asin acos atan atan2 sinh cosh tanh exp exp2 log log2 log10 pow sqrt
cbrt hypot floor ceil round trunc abs fmod min max copysign isnan isinf isfinite`,
plus the constants as calls: `dpi() dtau() de() dinf() dnan()` and the `f` twins.

**`console`** — `log`, `info`, `debug`, `warn`, `error`, each taking a string,
number or boolean. `log`/`info`/`debug` go to stdout, `warn`/`error` to stderr.

---

## `std/linalg`

SIMD types the compiler knows about, lowered to vector instructions. **Not**
classes — no allocation, no vtable.

| family | types |
|---|---|
| `f64` vectors | `dvec2` `dvec3` `dvec4` `aligned_dvec3` |
| `f32` vectors | `fvec2` `fvec3` `fvec4` `aligned_fvec3` |
| integer | `ivec2..4` `uvec2..4` `lvec2..4` `ulvec2..4` |
| boolean | `bvec2..4` |
| matrices | `dmat2` `dmat3` `dmat4` `aligned_dmat3`, `fmat2..4` `aligned_fmat3` |
| quaternions | `dquat` `fquat` |

```ts
import { dvec3, dmat4, dquat } from "std/linalg";

const v = new dvec3(1, 2, 3);          // one argument per component
const z = dvec3.zero();
const s = dvec3.splat(2);
const n = v.normalize();
const d = v.dot(z);
const c = v.cross(z);
const m = dmat4.identity();
const q = dquat.identity().slerp(target, t);
const w = dvec3.from(someFvec3);       // a *conversion*, not a copy
```

**`from` converts between linalg types** — `dvec3.from` has an overload for
`aligned_dvec3`, `fvec3`, `ivec3`, `uvec3`, `lvec3`, `ulvec3` and `bvec3`. It is
explicit because nothing here converts on its own: an `fvec3` is not a narrower
`dvec3`, and losing precision should cost a word at the site that pays for it.
`dquat.from` takes an `fquat`, because that is a quaternion's only sibling.

Operations (per family): `add sub mul div rem scale addScaled negate abs sqrt
floor ceil round trunc min max clamp lerp nlerp slerp dot cross length lengthSq
distance distanceSq normalize unit equals equalTo notEqualTo lessThan
lessThanEqual greaterThan and or xor not any all bitAnd bitOr bitXor shl shr
transpose determinant inverse mulVec rotateVec conjugate toMat3 toMat4 from zero
one identity`.

`aligned_dvec3` is a padded four-lane form — faster, 32 bytes; `dvec3` is packed
24 bytes for buffers. They are **distinct types** and do not mix.

A matrix is columns of the vector type: `dmat3` is three `dvec3`, 72 bytes, the
layout a graphics API expects. Columns are ordinary field accesses.

---

## Control flow

Supported: `if`/`else`, `while`, `do…while`, `for`, `for…of` (over `T[]`),
`switch` with `case`/`default`/fallthrough, `break`, `continue`, labelled
statements with labelled `break`/`continue`, `return`, the ternary `?:`, `&&`/`||`
short-circuiting.

Not supported: `throw`, `try`/`catch`/`finally`, `for…in`, generators, `async`,
the comma operator, `??`, `&&=`, `||=`, `??=`, and the *value* of `a++` / `++a` /
`(a += 1)` (they work as statements).

`let e: SDL_Event;` with no initialiser is refused — write
`let e: SDL_Event = zeroed<SDL_Event>();`.

Function parameters cannot be optional, defaulted, rest or destructured.

---

## Diagnostics

`GF00xx` the build · `GF01xx` widths and arithmetic · `GF02xx` ownership and
references · `GF03xx` layout and the C boundary · `GF04xx` generics ·
`GF90xx` the compiler is broken, not your program.

`GF0001` means "valid TypeScript, meant to be valid Goblin, not implemented yet".
`GF0002` means "TypeScript allows this and Goblin does not". Both name the exact
construct.

Every code carries a title and a long explanation, reachable from a build script —
`explain(code)`, `allCodes()` and `CODES` are exported by the package. The CLI's
only flags are `--help`, `--quiet` and `--version`.

The ones you will actually hit: `GF0160` narrowing (add a `cast`), `GF0161` no
common type / a widthless number, `GF0235` reading a moved-from value, `GF0234`
borrowing a temporary, `GF0301` a type that cannot cross to C, `GF0007`/`GF0008`
a constant that will not fold.

---

## Tips

**Reserve before a push loop.** `push` doubles, which allocates a second buffer
beside the first at every step — a 400 MB array transiently wants 1.2 GB.
Growth through `reserve` goes through `realloc` and often extends in place:

```ts
if (bodies.length === bodies.capacity) { bodies.reserve(bodies.capacity + 4096); }
bodies.push(b);
```

**Put lookup tables at module scope.** A `FixedArray` local is stack stores on
every call; a module-level `const` is an address in `.rodata`.

**Pass big values by `Reference<T>` or `ConstReference<T>`.** A by-value class
parameter *slices* — the derived part is gone and the vtable becomes the base's.
For structs there is no reference yet, so a by-value struct parameter copies;
keep hot structs small or hold them behind a `Pointer<T>`.

**`take` an element out; do not copy it.** `take(slots[i])` moves the value and
leaves the default. Reading (`xs[i]`, `peek`, `valueAt`) copies, which for an
owning element means an allocation.

**Prefer `aligned_dvec3` for computation, `dvec3` for storage.** Four lanes are
one register; three lanes packed are what a vertex buffer wants.

**Let the leak check work for you.** Every program that returns from `main`
reports its live allocation count. A non-zero one is a real leak, and an *absent*
report means the program died before exiting.

**Read the `.ll`.** `emit: {ir: true}` keeps the LLVM IR beside every object. When
you suspect the compiler, that is the first place to look — and it is where to
confirm a constant really landed in `.rodata`.

**Use `checked: true` while developing.** It adds bounds and null checks. Release
builds leave them out; this is an unsafe language on purpose.

**Write the loop.** There is no `map`/`filter`/`reduce`. A `for…of` over a `T[]`
or an indexed `while` is the idiom, and both lower to the same thing.

**When something is refused, read the code, not just the message.** `GF0001` means
it is coming; `GF0002` means find another way. The distinction is deliberate.
