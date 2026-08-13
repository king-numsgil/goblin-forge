# goblin-forge

A compiler that takes a subset of TypeScript and produces native machine code
with C++'s value semantics — objects are values, copying a class slices, and a
binding's scope destroys what it holds.

`tsc` is the type checker and its verdict is final. There is no second frontend,
no custom syntax, and no compiler plugin: a stock TypeScript toolchain reads the
same files this compiler does, so the editor underlines what the compiler will
reject, while you type.

This is the second implementation. [`REWRITE-PLAN.md`](REWRITE-PLAN.md) is the
design document it is being built from, and it is worth reading first — it says
what v1 got right, what it got wrong, and why. [`DECISIONS.md`](DECISIONS.md)
records the answers to the questions that plan left open, as they land.

## Status

All ten milestones of [`REWRITE-PLAN.md`](REWRITE-PLAN.md) are complete. What
works today:

```ts
// examples/hello/src/main.ts
function factorial(n: i32): i32 {
  let result: i32 = 1;
  let i: i32 = 2;
  while (i <= n) {
    result = result * i;
    i = i + 1;
  }
  return result;
}

export function main(): i32 {
  return factorial(5);
}
```

```console
$ bun run examples/hello/build.ts
built F:\Programming\goblin-forge\examples\hello\bin\hello.exe
$ ./examples/hello/bin/hello.exe; echo $?
120
```

Functions over the twelve fixed widths, `boolean` and `string`, with `if`,
`while`, `for`, `break`, `continue`, `return`, local bindings, arithmetic,
comparisons, short-circuiting `&&`/`||`, calls, template literals and `console`.
Structs and fixed-size arrays are in, with nested aggregates laid out inline,
and so is the C boundary. Classes are in: fields, constructors, methods,
`super`, single inheritance, virtual dispatch and slicing — and so are
dispatched interfaces, with checked downcasts through `tryCast<T>`. Anything
not yet supported is a `GF0001` diagnostic with a file and a line — never a
failure inside the backend.

Strings are the first **owning** type, so the value model is real now:

```ts
const a = "hello, " + name;   // allocates
const b = a;                  // a copy — allocates again
const c = move(a);            // a move — no allocation; `a` is dead afterwards
console.log(a);               // GF0235: `a` was moved from
// b and c are released here, in reverse order of construction
```

Every value is released by the scope that owns it, and every test asserts the
live allocation count is zero afterwards — automatically, without opting in.

The width rules are in, and they are the part most likely to surprise someone
arriving from C:

```ts
const a: i32 = 1;
const b: u32 = 2;
const sum = a + b;          // GF0161: no common type. C makes this u32 and
                            // turns negative values into very large ones.

const wide: i32 = 1000;
const narrow: i8 = wide * 2;  // GF0160: the truncation is invisible at the
                              // point it costs you. Write nativeCast<i8>(…).

const bits: i8 = 0xff;      // fine — -1, because that is how anybody writes
const same: i8 = 255;       // GF0164 — but this is not a bit pattern.

const value: u8 = 200;
const shifted: u8 = value << 1;   // 144. A shift keeps the value's type; the
                                  // count is converted to it, not promoted.
```

`i32 + u32` and `i64 + f64` both being errors is the same rule twice: a type
promotes to another exactly when *every* value of it is exactly representable
there. Neither of those pairs qualifies — and `i64` to `f64` is the one people
do not expect, because `f64` is exact only to 2^53.

### Objects are values

The largest semantic difference the language has from TypeScript, and the one
tsc cannot warn about:

```ts
interface Point { x: i32; y: i32; }

const a: Point = { x: 1, y: 2 };
const b: Point = a;     // a copy, not an alias
b.x = 5;                // `a.x` is still 1
```

A nested aggregate is **inline** — a field of struct type occupies its own
layout inside the parent, not a pointer to it — so copying the outer value
copies the inner one with it. That is what C interop depends on, and it is
checked against a C compiler rather than asserted:

```console
$ bun test tests/layout.test.ts
 12 pass  0 fail
```

`tests/oracle/layout/layout.cpp` declares ten shapes and prints what the C
compiler decided about each one's size, alignment and field offsets; the same
shapes are built as MIR and the backend's layout engine is asked directly. All
ten agree.

### Classes are values, and copying one slices

```ts
class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
  speak(): string { return "..."; }
}

class Dog extends Animal {
  sound: string;
  constructor(name: string, sound: string) { super(name); this.sound = sound; }
  override speak(): string { return this.sound; }
}

const d = new Dog("rex", "woof");
console.log(d.speak());     // woof — dispatched through the vtable

const a: Animal = d;        // a copy, and it slices
console.log(a.speak());     // ... — `a` is an Animal, and speaks as one
```

That last pair of lines is the whole of C++'s object model in miniature, and it
is the second thing tsc cannot warn you about. `a` gets `Animal`'s fields *and*
`Animal`'s vtable; `sound` is not copied, because there is nowhere in an
`Animal` to put it. Polymorphism travels through references, never through
values.

Nobody writes a destructor — there is no syntax for one. `Dog` releases its two
strings because their *type* says they own something, and a derived class runs
its own fields' releases and then its base's. The allocation trace is checked
against the equivalent C++ program:

```console
$ bun test tests/oracle.test.ts
 9 pass  0 fail
```

That suite is also what found the first real bug of this milestone. `move(param)`
inside a constructor looked right, compiles in C++, and double-freed here —
because the caller destroys a by-value argument and an owning value travels as a
handle in a register, so emptying the callee's copy does nothing to the caller's.
It is `GF0236` now, with the explanation in the message.

### Interfaces come in two kinds, and the syntax says which

```ts
interface Speaker { speak(): string; }        // a contract — dispatched
interface Point   { x: i32; y: i32; }         // a shape — a struct, as before

class Dog   { name: string;  speak(): string { return `${this.name} says woof`; } }
class Robot { id: i32;       speak(): string { return `unit ${this.id} reporting`; } }

function announce(who: Reference<Speaker>): void {
  console.log(who.speak());
}
```

`Dog` and `Robot` share no base class, so no vtable layout could serve both —
which is exactly why interface dispatch needs a third object neither of them
owns. A `Reference<Speaker>` is a two-word `(itab, data)` pair, and the itab is
static data holding that one class's answers to that one interface, built at
compile time by gathering from its vtable. Dispatch is two loads and an indirect
call, the same as a virtual call.

Neither class writes `implements`. **Conversion is structural**, exactly as in
TypeScript — the conversion site is what registers the itab, so a class the
interface has never heard of still converts. Writing `implements` additionally
makes the class findable by a *dynamic* cast:

```ts
function report(a: Reference<Animal>): void {
  const s = tryCast<Speaker>(a);
  if (s !== null) { console.log(s.speak()); }
}
```

`tryCast<T>` answers "is this really a `T`" for a class or a contract, and the
`| null` is the design rather than a detail: `strictNullChecks` **rejects**
`tryCast<Speaker>(a).speak()`, so the check is the only way to reach the value.
A boolean type guard could have been ignored.

The distinction between the two kinds is **syntactic, at the declaration**:

| Written | Is |
|---|---|
| `feed(): void` — a method signature | a **contract**: dispatched, no layout, held as `Reference<I>` |
| `feed: () => void` — a function-typed property | a **shape**: an ordinary function-pointer field |

TypeScript already treats these differently (under `strictFunctionTypes`, method
signatures are bivariant and function-typed properties are contravariant), and so
does JavaScript — a method goes on the prototype, a property lives on the
instance. Drawing the line there keeps C's struct-of-callbacks a plain struct,
and means adding contracts to the language changed the meaning of no existing
declaration.

### Arrays come in two kinds, and the type says which

```ts
// inline — no allocation, length in the type, `sizeof` is 128
const buf: FixedArray<u8, 128> = fixedArray(128, 0);
buf[0] = 1;

// owning and growable — this language's `std::vector`
const xs: i32[] = [1, 2, 3];
xs.push(4);
const ys = xs;          // a copy: a second buffer, not a second name
const last = xs.pop();
```

A `FixedArray<T, N>` **is** the bytes rather than a pointer to them: as a struct
field it occupies its whole layout, and copying the struct copies the elements
with it. `FixedArray<u8, 8>` and `FixedArray<u8, 4>` are different types and tsc
says so; a bare pointer never becomes either, because it carries no length.

`T[]` — the same type as `Array<T>`, as in TypeScript — is a *handle* to
elements it owns, which is the whole difference: it can grow, copying one
allocates, and reaching an element is one indirection further down. Elements are
inline at their stride either way, so the bytes match what a C compiler produces.

Copying copies every element with **that element's** own copy operation, so a
`string[]` deep-copies its strings and an `i32[]` is a single `memcpy` — the same
rule that makes a struct holding a `string` work. An empty array holds no buffer
and allocates nothing, exactly as an empty `std::vector` does, and growth is
amortised so a loop of `push` is linear. Passing one by value copies the whole
buffer, which is `std::vector<T>` by value; `Reference<T[]>` is how you say not
to.

```console
$ bun test tests/vector.test.ts
 31 pass  0 fail
```

The third kind C has — a bare `T*` from `malloc` — is still to come: `Pointer<T>`
is declared and not yet a type you can write.

### Calling C

A function declared with no body is an `extern "C"` import, and its signature is
classified by the platform's rules on both halves of the call:

```ts
interface Pair { x: i32; y: i32; }

declare function c_sum(p: Pair): i32;
declare function c_make(x: i32, y: i32): Pair;

const mine: Pair = { x: 1, y: 2 };
const total: i32 = c_sum(mine);   // by value — `mine` is untouched
```

Inside a module an aggregate travels as the address of its storage. At the
boundary that would be wrong: a C function taking a `Pair` expects the struct,
packed into registers or copied onto the stack by rules that differ per
platform. So Win64 puts a 1-, 2-, 4- or 8-byte struct in one integer register
and everything else by address; System V splits up to sixteen bytes into
eightbytes and classifies each INTEGER or SSE.

The pair that catches a classification being backwards: `struct { float x, y; }`
goes to **one SSE register** under System V and to an integer register under
Win64, while `struct { int; float; }` goes to an integer register under both.
Neither mistake crashes — they produce wrong numbers.

```console
$ bun test tests/struct-abi.test.ts
 24 pass  0 fail
```

`tests/oracle/cabi/cabi.cpp` is a real `extern "C"` library built with the
platform's own C compiler. It decides the register assignment; this compiler has
to agree. CI runs the suite on Windows *and* Linux, and the Linux job is the
only thing that makes the System V half real — v1's was written from the psABI
and never executed.

### The C++ oracle

If the semantics are meant to be C++'s, then C++ is the oracle. Each case in
`tests/oracle/cases/` is written twice — once in Goblin, once in C++ — and both
print a trace of every allocation and release. The two traces have to be
identical:

```console
$ bun test tests/oracle.test.ts
 7 pass  0 fail
```

That covers scope exit order, copy on binding, temporaries at end-of-
full-expression, by-value parameters, and early return out of nested scopes. It
grows with every milestone after this one. Where Goblin is *meant* to differ,
the difference is written into the suite as a stated divergence, so every
intentional departure from C++ is checked rather than remembered.

The C++ side builds with CMake, which finds the compiler itself.

## Building it

```console
bun install
bun run build:backend     # generates the MIR bindings, then builds the addon
bun test
```

`build:backend` does two things in order, and the order matters: it regenerates
`packages/backend/js/mir.generated.ts` from the Rust MIR definitions, then
compiles the napi addon. Both halves of the boundary therefore always come from
the same source.

## The shape of it

```
  your build script (Bun/Node)
        │  import { compile } from "goblin-forge"
        ▼
  packages/forge      the build API, and lowering to MIR
  packages/checker    tsc: the program, its verdict, and type erasure
  packages/runtime    the language itself, as data: global.d.ts, tsconfig base
        │  one napi call, one buffer
        ▼
  packages/backend    the addon
  crates/goblin-mir       the MIR, defined once, in Rust
  crates/goblin-codegen   layout, Cranelift, linking
```

One process. v1 ran the frontend under Bun and the backend as a separate Rust
binary talking line-delimited JSON over stdio, with a wire contract "defined
twice and kept in step by hand". Here the MIR is defined once, in Rust, and the
TypeScript types *and their postcard encoder* are generated from it.

Generating the encoder as well as the types is the part that is easy to skip and
should not be. postcard is not self-describing: struct fields and enum variants
are positional, and no name ever reaches the wire. A hand-written encoder that
drifted by one field would not fail to decode — it would decode into a different,
entirely plausible module. Three things keep the halves honest:

- a wire-format fingerprint, baked into the generated TypeScript and checked on
  every decode;
- a Rust test asserting the checked-in bindings match what the generator would
  produce right now;
- a test that encodes in TypeScript, decodes in Rust, re-encodes in Rust, and
  requires byte equality.

## Two rules worth knowing before reading the code

**Ownership is written down, never inferred.** Every type has a category
(trivial, owning, polymorphic, borrow) computed once from the type. Every value
has a storage class (owned, inline, borrowed, temporary) that is a static
property of a place. Copy and move are separate nodes in the IR, chosen by the
frontend. Drops are placed by a pass from CFG liveness, not spliced in by the
lowerer. Every memory-corruption bug found in v1 was an instance of ownership
being a property of the program that was never written down, so it had to be
re-derived at every site — and one site always got missed.

**The backend never reports a user error.** Any failure reachable from source
that tsc accepted is a missing frontend check, and it panics rather than
returning politely, so a test cannot mistake a compiler crash for the compiler
correctly saying no. v1 let `someF64 % 2` reach Cranelift, which answered `Rem is
not defined on f64` — no code, no file, no line. That is now `GF0162`, with a
caret under the operator.

## Layout

| Path | What it is |
|---|---|
| `packages/forge` | `compile()`, and the AST-to-MIR lowerer |
| `packages/checker` | tsconfig loading and validation, the retained `ts.Program`, diagnostics, type erasure |
| `packages/runtime` | `global.d.ts` — the entire global surface — and the tsconfig base every project extends |
| `packages/backend` | the napi addon, the generated MIR bindings, and the MIR builder |
| `crates/goblin-mir` | the MIR, plus the generator that projects it into TypeScript |
| `crates/goblin-codegen` | layout and repr, Cranelift translation, object emission, linking |
| `tests/` | real source → real compiler → real binary → real output |
| `examples/hello` | a build script you can run |

## Licence

Apache License 2.0 — see [`LICENSE`](LICENSE).

[`NOTICE`](NOTICE) attributes the projects this is built on, and separates the
ones that end up *inside* a compiled program — Cranelift, `target-lexicon`, and
`libc` by way of the runtime — from the ones that only build or test the
compiler. That distinction is the one that matters if you ship what this
produces.

TypeScript is in the second list but does more than the others: `tsc` **is** the
type checker, not a dependency the compiler happens to use.

## Libraries and modules

A program is many files and one compilation. tsc resolves the imports and
type-checks them together, so there is no module-interface format to keep in
step — the question REWRITE-PLAN §11.8 left open, answered by deleting it.

```ts
// math.ts
export function add(a: i32, b: i32): i32 { return a + b; }

// main.ts
import { add } from "./math.ts";
```

Names are scoped to their modules: two files may each declare a private
`helper`, and both are right. Exported symbols keep their bare name — that is
the C ABI contract — while internal ones are qualified by a hash of the module's
path *relative to the project root*, so the same sources produce the same
symbols on two machines.

A library boundary is the C ABI plus a generated header:

```console
$ bun test tests/libraries.test.ts
 7 pass  0 fail
```

That suite builds a **real C program**, includes the emitted header, links it
against the Goblin archive and runs it. It found a crash on its first run: a
small struct arriving packed in registers had nowhere to be reassembled to,
because every aggregate parameter was assumed to be an address the caller owned.
Unreachable until C could call *into* Goblin — the caller's half of the same
classification is a different function, and `struct-abi.test.ts` only exercises
that one.
