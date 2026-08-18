# goblin-forge

**Write TypeScript. Get a native executable with C++'s value semantics.**

Objects are values, copying a class slices it, and a binding's scope destroys
what it holds. No garbage collector, no runtime, no JavaScript underneath — the
output is a normal native binary that links against libc and can be handed to
anyone.

```ts
// examples/hello/src/main.ts
function factorial(n: i32): i32 {
  let result: i32 = 1;
  let i: i32 = 2;
  while (i <= n) {
    result *= i;
    i++;
  }
  return result;
}

export function main(): i32 {
  return factorial(5);
}
```

```console
$ bun run examples/hello/build.ts
built .../examples/hello/bin/hello.exe
$ ./examples/hello/bin/hello.exe; echo $?
120
```

`tsc` is the type checker and its verdict is final. There is no second frontend,
no custom syntax and no compiler plugin, so a stock TypeScript toolchain reads
the same files this compiler does — your editor underlines what the compiler
will reject, while you type, with no extension installed.

> **Status: experimental.** The language is real and the test suite is large
> (660 tests, including programs checked against a C compiler and against
> equivalent C++), but this is a young project. Expect gaps — they are reported
> as diagnostics with a file and a line, never as a crash.

---

## Requirements

You need a working native toolchain, because this produces native code and
links it.

| | What | Why |
|---|---|---|
| **Bun** ≥ 1.3 | [bun.sh](https://bun.sh) | Runs the compiler frontend and the tests |
| **Rust** ≥ 1.88 | [rustup.rs](https://rustup.rs) | Builds the backend and the runtime library |
| **A C toolchain** | see below | Links the executables this produces |
| **CMake** ≥ 3.20 | [cmake.org](https://cmake.org) | Only for the test suite — builds the C and C++ programs it checks against |

### The C toolchain, per platform

- **Windows** — [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)
  with the "Desktop development with C++" workload. The compiler finds
  `link.exe` and `lib.exe` through the registry, so you do **not** need a
  Developer Command Prompt.
- **Linux** — `cc` and `ar`, plus a C++ compiler for the tests.
  `sudo apt install build-essential cmake` covers it on Debian and Ubuntu.
- **macOS** — the Xcode Command Line Tools: `xcode-select --install`. CMake
  separately, via `brew install cmake`.

Set `CC` if you want a specific compiler driver on Linux or macOS; the default
is `cc`.

## Getting started

```console
git clone <this repository>
cd goblin-forge
bun install
bun run build:backend     # generates the MIR bindings, then builds the addon
bun test                  # optional, but it is the fastest way to know it works
```

`build:backend` compiles a native addon, so the first run takes a few minutes.
Then build the example:

```console
bun run examples/hello/build.ts
./examples/hello/bin/hello        # .exe on Windows
```

### The single-file executable *(experimental)*

The whole compiler — the Bun runtime, the native backend, the prelude and the
runtime crate — builds into one binary:

```console
bun run build:cli         # produces bin/goblin-forge
```

Then a project needs nothing else installed:

```console
$ goblin-forge init
  .goblin/global.d.ts
  .goblin/tsconfig.base.json
  tsconfig.json
  build.ts
  src/main.ts

$ goblin-forge
built ./bin/app          # .exe on Windows
```

A build script *exports* what it wants built rather than calling the compiler:

```ts
// build.ts
export default {
  entry: "./src/main.ts",
  output: "./bin/app",
  type: "bin",
  optLevel: "speed",
};
```

Relative paths resolve against the script rather than the working directory, so
`goblin-forge path/to/build.ts` does the same thing from anywhere. A default
export that is a function works too, and is evaluated for its config.

`init` writes the prelude into `.goblin/` so your **editor** can read it —
tsserver reads the project's tsconfig and nothing else, so a prelude that lives
only inside the executable would leave `i32` underlined in red while the build
succeeds. When those files are present the compiler uses them rather than its
own copies, so the two cannot drift.

Two caveats while this is experimental. The binary is large (~110 MB — it
contains a JavaScript runtime), and it still needs **cargo and a linker on the
machine**, because it compiles and links native code. It removes the need to
install goblin-forge, not the need for a toolchain.

### Compiling your own program

Without the executable, the interface is a function: a build is a short script,
the options are an object, and a program that does not compile comes back as a
*result* rather than an exception.

```ts
// build.ts
import { compile, formatAll } from "goblin-forge";

const result = await compile({
  entry: "./src/main.ts",
  tsconfig: "./tsconfig.json",

  type: "bin",              // or "static-lib" / "shared-lib"
  output: "./bin/app",
  outDir: "./build",

  optLevel: "speed",        // "none" | "speed" | "size"
  debugInfo: true,

  // Relative paths resolve against this rather than the working directory, so
  // the script behaves the same wherever it is run from.
  root: import.meta.dir,
});

if (!result.ok) {
  console.error(formatAll(result.diagnostics, { color: true, cwd: import.meta.dir }));
  process.exit(1);
}
console.log(`built ${result.output}`);
```

Your `tsconfig.json` extends the base the language ships. That is what puts the
global surface in scope and takes the JavaScript standard library out of it —
without it, `Array.prototype.map` and the DOM reappear and your program
type-checks against a language this compiler does not implement.

```json
{
  "extends": "@goblin-forge/runtime/tsconfig.base.json",
  "files": [
    "node_modules/@goblin-forge/runtime/global.d.ts",
    "src/main.ts"
  ]
}
```

Both files listed explicitly, and `files` rather than `include`: the prelude has
to be in the program for the globals to resolve.

[`examples/hello`](examples/hello) is a working copy of all of this — its
`tsconfig.json` points at the prelude by relative path because it lives inside
this repository rather than installing the package.

---

## The language

A subset of TypeScript, with a machine model underneath it. Twelve fixed-width
numeric types, `boolean`, `string`, structs, fixed and growable arrays, classes
with single inheritance and virtual dispatch, dispatched interfaces, function
pointers, and a C boundary.

What follows is a tour of the parts that differ from TypeScript. Anything valid
TypeScript that this compiler cannot lower yet is a `GF0001` diagnostic with a
file and a line.

### Objects are values

The largest difference from TypeScript, and one tsc cannot warn about:

```ts
interface Point { x: i32; y: i32; }

const a: Point = { x: 1, y: 2 };
const b: Point = a;     // a copy, not an alias
b.x = 5;                // `a.x` is still 1
```

A nested aggregate is **inline** — a field of struct type occupies its own
layout inside the parent, not a pointer to it — so copying the outer value
copies the inner one with it. That is what C interop depends on, and it is
checked against a real C compiler rather than asserted: `tests/oracle/layout/`
declares ten shapes and compares what the C compiler decided about each one's
size, alignment and field offsets with what this compiler decided.

### Fixed-width numbers, and no silent conversions

```ts
const a: i32 = 1;
const b: u32 = 2;
const sum = a + b;          // GF0161: no common type. C makes this u32 and
                            // turns negative values into very large ones.

const wide: i32 = 1000;
const narrow: i8 = wide * 2;  // GF0160: the truncation is invisible at the
                              // point it costs you. Write cast<i8>(…).

const bits: i8 = 0xff;      // fine — -1, because that is how anybody writes
const same: i8 = 255;       // GF0164 — but this is not a bit pattern.

const value: u8 = 200;
const shifted: u8 = value << 1;   // 144. A shift keeps the value's type; the
                                  // count is converted to it, not promoted.
```

`i32 + u32` and `i64 + f64` are both errors, and it is the same rule twice: a
type promotes to another exactly when *every* value of it is exactly
representable there. Neither pair qualifies — and `i64` to `f64` is the one
people do not expect, because `f64` is exact only to 2^53.

### Strings own their memory, and scopes release it

```ts
const a = "hello, " + name;   // allocates
const b = a;                  // a copy — allocates again
const c = move(a);            // a move — no allocation; `a` is dead afterwards
console.log(a);               // GF0235: `a` was moved from
// b and c are released here, in reverse order of construction
```

Nobody writes a destructor; there is no syntax for one. A value is released
because its *type* says it owns something. Every test in the suite asserts the
live allocation count is zero when the program exits, automatically.

The allocator underneath all of it is **mimalloc**, statically linked into every
program. It is also published under its own C names — `mi_malloc`, `mi_free` and
six more — so a library that lets its allocator be replaced can be handed the
program's own heap instead of running a second one beside it:

```ts
SDL_SetMemoryFunctions(mi_malloc, mi_calloc, mi_realloc, mi_free);
```

[`LINKING.md`](LINKING.md) has the rules that come with that.

A program is one self-contained file, runtime included. The exception is opt-in
and exists for exactly one situation — a Goblin `shared-lib` loaded by a Goblin
`bin`, where two private runtimes would mean two heaps:

```ts
export default { entry: "./src/main.ts", output: "./bin/app", runtime: "shared" };
```

Both artefacts then share one runtime, one heap and one allocation counter, at
the cost of a runtime library shipped beside them.

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

That last pair of lines is C++'s object model in miniature. `a` gets `Animal`'s
fields *and* `Animal`'s vtable; `sound` is not copied, because there is nowhere
in an `Animal` to put it. Polymorphism travels through `Reference<T>`, never
through values.

Getters and setters work as they do in TypeScript, and dispatch as methods do —
`override get` is reached through a base reference:

```ts
class Animal {
  protected _name: string;
  constructor(name: string) { this._name = name; }
  get name(): string { return this._name; }
}
```

`static` methods are free functions in a namespace: no receiver, no vtable slot,
and therefore usable as a function pointer where an instance method is not.

### On the heap

`new C(…)` gives a value its scope releases. `alloc` gives a pointer that
outlives the scope — and leaks if you drop it, exactly as in C++:

```ts
const r = alloc(Rect, 6, 7);   // Pointer<Rect>, constructed
console.log(`${r.area()}`);    // dereferences, like C++'s `->`
r.free();                      // yours to call, and nobody calls it for you

const p = alloc<Point>();      // Pointer<Point>, zeroed
p.x = 3;
p.free();

const q: Pointer<Animal> = alloc(Dog, "Heapy");
q.speak();                     // the derived override
q.free();                      // and the derived destructor
```

Two spellings, **one operation**. Naming a class runs its constructor; naming a
type does not, because there is none to run — but the storage is
default-initialised either way. There is deliberately no uninitialised form, for
the same reason `fixedArray` has none: `free()` destroys what the storage holds,
and on uninitialised memory that is a garbage pointer.

`free` dispatches destruction through the vtable, so releasing a `Dog` through a
`Pointer<Animal>` still releases what only a `Dog` has. That is the one place
destruction has to be virtual: everywhere else the compiler destroys a value
whose storage was laid out for exactly its static type.

`p[0]` is C's `*p`, so a pointer to a scalar reads and writes without any
dereference intrinsic. Every member `Pointer<T>` has — `free`, `address`,
`deref`, `offset`, `erase`, `reify`, `freeArray` — is **reserved on every
class**: `Pointer<C>` is `C` and the pointer's members together, so a class
declaring `free` would have one nothing could reach through a pointer. tsc
cannot see that, so the compiler refuses it at the declaration.

`Pointer<unknown>` is C's `void *`, for the C signatures that need one. Any
pointer converts to one implicitly, `reify<T>()` gets a type back, and
everything that would read through it in between is refused — including
`free()`, which has no type to run a destructor from and would leak whatever the
value owned. [`LINKING.md`](LINKING.md) has the details.

`sizeOf<T>()` and `alignOf<T>()` answer from the same layout engine
the backend uses.

### Interfaces come in two kinds, and the syntax says which

```ts
interface Speaker { speak(): string; }        // a contract — dispatched
interface Point   { x: i32; y: i32; }         // a shape — a plain struct

class Dog   { name: string;  speak(): string { return `${this.name} says woof`; } }
class Robot { id: i32;       speak(): string { return `unit ${this.id} reporting`; } }

function announce(who: Reference<Speaker>): void {
  console.log(who.speak());
}
```

`Dog` and `Robot` share no base class, so no vtable layout could serve both. A
`Reference<Speaker>` is a two-word `(itab, data)` pair; dispatch is two loads
and an indirect call.

Neither class writes `implements` — **conversion is structural**, exactly as in
TypeScript. Writing `implements` additionally makes the class findable by a
*dynamic* cast:

```ts
const s = tryCast<Speaker>(animal);
if (s !== null) { console.log(s.speak()); }
```

The `| null` is the design rather than a detail: `strictNullChecks` rejects
`tryCast<Speaker>(a).speak()`, so the check is the only way to reach the value.

| Written | Is |
|---|---|
| `feed(): void` — a method signature | a **contract**: dispatched, no layout, held as `Reference<I>` |
| `feed: () => void` — a function-typed property | a **shape**: an ordinary function-pointer field |

TypeScript already treats these two differently, and so does JavaScript — a
method goes on the prototype, a property lives on the instance. Drawing the line
there keeps C's struct-of-callbacks a plain struct.

### Arrays come in two kinds

```ts
// inline — no allocation, length in the type
const buf: FixedArray<u8, 128> = fixedArray(128, 0);
buf[0] = 1;

// owning and growable — this language's std::vector
const xs: i32[] = [1, 2, 3];
xs.push(4);
const ys = xs;          // a copy: a second buffer, not a second name
const last = xs.pop();
```

A `FixedArray<T, N>` **is** the bytes rather than a pointer to them, so as a
struct field it occupies its whole layout. `T[]` — the same type as `Array<T>` —
is a handle to elements it owns, so it can grow and copying one allocates.

Copying copies every element with **that element's** own copy operation: a
`string[]` deep-copies its strings, an `i32[]` is a single `memcpy`. An empty
array holds no buffer and allocates nothing, and growth is amortised.
`Reference<T[]>` is how you pass one without copying the buffer.

### Functions are values, if they capture nothing

```ts
function add(a: i32, b: i32): i32 { return a + b; }
class Math2 { static triple(a: i32): i32 { return a * 3; } }

const f: (a: i32, b: i32) => i32 = add;   // a code address, one machine word
export function apply(g: (a: i32) => i32, x: i32): i32 { return g(x); }
apply(Math2.triple, 14);                  // 42
```

A function pointer is always classified by the C rules, so it can cross to C in
either direction. A `static` method is what a callback written inside a class
looks like — an *instance* method needs a receiver and a function pointer has
nowhere to put one.

**There are no closures yet.** `(a) => a * n` is a `GF0001`.

### Calling C

A function declared with no body is an `extern "C"` import:

```ts
interface Pair { x: i32; y: i32; }

declare function c_sum(p: Pair): i32;

const mine: Pair = { x: 1, y: 2 };
const total: i32 = c_sum(mine);   // by value — `mine` is untouched
```

The signature is classified by the platform's own rules on both halves of the
call — Win64 puts a 1-, 2-, 4- or 8-byte struct in one integer register and
everything else by address; System V splits up to sixteen bytes into eightbytes
and classifies each INTEGER or SSE. The suite checks this against a real
`extern "C"` library built by the platform's own C compiler, on Windows *and* on
Linux.

Building a library instead of an executable emits a C header alongside it, so a
C program can `#include` it and link the archive.

[`LINKING.md`](LINKING.md) is the practical half: which linker actually runs,
how to put a C library on the link line, what `nativeLibs` does and does not
accept, and what a consumer of a Goblin `static-lib` has to link alongside it.

### Modules

A program is many files and one compilation. tsc resolves the imports and
type-checks them together, so there is no module-interface format to keep in
step.

```ts
// math.ts
export function add(a: i32, b: i32): i32 { return a + b; }

// main.ts
import { add } from "./math.ts";
```

Names are scoped to their modules: two files may each declare a private
`helper`, and both are right. Exported symbols keep their bare name — that is
the C ABI contract — while internal ones are qualified by a hash of the module
path relative to the project root, so the same sources produce the same symbols
on two machines.

### Not there yet

`String.substring`/`indexOf`/`codePointAt`, closures, generics, `switch`,
`do`/`while`, `for…of`, exceptions, static fields, top-level statements and
top-level `const`.

All of them are declared or valid TypeScript, and all of them produce a
`GF0001` diagnostic naming the construct and pointing at it.

---

## How it fits together

```
  your build script (Bun/Node)
        │  import { compile } from "goblin-forge"
        ▼
  packages/forge      the build API, and lowering to MIR
  packages/checker    tsc: the program, its verdict, and type erasure
  packages/runtime    the language as data: global.d.ts, tsconfig base, runtime lib
        │  one napi call, one buffer
        ▼
  packages/backend    the native addon
  crates/goblin-mir       the MIR, defined once, in Rust
  crates/goblin-codegen   layout, Cranelift, linking
```

One process. The MIR is defined once, in Rust, and the TypeScript types *and*
their binary encoder are generated from it, so the two halves of the boundary
cannot drift.

| Path | What it is |
|---|---|
| `packages/forge` | `compile()`, and the AST-to-MIR lowerer |
| `packages/checker` | tsconfig loading, the retained `ts.Program`, diagnostics, type erasure |
| `packages/runtime` | `global.d.ts`, the tsconfig base, and the native runtime library |
| `packages/backend` | the napi addon, the generated MIR bindings, and the MIR builder |
| `crates/goblin-mir` | the MIR, plus the generator that projects it into TypeScript |
| `crates/goblin-codegen` | layout and repr, Cranelift translation, object emission, linking |
| `tests/` | real source → real compiler → real binary → real output |
| `examples/hello` | a build script you can run |

## Testing

```console
bun test                              # everything
bun test tests/vector.test.ts         # one suite
```

Every test compiles real source with the real compiler, runs the real binary and
asserts on what the program actually did. Three suites check the compiler
against other toolchains rather than against expectations:

| Suite | Checked against |
|---|---|
| `tests/oracle.test.ts` | equivalent C++ programs — allocation traces must match |
| `tests/struct-abi.test.ts` | a real `extern "C"` library built by the platform's C compiler |
| `tests/libraries.test.ts` | a real C program that includes the emitted header and links the archive |

CMake is only needed for these; the rest of the suite runs without it.

## Contributing

[`CLAUDE.md`](CLAUDE.md) describes how the compiler is put together and which
mistakes its structure exists to prevent — read it before changing behaviour.
[`REWRITE-PLAN.md`](REWRITE-PLAN.md) is the design document, and
[`DECISIONS.md`](DECISIONS.md) records the questions it left open, as they are
answered.

## Licence

Apache License 2.0 — see [`LICENSE`](LICENSE).

[`NOTICE`](NOTICE) attributes the projects this is built on, and separates the
ones that end up *inside* a compiled program — Cranelift, `target-lexicon`, and
`libc` and mimalloc by way of the runtime — from the ones that only build or
test the compiler. That distinction is the one that matters if you ship what this
produces.
