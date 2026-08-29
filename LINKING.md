# Linking against C libraries

How a Goblin program reaches C, how C reaches back, and what the linker is
actually doing while it happens.

Every recipe and every caveat below was **run on Linux**, including the ones
that fail — the failure messages are transcripts, not reconstructions. The
Windows and macOS rows come from the source and from the suite that covers
them, not from a machine sitting here, so treat those as read rather than
witnessed.

---

## What actually runs

There is no bundled linker and no attempt to write one. The system linker does
the job, and `crates/goblin-codegen/src/link.rs` contributes only *finding* it
and assembling an argument list that is right on the first try.

| | Executables and shared libraries | Static libraries |
|---|---|---|
| Linux, macOS, BSD | `cc` — or `$CC` if set | `ar` — or `$AR` if set |
| Windows (MSVC) | `link.exe` | `lib.exe` |

On Unix the platform *C compiler* is driven rather than `ld` directly, because
it is the thing that knows where the CRT startup files live. On MSVC the tools
are found through the same registry probing `cc` uses for build scripts, so a
Developer Command Prompt is not required.

**A static library is archived, not linked.** Nothing is resolved, nothing is
discarded, and no runtime is pulled in. That is deliberate: two Goblin static
libraries in one program must not each carry a copy of `gf_string_free`. The
final executable link is what supplies the runtime, once.

### The command it builds

For an executable on Linux, in this order:

```console
cc  main.o                       # your objects
    yourlib.a                    # everything in `nativeLibs`, in your order
    libgoblin_runtime.a          # the Goblin runtime
    -lgcc_s -lutil -lrt -lpthread -lm -ldl -lc
    -o app
```

**The order is the ABI of a static link.** GNU `ld` resolves left to right and
only looks forward, so a dependency must come *after* whatever needs it. Your
archives land before the runtime and the system libraries, which is right for
the common case — your library needs libc, libc needs nothing. If one of your
archives needs a symbol from another, order them yourself inside `nativeLibs`.

The system library list is not hardcoded. It comes from
`rustc --print native-static-libs` on the runtime crate, because a hardcoded
list is right on the day it is written and rots at the next toolchain bump —
and the failure is an unresolved symbol from inside the Rust standard library
that means nothing to whoever hits it.

---

## Calling C from Goblin

### Declaring the function

A function with **no body** is an `extern "C"` import:

```ts
declare function mylib_triple(x: i32): i32;

export function main(): i32 {
  console.log(`${mylib_triple(14)}`);
  return 0;
}
```

**The name is the C symbol, spelled exactly.** There is no mangling, no prefix
and no lookup table — which also means a typo is not a compile error. It
compiles cleanly and fails at the link:

```
error[GF9005]: linking failed:
  cc … -o app

/usr/bin/ld: main.o: in function `main':
main:(.text+0x77): undefined reference to `mylib_tripel'
```

This is the single most common surprise. `GF9005` carries the exact command, so
the failure can be reproduced by hand.

### What is allowed to cross

An import, and the **entry module's** exports, are classified by the platform's
C rules — Win64 or System V — so both sides agree about registers, stack slots
and hidden return pointers without either being told. Sub-register-width
integers carry `zeroext`/`signext`, because a C callee is entitled to use the
whole register without masking first.

**Only the entry module's exports are a boundary.** `export` is TypeScript's
word for *importable*, and a program is one compilation, so an exported function
another Goblin module calls is an ordinary internal call — free to take a
`string`, a class, anything. What a `static-lib` publishes, what the header
declares and what a DLL names is the entry module's surface, and only that is
restricted.

What may cross is **plain data**: the fixed widths, `boolean`, a struct of
those, a `FixedArray` of those, `Pointer<T>` — and `string`, which is a special
case worth its own section below. Structs are passed by value under the
platform's own rules: `{ float, float }` travels in one SSE register on System
V, and one *integer* register on Win64.

What may not is anything whose bytes are not the whole of its value, and the
refusal is `GF0301` with a caret under the offending parameter:

| Refused | Why | Pass instead |
|---|---|---|
| `T[]` | owns a buffer whose element layout nothing outside this build knows | `Pointer<T>` and a length |
| a class | carries a vtable pointer into *this build's* read-only data | its fields, or a `Pointer<T>` |
| `Reference<I>` | a pair of pointers into this build's own tables | — |
| a struct with a `string` field | the question of who frees it is buried where no doc comment can answer it | pass the `string` as its own parameter |
| a `FixedArray` of owning elements | same | — |

**A callback is checked one level in.** A function pointer is only a word, so it
would otherwise sail through carrying a signature nothing outside this build can
call; its parameters and return are checked as boundary types too.

### Strings cross, and this is the surprising part

`string` is deliberately *not* on the refused list. The runtime lays one out as
nul-terminated bytes on purpose, so C reads one as a `const char *` with no
conversion at all. Ownership becomes the documented, manual thing it is in every
C API that hands out memory.

When a `string` crosses, the generated header carries the type and the three
functions that operate on it:

```c
typedef const char* GoblinString;

GoblinString gf_string_from_cstr(const char* bytes);
GoblinString gf_string_clone(GoblinString s);
void gf_string_free(GoblinString s);

GoblinString greet(GoblinString p0);
```

The header's own comment is worth repeating, because it is the trap:

- **Reading one is free.** `printf`, `strlen` and every other `const char *`
  reader work unchanged.
- **Making one is not.** A length header sits *sixteen bytes behind* the
  pointer, so a plain C string is not a `GoblinString` — passing one reads a
  length out of whatever precedes your literal. Use `gf_string_from_cstr`,
  which copies. The typedef is a warning label, not a safety net.
- **Freeing one is `gf_string_free`, never `free`**, because the allocation
  starts at the header rather than at the pointer you were handed.

Which strings the caller owns is your library's business to document, exactly as
it is for any C API.

### `CString`, going the other way

`CString` is the borrowed half of the pair, for calling *into* C. `cstring(s)`
borrows a `string`'s bytes for as long as `s` lives; `cstring(move(s))` hands
them over for good.

A `CString` is **never** released by the scope holding it, and there is
deliberately no `.free()` method — there would be no right answer for it. The
two real shapes:

```ts
declare function getenv(name: CString): CString | null;   // library-owned, do NOT free
declare function strdup(source: CString): CString | null; // yours, freed with ITS free
declare function free(mem: CString): void;

export function main(): i32 {
  const path = getenv(cstring("PATH"));
  if (path !== null) { console.log("PATH is set"); }

  const copy = strdup(cstring("borrowed then owned"));
  if (copy !== null) { free(copy); }
  return 0;
}
```

Use `cstringFree` **only** on a `CString` that came from `cstring(move(…))` —
same sixteen-byte header, so handing it anything else is not a leak, it is
memory corruption.

### Bytes coming back: `stringFromBytes` and `stringFromCString`

Both copy raw bytes into an owned `string`, and which one to reach for is
decided by what the C call gave you:

```ts
// A pointer and a length, in the same call — the usual shape.
const size: FixedArray<usize, 1> = fixedArray(1, 0);
const data = SDL_LoadFile_IO(io, size, false);
if (data !== null) {
  console.log(stringFromBytes(data.reify<u8>(), size[0]));
  SDL_free(data);                       // SDL allocated it; SDL releases it
}

// Only a pointer, with the terminator as the only end marker.
console.log(stringFromCString(SDL_GetError()));
```

**Prefer the length whenever you have one.** `stringFromCString` scans for a
NUL, which is a second pass over bytes something already counted — and for file
contents it is the *wrong* answer rather than a slow one, because a zero byte
anywhere in the data ends the string there. Both take a `CString`, a
`Pointer<u8>`, or a fixed array of bytes, which decays like any other.

The copy is the point: what comes back is a `string` that its scope releases,
and the source buffer is untouched and still belongs to whoever allocated it.
That is also the one to watch — a buffer a C library handed you is a leak until
you call *that library's* deallocator on it, and Goblin's live-allocation report
cannot see it, because the allocation was never Goblin's.

### Opaque handles — `FILE *`, and every library like it

Most C libraries hand back a pointer to a struct you are never meant to look
inside. Declare the type with `declare class` and a private member, exactly as
the prelude's pointer commentary describes:

```ts
declare class FILE { private _opaque: never }

declare function fopen(path: CString, mode: CString): Pointer<FILE> | null;
declare function fputs(text: CString, stream: Pointer<FILE>): i32;
declare function fclose(stream: Pointer<FILE>): i32;

export function main(): i32 {
  const f = fopen(cstring("/tmp/out.txt"), cstring("w"));
  if (f === null) { console.log("open failed"); return 1; }
  fputs(cstring("through FILE*"), f);
  fclose(f);
  return 0;
}
```

`declare` is the whole rule: it says the implementation lives somewhere else,
and for a class that means the *layout* does too. So `FILE` is C's incomplete
type — no size, no fields, no value form — and the only thing that travels is
the pointer.

**`private _opaque: never` is tsc's half.** It makes the class *nominal*, so
two handles declared the same way are still different types and one cannot be
passed where the other belongs. The compiler never reads the member; it is
there so your editor underlines the mistake while you type. The name is
conventional — any private member does the job.

**`Pointer<T> | null` works**, and the null check is the only way to reach the
value, so a failed `fopen` cannot be used by accident.

**Everything that would need the layout is refused**, with a code and a line:

```
error[GF0302]: `FILE` is declared elsewhere, so this build does not know its size
               or its alignment, and `offset` needs both.
```

That covers `p[i]`, `p.offset(n)`, `p.deref()`, `p.free()`, `p.freeArray()`,
`alloc`, `allocArray`, `sizeOf`, `alignOf`, and holding one by value anywhere —
a parameter, a return, a struct field, an array element. `p.address` is the one
member that still works, because it is the one that never needed a size.

None of those refusals is optional politeness. A type with no layout does not
refuse them on its own: the obvious stand-ins for "no layout" — a zero-field
struct, a `void` pointee — have a size of zero and an alignment of one, so
`p[i]` strides by nothing and `free` hands the allocator a size of zero. That is
a corrupt heap rather than a diagnostic, and `POINTER-ERASURE.md` is the long
version of why.

**In a library you publish**, the generated header forward-declares the handle
and leaves it incomplete, which is what C does for its own:

```c
/* Handles this library passes through but does not define. */
struct FILE;

struct FILE* passThrough(struct FILE* p0);
```

`Pointer<u8>` also works as a handle and is shorter, but then every handle in
the program is the same type and nothing catches a `FILE *` passed where a
`DIR *` was meant. Prefer the `declare class`.

### `void *` and `const void *` — `Pointer<unknown>`

The other pointer C hands out with nothing attached. Where an opaque handle says
"a `FILE`, whose insides are not your business", a `void *` says nothing at all
— and both spellings of it, `void *` and `const void *`, are `Pointer<unknown>`:

```ts
declare function memcpy(dst: Pointer<unknown>, src: Pointer<unknown>, n: usize): Pointer<unknown>;
declare function SDL_SetEventFilter(filter: SDL_EventFilter, userdata: Pointer<unknown>): void;

type SDL_EventFilter = (userdata: Pointer<unknown>, event: Pointer<SDL_Event>) => boolean;
```

There is no `const` in this language, so the two C spellings are one type here.
That is truthful rather than lossy — they are the same machine type and the same
ABI, and const-ness at a C boundary is documentation on both sides of it.

**Passing one costs nothing to write.** Any pointer converts to a
`Pointer<unknown>` implicitly, exactly as `T *` converts to `void *` in C:

```ts
const pixels = allocArray<u32>(width * height);
memcpy(pixels, source, width * height * sizeOf<u32>());   // no conversion written
```

**A `FixedArray` decays, exactly as C's array does.** Where C writes
`char buf[1024]` and passes it, so does this — to a `Pointer<u8>`, to a
`Pointer<unknown>`, and to nothing else:

```ts
const buf: FixedArray<u8, 1024> = fixedArray(1024, 0);
const written: usize = fwrite(buf, 1, 3, f);
```

The one rule that is not C's: a pointer to a *temporary* array may be passed as
an argument, because the call finishes before the temporary does, but it may not
be bound to a name that would outlive it (`GF0234`).

**`null` is C's NULL**, and it is a value rather than only a type. Declare a
parameter `Pointer<T> | null` wherever the C header accepts NULL and a return
`Pointer<T> | null` wherever it can fail — the first costs a caller nothing, and
the second is what makes tsc insist on the check:

```ts
declare function SDL_CreateWindow(title: CString, w: i32, h: i32, flags: u64): Pointer<SDL_Window> | null;
declare function SDL_RenderTexture(r: Pointer<SDL_Renderer>, t: Pointer<SDL_Texture>,
                                   src: Pointer<SDL_FRect> | null,
                                   dst: Pointer<SDL_FRect> | null): boolean;

const window = SDL_CreateWindow(cstring("goblin"), 1280, 720, 0);
if (window === null) { return 1; }        // tsc will not let you skip this
SDL_RenderTexture(renderer, texture, null, null);
```

`| null` costs no representation: it erases to the same machine word, so the
nullability is tsc's view of the program and the check is a comparison against
zero. Only the borrowed handles have a null — `Pointer<T>`, `CString` and a
function pointer. A `string` or a `T[]` owns its buffer and has none
(`GF0237`).

**Getting a type back is `reify<T>()`**, and it is on your honour — this is the
one direction that can be wrong, so it is the one you write:

```ts
const state = userdata.reify<GameState>();
console.log(`${state.score}`);
```

Between the two, an erased pointer can be passed, returned, stored, compared,
checked against null, and asked for its `.address`. Everything that would read
through it is refused with `GF0305`, for the same reason and by the same check
as the opaque handle's `GF0302`: `p[i]`, `p.offset(n)`, `p.deref()`, `p.free()`
and `p.freeArray()`, plus `alloc` and `allocArray` at that type.

`p.free()` is the one that matters most, and the reason is the destructor rather
than the storage. `gf_free` takes a pointer and nothing else — mimalloc is asked
what a block was — so the bytes would go back correctly; what cannot happen is
running a destructor from a type that was thrown away, so whatever the value
owned is leaked without a word. C++ makes `delete (void *)p` undefined for
exactly this reason. Reify it first, or free it through whatever allocated it.

**`char **` is `Pointer<CString>`**, and the NULL terminator is an ordinary
null check on the element:

```ts
declare function SDL_GetEnvironmentVariables(env: Pointer<SDL_Environment>): Pointer<CString> | null;

const vars = SDL_GetEnvironmentVariables(env);
if (vars !== null) {
  let i: usize = 0;
  let entry: CString = vars[0];
  while (entry !== null) {
    console.log(stringFromCString(entry));
    i = i + 1;
    entry = vars[i];
  }
  SDL_free(vars);          // "a single allocation", as the SDL docs say
}
```

Prefer `Pointer<CString>` to `Pointer<Pointer<u8>>` for this. Both read
correctly, but the second cannot be *written* through: `Pointer<Pointer<u8>>`
is an intersection whose two index signatures merge into a type nothing
produces, so `cells[i] = p` is a tsc error.

**`void **` is an ordinary pointer to an erased one** —
`Pointer<Pointer<unknown>>` — which is the shape of every C out-parameter that
hands back a buffer. The outer pointer's pointee is one word and has a layout,
so indexing through it works where indexing the erased pointer does not:

```ts
declare function SDL_LockTexture(
  texture: Pointer<SDL_Texture>,
  rect: Pointer<SDL_Rect>,
  pixels: Pointer<Pointer<unknown>>,
  pitch: Pointer<i32>,
): boolean;

const slot = allocArray<Pointer<unknown>>(1);
const pitch = alloc<i32>();
SDL_LockTexture(texture, rect, slot, pitch);
const rows = slot[0].reify<u32>();
```

**Reifying a pointer that never lost its type is refused** (`GF0306`). There is
deliberately no unchecked cast between two concrete pointee types, so
reinterpreting one as another is written out — `p.erase().reify<Other>()` — and
is visible where it happens. `erase()` is also there for the rare spot with no
`void *` context to convert into.

**In a library you publish**, a `Pointer<unknown>` crosses as a plain `void*`:

```c
void stash(void** p0, void* p1);
uintptr_t addressOf(void* p0);
```

### The C standard library is already linked

It needs no configuration at all. `cc` links libc, and the runtime already
drags in `-lm -lpthread -ldl` and the rest of the list above, so `sqrt` works
with nothing more than a declaration:

```ts
declare function sqrt(x: f64): f64;
```

One portability note: **`strdup` is POSIX, `_strdup` is the MSVC spelling.**
A `declare` names the symbol exactly, so cross-platform code has to pick.

### Sharing the heap with a library that lets you

Every Goblin program allocates through **mimalloc**: `new`, `alloc`, a `string`,
a `T[]`, all of it. A C library you link brings its own `malloc` — usually the
platform CRT's — so a program that talks to one is running two allocators over
one address space, each with its own free lists and its own idea of which pages
are warm.

Many libraries let you replace theirs, and the prelude publishes mimalloc under
its own C names so you can hand them the program's:

```ts
import { mi_calloc, mi_free, mi_malloc, mi_realloc } from "std/alloc";

declare function SDL_SetMemoryFunctions(
  malloc_fn: (size: usize) => Pointer<unknown> | null,
  calloc_fn: (count: usize, size: usize) => Pointer<unknown> | null,
  realloc_fn: (mem: Pointer<unknown> | null, size: usize) => Pointer<unknown> | null,
  free_fn: (mem: Pointer<unknown> | null) => void,
): boolean;

export function main(): i32 {
  SDL_SetMemoryFunctions(mi_malloc, mi_calloc, mi_realloc, mi_free);
  // … SDL_Init and the rest
  return 0;
}
```

The signatures match C's `malloc`, `calloc`, `realloc` and `free` exactly, which
is the point — there is no shim and no wrapper, only four addresses. Eight
functions are declared in all: those four, plus `mi_zalloc`,
`mi_malloc_aligned`, `mi_realloc_aligned` and `mi_usable_size`.

Five things to know:

- **They are imported, not global.** `"std/alloc"` is an ambient module — it
  resolves to no file, so there is no package to install and no path to
  configure, and the declaration in the prelude is the whole of it. These eight
  are the only names in the language that arrive this way; a program that
  forgets the import is told so by tsc, as `TS2304`.

- **Write the parameter types exactly as above.** A function pointer is checked
  one level in, so a `(size: usize) => Pointer<unknown>` that drops the `| null`
  is a different type and is refused — by tsc, as an ordinary assignability
  failure. A `malloc` that cannot fail is a claim C does not make.
- **Tell the library before it allocates.** SDL wants this before `SDL_Init`.
  Memory the library took from its own allocator *before* the swap must still go
  back to that one; passing it to `mi_free` afterwards is heap corruption rather
  than a leak.
- **A block from `mi_malloc` is not a Goblin value.** Nothing constructs into
  it, nothing destroys out of it, no scope releases it, and it is not counted by
  the live-allocation check — which counts what the *runtime* handed out and is
  owed back. `alloc<T>()` is what you want for a `T`.
- **This is not `malloc` interposition.** Nothing is overridden and no redirect
  DLL is involved; a library that does not offer a hook keeps its own allocator,
  and that is fine. The machinery for taking over unqualified `malloc()` calls
  is deliberately not enabled.

#### The allocator is not built at your optimisation level

`optLevel` is a claim about *your* code. The runtime is built at the same level
— it is compiled for your target, so it has to be built somewhere — but
**mimalloc is pinned**, in `packages/runtime/native/Cargo.toml`, and that is
not tidiness.

`cc` turns cargo's `OPT_LEVEL` into a flag for mimalloc's C, and on MSVC levels
`1`, `s` and `z` all become `/O1`. mimalloc built that way returns blocks that
fault when they are touched: a C library given these callbacks died on its third
allocation at those three levels and was clean at `0`, `2` and `3`.

It was invisible from inside the language, which is why it lasted. A Goblin
program that allocates heavily is fine at every level — the allocations have to
arrive through the exported `gf_mi_*` trampolines, *from a caller that is not
us*, before anything goes wrong. `tests/allocator-boundary.test.ts` is a real C
library doing exactly that at all six levels, and it fails at three of them if
the pin is removed.

### Two Goblin artefacts in one process: `runtime: "shared"`

Everything above assumes one Goblin artefact. Two in the same process — a Goblin
`shared-lib` loaded by a Goblin `bin` — is the case static linking cannot serve,
because each artefact carries its own copy of the runtime and therefore its own
mimalloc, its own live-allocation counter, and its own `gf_string_free`. A
`string` allocated inside the library and released by the scope that holds it in
the executable is then a free against a heap that never allocated it.

The build option is the answer:

```ts
// build.ts — for *both* artefacts
export default {
  entry: "./src/main.ts",
  output: "./bin/app",
  type: "bin",
  runtime: "shared",     // default is "static"
};
```

Linked this way both artefacts import one runtime, so there is one heap, one
counter and one `gf_string_free`. The compiler copies the runtime beside each
output and tells you where it put it:

```console
$ goblin-forge
built /project/bin/app.exe
  with /project/bin/goblin_runtime.dll, which has to stay beside it
```

That file is the cost. `"static"` remains the default and remains the right
answer for a single program: the runtime is inside the binary and there is one
file to ship. This is `/MD` against `/MT`, and it is the same trade — take the
extra file only when something else in the process needs the same heap.

A `static-lib` is unaffected either way. An archive is not a link, so it carries
only its own objects and its consumer supplies the runtime once, at the
executable.

### What a consumer of a `shared-lib` links

A DLL exports nothing it is not told to, and what it is told now includes the
runtime functions its own header declares. When a `string` crosses the boundary
the header declares `gf_string_from_cstr`, `gf_string_clone` and
`gf_string_free` — and the library publishes exactly those three, because the
export list and the header are generated from one list. A library whose
boundary never mentions a `string` publishes none of them and declares none.

What the consumer links depends on how the library was built, and the header
says which case it is in its banner:

| Library | Consumer links | And must not link |
|---|---|---|
| `static-lib` | the archive, **and** the Goblin runtime archive | — |
| `shared-lib`, `runtime: "static"` | its import stub, and nothing else | the runtime archive — that is a second copy |
| `shared-lib`, `runtime: "shared"` | its import stub **and** `goblin_runtime`'s | the runtime archive |

The middle row is the one to be careful with. The runtime is inside the DLL, so
adding the runtime archive to the consumer's link line puts a second copy in the
program — a second heap and a second allocation counter, which is the same fault
as two Goblin artefacts each carrying their own, arrived at from the other side.
It is a link line that succeeds, so nothing tells you but the behaviour.

Everything the bottom row needs is produced beside the library, so a consumer
never has to reach into the compiler's cache: on Windows that is four files —
`app.dll` and `app.lib` for this library, `goblin_runtime.dll` and
`goblin_runtime.dll.lib` for the runtime. The build names the last two on the
way out. On ELF and Mach-O the shared object is linked against directly, so
there is no separate stub and no fourth file.

### Adding your own library

`nativeLibs` takes **paths**, resolved against the build script's directory —
not the working directory, so the build works from anywhere:

```ts
// build.ts
export default {
  entry: "./src/main.ts",
  output: "./bin/app",
  type: "bin",
  nativeLibs: ["../vendor/libmylib.a"],
};
```

A static `.a` (or `.lib`) is the case with no surprises. It is copied into the
link line and resolved like any other archive.

### Shared objects, and the two ways they bite

A `.so` may be passed the same way and it will link — but what the loader does
afterwards depends on something the file itself carries.

**If the `.so` has no SONAME**, the linker records the path you gave it. Pass an
absolute path and that absolute path is baked into the binary:

```console
$ ldd bin/app
  /home/you/scratch/libmylib.so (0x00007f...)     # your build machine's layout
```

It runs on your machine and nowhere else.

**If the `.so` has a SONAME**, the linker records the *soname* instead, and the
binary will not start until the loader can find it:

```console
$ ./bin/app
  error while loading shared libraries: libmylib.so.1: cannot open shared object
  file: No such file or directory
```

goblin-forge has no `-rpath` hook, so the remedy is the loader's own:
`LD_LIBRARY_PATH`, an `ldconfig` directory, or installing the library properly.

```console
$ LD_LIBRARY_PATH=/path/to/lib ./bin/app
45
```

**Prefer static archives** unless you have a reason not to. Neither failure
above can happen to a `.a`.

---

## The escape hatch, and why you need one

`nativeLibs` entries are treated as filesystem paths and resolved. There is
**no `-l`, no `-L` and no `-rpath`** — `"-lmylib"` becomes a request for a file
of that name next to your build script, and says so:

```
/usr/bin/ld: cannot find /your/project/-lmylib: No such file or directory
```

### `systemLib`, for a library the machine installed

For anything a package manager put there, the path is not worth writing by
hand — it differs per platform, per distribution and per package manager, and a
build script that hardcodes `/usr/lib/libSDL3.so` works on exactly one machine.

```ts
// build.ts
export default {
  entry: "./src/main.ts",
  output: "./bin/game",
  nativeLibs: [systemLib("SDL3")],
};
```

The name is the library's own, with no platform decoration: `SDL3`, never
`libSDL3.so` and never `SDL3.lib`. What gets looked for, and where, is the
platform's business:

| | Looks for | Then in |
|---|---|---|
| Linux, BSD | `libSDL3.so`, `libSDL3.a` | pkg-config's `libdir`, `/usr/local/lib`, `/usr/lib`, `/usr/lib64`, the multiarch directory, then `cc --print-file-name` |
| macOS | `libSDL3.dylib`, `libSDL3.a` | pkg-config, `$HOMEBREW_PREFIX/lib`, `/opt/homebrew/lib`, `/usr/local/lib`, then `cc --print-file-name` |
| Windows | `SDL3.lib`, `libSDL3.dll.a`, `libSDL3.a` | pkg-config (MSYS2 has one), every directory in `LIB`, `%VCPKG_ROOT%/installed/x64-windows/lib` |

All three spellings are tried on Windows rather than the toolchain being
detected, because MSVC and MinGW disagree about all of them and a wrong guess
would be a confusing miss rather than an error. `SDL3.lib` is MSVC's name for
*both* an import library and a static archive, so `prefer` has nothing to choose
between there; on the other platforms it defaults to `"shared"`, which is what a
package manager installs, and `prefer: "static"` flips it.

`systemLib` is a **global** in a build script — a project has no `node_modules`
for an import to resolve against, and `.goblin/build.d.ts` declares it so the
editor knows it too. A build script that calls `compile` itself imports the same
function from `goblin-forge`.

Two options for the cases the defaults miss: `pkgConfig` names the package when
it is not the library's own (`systemLib("ssl", { pkgConfig: "libssl" })`), and
`search` names directories to try first. When nothing matches it throws, listing
what it looked for and where — and `GOBLIN_LIB_PATH`, a `PATH`-shaped list of
directories, is the override that always works:

```console
$ GOBLIN_LIB_PATH=/opt/sdl/lib goblin-forge
```

Verified on this machine against Arch's `sdl3` package: `systemLib("SDL3")`
answers `/usr/lib/libSDL3.so` through pkg-config, and the binary records the
SONAME `libSDL3.so.0`, so it runs anywhere SDL3 is installed. The Windows row is
from the toolchains' own documentation rather than from a machine sitting here.

### Doing it by hand

Three ways out, in order of how much you should like them.

**Give it the archive's path.** The compiler driver knows where its own
libraries live:

```console
$ gcc --print-file-name=libm.a
/usr/lib/gcc/x86_64-linux-gnu/15/../../../x86_64-linux-gnu/libm.a
```

Beware that it **echoes the name back unchanged when it finds nothing**, so
`libz.a` as an answer means "not installed", not a path. Check for a `/`.

**Ask pkg-config**, for anything that ships a `.pc` file:

```console
$ pkg-config --variable=libdir libssl
/usr/lib/x86_64-linux-gnu
```

**Wrap the linker.** `link.rs` honours `$CC`, so a wrapper script can append
whatever the argument list is missing — and this is the only route that reaches
`-rpath`:

```sh
#!/bin/sh
# ccwrap.sh
exec cc "$@" -L/opt/mylib/lib -lmylib -Wl,-rpath,/opt/mylib/lib
```

```console
$ CC=./ccwrap.sh goblin-forge
```

The flags land after everything goblin-forge passes, which is the correct end
of the line for a dependency. Treat it as a last resort: it is invisible to the
build script, so a build that needs it will fail confusingly for the next person
who does not have it set.

---

## Being called from C

The **entry module's** exports are what becomes C-callable. `type` decides what
is produced.

### A static library

```ts
export default { entry: "./src/main.ts", output: "./bin/mymath", type: "static-lib" };
```

This writes `bin/mymath.a` and a C header beside the objects, generated from the
same signature data that drives the classification, so the two cannot disagree:

```c
/* Generated by goblin-forge for `main`. Do not edit. */
#ifndef GOBLIN_MAIN_H
#define GOBLIN_MAIN_H
#include <stdint.h>
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif

int32_t add(int32_t p0, int32_t p1);

#ifdef __cplusplus
} /* extern "C" */
#endif
#endif /* GOBLIN_MAIN_H */
```

**The consumer must also link the Goblin runtime**, because the archive
deliberately does not carry it:

```console
$ gcc consumer.c bin/mymath.a "$RUNTIME/libgoblin_runtime.a" -o consumer
$ ./consumer
42
```

The runtime archive's path comes back as `runtimeLibrary` on the compile
result. If you are driving the compiler from a build script, read it from there
rather than hardcoding — it moves between a repo checkout
(`packages/runtime/native/target/release/`) and the single-file executable,
which extracts its embedded copy under `~/.cache/goblin-forge/<version>/`.

On a platform where the naive command is not enough, the full list from
`rustc --print native-static-libs` goes last:
`-lgcc_s -lutil -lrt -lpthread -lm -ldl -lc`.

### A shared library

```ts
export default { entry: "./src/main.ts", output: "./bin/mymath", type: "shared-lib" };
```

An ELF shared object publishes every symbol with default visibility, so there is
nothing to configure. **Windows is the platform that has to be told**: a DLL
exports nothing unless named, so a `.def` file is generated from the module's
own defined symbols, and an import library is written beside the DLL — Windows
has no equivalent of linking straight against a `.so`. Its path comes back as
`importLibrary`.

Unlike a static library, a shared one *is* linked, so it carries the runtime and
its system libraries already.

---

## When it goes wrong

**`GF9005` is not necessarily a compiler bug.** A missing toolchain, an
unreadable archive, or a symbol nothing defines all land there. The message
carries the exact command; `linkCommand` on the compile result carries it too,
even on success.

| Symptom | Usually |
|---|---|
| `undefined reference to 'foo'` | a typo in a `declare`, or a library not in `nativeLibs` |
| `undefined reference` to something you *did* pass | archive order — the dependency must come after the dependent |
| `error while loading shared libraries` | a SONAME'd `.so` that the loader cannot find; see above |
| unresolved Rust-looking symbols | the system library list; the runtime archive is missing or last |
| `cannot find /your/project/-lfoo` | a `-l` flag in `nativeLibs`, which takes paths — it got resolved into one |

`ldd` on the output answers the load-time questions, and `nm -g --defined-only`
on an archive answers "does this actually define what I think it does".

---

## Platform differences worth knowing

| | Linux / BSD | macOS | Windows (MSVC) |
|---|---|---|---|
| Executable | *(none)* | *(none)* | `.exe` |
| Static library | `.a` | `.a` | `.lib` |
| Shared library | `.so` | `.so` | `.dll` + import `.lib` |
| Struct ABI | System V | System V | Win64 |
| Shared-lib exports | automatic | automatic | generated `.def` |
| `strdup` | `strdup` | `strdup` | `_strdup` |

**macOS gets `.so`, not `.dylib`.** `extension_for` asks only whether the target
is Windows, so the conventional macOS spelling is not produced. Nothing breaks —
the loader does not care about the extension — but a build script that globs for
`*.dylib` will find nothing.

The struct ABI row is the one that changes behaviour rather than spelling. A
struct of 1, 2, 4 or 8 bytes goes in one integer register on Win64 and anything
else by address; System V splits up to sixteen bytes into eightbytes classified
INTEGER or SSE. Both are implemented and both are differentially tested against
the platform's own C compiler in `tests/struct-abi.test.ts` — which is the only
reason to believe either of them.

---

## Reserved, and not yet wired

`manifests` appears in `CompileOptions` and nothing reads it, in the same way
`incremental` does. Setting it has no effect today.
