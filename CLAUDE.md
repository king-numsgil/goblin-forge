# Working on goblin-forge

Notes for anyone — human or agent — changing this compiler. The
[`README`](README.md) says what the language is and how to build it; this says
how the thing is put together and which mistakes it is designed to prevent.

## The design documents

- [`REWRITE-PLAN.md`](REWRITE-PLAN.md) — the plan this implementation was built
  from. It says what the first implementation got right, what it got wrong, and
  why. Section numbers are cited throughout the source; when a comment says
  "REWRITE-PLAN §4.5", that is where the reasoning lives.
- [`DECISIONS.md`](DECISIONS.md) — the answers to the questions the plan left
  open, recorded as they land.
- [`NOTES.md`](NOTES.md) — working notes.
- [`LLVM-PORT.md`](LLVM-PORT.md) — the staged plan that replaced Cranelift,
  decided by DECISIONS §17. §17 is the reasoning; this is the order of
  operations and the checkpoint each stage ended at. All seven stages are done.
- [`LINKING.md`](LINKING.md) — what a program links and how, including the
  allocator surface and `runtime: "shared"`.
- [`GENERICS-PLAN.md`](GENERICS-PLAN.md) — monomorphisation, decided by
  DECISIONS §11.7. All seven stages are done. §6 — how a generic crosses a
  Goblin library boundary — is the one to read before changing anything there,
  because two of the three things it predicted turned out to be false and
  DECISIONS §25 is the settled version.
- [`POINTER-ERASURE.md`](POINTER-ERASURE.md) — how `void *` was arrived at,
  including the design that was probed and rejected. Answered by DECISIONS §13;
  worth reading before changing anything about `erase()` / `reify<U>()`, because
  the obvious answer to both halves is wrong in a way that is silent.

These describe what the compiler *is*. What it used to be is in the git history,
which is the right place for it — so a document that disagrees with the code is
a document to fix, not a record to preserve.

Read the relevant section before changing behaviour it describes. Where the
code and a document disagree, that is a bug in one of them, and which one is a
judgement call worth making explicitly rather than by editing whichever is
closer to hand.

## Two rules the whole design rests on

**Ownership is written down, never inferred.** Every type has a category
(trivial, owning, polymorphic, borrow) computed once from the type. Every value
has a storage class (owned, inline, borrowed, temporary) that is a static
property of a place. Copy and move are separate nodes in the IR, chosen by the
frontend. Drops are placed by a pass from CFG liveness, not spliced in by the
lowerer.

There is no `takeOwnership`, no `cloneOf`, no `ownsAllocation`. Every
memory-corruption bug in the first implementation was an instance of ownership
being a property of the program that was never written down, so it had to be
re-derived at every site — and one site always got missed.

**The backend never reports a user error.** Any failure reachable from source
that tsc accepted is a *missing frontend check*. The backend panics rather than
returning a diagnostic, so that a test cannot mistake a compiler crash for the
compiler correctly saying no.

v1 let `someF64 % 2` reach Cranelift, which answered `Rem is not defined on
f64` — no code, no file, no line. That is `GF0162` now, with a caret under the
operator. When you reach an `internal_error!` while adding a feature, the fix is
almost always a check in `packages/forge` or `packages/checker`, not a
politely-returned error in `crates/goblin-codegen`.

`tests/backend-contract.test.ts` enforces this. It compiles in a child process,
because a panic in the addon takes the test runner with it.

## Build order, and the mistake it is easy to make

```console
bun run build:backend     # regenerate MIR bindings, then build the addon
```

`build:backend` does two things in order and the order matters: it regenerates
`packages/backend/js/mir.generated.ts` from the Rust MIR definitions, then
compiles the napi addon.

**A `cargo build` is not enough after changing anything in
`crates/goblin-codegen`.** The tests load the compiled `.node` addon, not the
workspace libraries, so a codegen change that is not followed by
`bun run build:backend` is invisible to every test — they keep exercising the
previous build. This has cost real debugging time: an indexing fix appeared to
do nothing, and the reason was a stale addon.

Changing the runtime (`packages/runtime/native`) needs no manual step; it is
built on demand by `cargo rustc` for the user's target, at the build's
optimisation level, and cached per process by target *and* level. Each level
gets its own `target/opt-<level>/`, because cargo writes every profile to
`target/release` and two levels sharing a path is one silently overwriting the
other.

**The runtime is its own cargo workspace**, deliberately — it is built for the
*user's* target, not the host. So `cargo build --workspace`, `cargo test
--workspace` and `cargo clippy --workspace` do not reach it, and neither does
anything in the checklist below unless it names that directory. That is how a
`panic = "abort"` set only under `[profile.release]` left `cargo build` there
failing for two days with six tests behind it that nobody could run.

## The toolchain a build needs

`clang` on `PATH`, and a linker. The backend emits LLVM IR as text and compiles
it with `clang -c`, so a machine without one cannot build a program — see
DECISIONS §17 for why a subprocess rather than `llvm-sys`, and note that the
compiler already shells out to `cargo` and to the linker, so this is the status
quo rather than a new class of dependency.

`GOBLIN_CLANG` names a specific one. `llvm-objdump` is wanted only by tests, and
they fall back to GNU `objdump`.

**On an MSVC target, clang builds the runtime's C dependencies too**, as
`clang-cl` — `cToolchain` in `packages/runtime/src/build.ts` sets `CC`/`CXX` for
the target triple. MSVC 14.43.34808 miscompiles mimalloc at `/O1`, which
`optLevel` reaches at `O1`, `Os` and `Oz`, into an allocator that hands out
overlapping blocks; `cl` at `/O2` and 14.38.33130 at `/O1` are both fine, which
is what makes it a compiler defect rather than a property of the level.
DECISIONS §28 is the reasoning and the measurement. There used to be an
`opt-level = 2` pin on `libmimalloc-sys` instead; it is gone, and reaching for
one again would cover a single named package rather than whatever C arrives
next.

**They are checked before the type-check, not when they are first run.**
`packages/forge/src/toolchain.ts` looks for clang, cargo and the linker — `ar`
instead, for a `static-lib`, since an archive is not a link — and a build that
cannot finish says so as `GF0006` before it does anything. Without that, a
machine with no clang compiles the whole program and then fails inside the
backend with an `InternalError`, which is a `GF90xx` claiming the compiler is
broken about a machine that is only missing a package.

**The linker is not always a `PATH` question, and the check does not decide that
for itself.** `locateLinker` in the addon answers, using the same
`find_msvc_tool` the link step calls: under MSVC it probes the registry, and
everywhere else — every Unix, and MinGW, which is `windows` and wants the
opposite answer — it reports that `PATH` is the question. Deciding it in
TypeScript from `process.platform` would be a second opinion about which linker
is going to run, and the interesting failures are exactly where two opinions
differ.

**Bun is not checked**, because it cannot be missing: the executable *is* Bun.
Neither is LLVM a separate thing to look for — the backend emits text IR and
hands it to clang.

Adding a `#[napi]` export means rebuilding the CLI, not just the addon.
`packages/cli/build.ts` generates a shim that re-exports the addon's bindings by
name, because there is no `export *` from a `require`d `.node`. That list is now
read off the addon itself; it used to be typed out, and a hand-listed surface
that nothing checked is how `locateLinker` reached the bundle as a
`ReferenceError` at run time rather than an error at build time.

The `.ll` is written beside every object and kept. When the backend is
suspected, read it first — that is half of what text IR was chosen for.

## The standard library

There are now **two kinds of std module**, and which one a new name belongs in
is the first question to answer rather than the last.

| Kind | Modules | What it is |
|---|---|---|
| ambient | `std/alloc`, `std/io`, `std/math` | `declare module` resolving to no file; every name is an `extern "C"` the lowerer maps |
| recognised | `std/linalg` | types the compiler knows, lowered to SIMD |
| **source** | `std/collection` | ordinary Goblin, compiled into whoever imports it |

The rule that decides it: **a value type has to be source.** An ambient class is
an opaque handle — no layout, no destructor, no lowered members — which is right
for a `FILE *` and wrong for anything a scope has to release. A recognised type
is for what has no source-level spelling that survives to the backend, which so
far is SIMD and nothing else. Everything else is source.

### The ambient ones

`declare module "std/alloc"` in `packages/runtime/global.d.ts`, resolving to no
file. There is no package to install and no `paths` entry — tsc matches the
specifier against the declaration, and the declaration is the whole of it.
DECISIONS §15, §20 and §21 are the reasoning.

Adding a name to one takes four steps, and missing any of them fails in a
different place:

1. **Declare it** in the module block in `global.d.ts`. Miss this and it is a
   `TS2305` from tsc.
2. **Map it** in `STD_MODULES` (`packages/forge/src/lower/tables.ts`), name to
   the `gf_*` symbol. Miss this and it is `GF0001` with a caret under the name.
3. **Define it** in `packages/runtime/native/src/lib.rs`. Miss this and it is an
   unresolved external from the linker, with no file and no line — which is the
   failure the allowlist exists to keep rare, so it is worth a test that calls
   the name.
4. **`bun run build:cli`** if you are testing through the CLI, which embeds its
   own copy of `global.d.ts`. `tests/cli.test.ts` regenerates it, so the suite
   covers this on its own.

`STD_MODULES` is keyed by **specifier first, then name**. A flat table of names
would match a same-named declaration in any `.d.ts` the project happens to
include, and silently rebind a user's own `extern` to the runtime's.

### `std/collection` is real Goblin source

`packages/runtime/std/collection.ts`, resolved by a `paths` entry in
`tsconfig.base.json`. DECISIONS §26 is the design, and §20 is where it was
predicted — it listed this shape and set it aside until a std module wanted a
*value* type. A container is that type, and it needed generics to exist.

**Nothing in the compiler resolves it. tsc does.** That is the point: the `paths`
entry is in the config every project extends, so the editor and the compiler
find the same file, which is the property `GF0003` exists to protect. A compiler
host hook would have been invisible to tsserver.

Adding a module under `std/` takes four things, and they are not the four above:

1. **The file**, in `packages/runtime/std/`.
2. **A `paths` entry** in `packages/runtime/tsconfig.base.json`, spelled out
   rather than as `"std/*"` — a wildcard sends `std/alloc` at a file that does
   not exist and leans on tsc falling back to the ambient declaration.
3. **`bun run build:cli`**, which embeds the directory's contents. It enumerates
   rather than listing, so a new file is picked up; the `paths` entry is not
   checked against it by anything.
4. Nothing in `STD_MODULES`, nothing in `lib.rs`. It is ordinary source.

**There are two shipping paths and they are easy to confuse.** The CLI embeds
these files (step 3); the *package* copies them, in `packages/forge/build.ts`.
`0.2.1` shipped with the second one missed entirely — a `dist/` with no `std/`
in it and a tsconfig `paths` entry naming a directory that was not there. What
stops that now is `SHIPPED` in that file: it is typed against `RuntimeFiles`,
so a member added to `paths.ts` fails the package build until something copies
the file, and the copied names are checked to exist before it reports success.

**A symbol inside one is tagged `std/…`, not by its path.** `#relative` in
`lower/module.ts` falls back to the absolute path for a file outside the project
root, which would be the checkout on one machine, a `node_modules` entry on
another, and a cache directory under the user's home for the packaged CLI —
three symbols for one function. `stdLibrary()` is how it recognises the
directory, and it is a `RuntimeFiles` member for that reason alone: nothing
*reads* these files but the compiler has to know where they are.

**What a container can and cannot do, and why the module reads the way it does:**

- Storage is `T[]`, never raw memory. There is no syntax for writing a
  destructor, so the only way a container releases what it holds is for the
  compiler to generate one — which it does for a class whose fields own.
- A key answers `hashOf` and `equalsOf`. A class answers by declaring
  `hash(): u64` and `equals(other: Reference<K>): boolean`; that hook is the
  extension point, resolved by name at the instantiation.
- **`take(p)` is how a value leaves a slot without being copied** — it hands the
  value back and puts the default in its place (DECISIONS §27). It refuses a
  class, for `zeroed`'s reason, which is why `BinaryHeap`'s sift still copies.
  Reading without emptying — `valueAt`, `peek`, `at` — still copies, and should:
  that is a read, not a take.
- A top-level `const` still does not lower, so a constant inside one of these is
  a local or an argument.

Two things an **ambient** std module cannot export. A **top-level `const`**,
because nothing lowers one — the constants in `std/math` are functions (`dpi()`)
for that reason. And a **class with members**: an ambient class is an opaque
handle, `collectClasses` skips it, and its statics and methods are never
lowered. That is why `std/io` is `fileOpen(path)` rather than `File.open(path)`.

The second of those is what a source module answers, and `std/collection` is
below. The first still applies everywhere: there is no module-level `const` in
this language, ambient or not.

### `std/linalg` is not one of those four steps

`dvec3` and its family are **recognised types**, like `string` and `T[]`, and
none of the steps above applies to them: there is no `gf_*` symbol, nothing in
`STD_MODULES`, and nothing in the runtime. DECISIONS §22 is the design.

The single source of truth is `packages/checker/src/linalg.ts`, and three
things read it — `erase()` for the layout, the lowerer for the arithmetic, and
a generator for the declarations. Adding an operation is a row in `LINALG_OPS`
(or `LINALG_MAT_OPS`) and a case in `compose()` in
`packages/forge/src/lower/linalg.ts`; a constructor is a row in `LINALG_CTORS`.
The backend is not involved either way, because it only ever sees SIMD
primitives.

The lowering is one dispatch in `lower/linalg.ts` and four families reached
from it through `protected abstract` hooks:

| File | What it lowers |
|---|---|
| `linalg.ts` | float vectors, and the dispatch every family shares |
| `linalg-matrix.ts` | matrices |
| `linalg-scalar.ts` | integer and boolean vectors, and every comparison |
| `linalg-quat.ts` | quaternions |

Two reuse rules carry most of the weight, and both are enforced rather than
described. **A matrix is columns of a vector type** — `dmat3` is a struct of
three `dvec3` — so `add`, `sub`, `scale`, `negate` and `equals` reuse the
vector arms and only five operations are matrix-specific. **A quaternion is
four lanes**, so only the seven kinds in `QUAT_ONLY_KINDS` divert; everything
else is the vector operation of the same name.

Two traps worth knowing before touching the dispatch:

- **A matrix has `lanes: null` too.** That field means "not one register", and
  a matrix is not one either — its columns are. Routing on `lanes === null`
  without also testing `family === "vec"` sends every matrix operation to the
  integer path.
- **`linalgMethodOf` searches `opsFor(type)`.** It used to consult two
  prebuilt maps and silently answered from the *float vector* table for the
  other three families — which worked for `add` and `dot`, because those names
  are in every table, and failed for `any` and `slerp`.

**After changing that table, run `bun run build:linalg`.** It rewrites the
generated block of `global.d.ts` in place. Skipping it leaves the compiler
implementing a method tsc has never heard of, which is a `TS2339` at the call
site rather than anything pointing here.

Two invariants worth knowing before touching it:

- **The MIR struct is named `linalg.dvec3`, not `dvec3`.** Structs are interned
  by name alone, so a user's own `dvec3` would otherwise be the same struct as
  this one and get its layout. `.` is not a character a TypeScript identifier
  can hold, which is what makes the qualified name unforgeable.
- **The declared classes carry a private member.** Without it `dvec3` and
  `aligned_dvec3` are structurally identical to tsc — same components, same
  methods — and `packed.add(padded)` would type-check and then lower a
  three-lane operation over a four-lane value.

## The wire format

The MIR is defined once, in Rust, and the TypeScript types *and their postcard
encoder* are generated from it. Generating the encoder as well as the types is
the part that is easy to skip and should not be: postcard is not
self-describing, so struct fields and enum variants are positional and no name
ever reaches the wire. A hand-written encoder that drifted by one field would
not fail to decode — it would decode into a different, entirely plausible
module.

Three things keep the halves honest, and all three should stay:

- a wire-format fingerprint, baked into the generated TypeScript and checked on
  every decode;
- a Rust test asserting the checked-in bindings match what the generator would
  produce right now;
- a test that encodes in TypeScript, decodes in Rust, re-encodes in Rust, and
  requires byte equality.

Adding or reordering a MIR node changes the fingerprint. That is fine and
expected — regenerate, and read the diff.

## Testing

Real source, real compiler, real binary, real output. `tests/harness.ts` writes
a project into `tests/.scratch`, compiles it, runs the result, and asserts on
what the program actually did.

Four things about the harness are load-bearing:

- **`expectRejected` requires a diagnostic code.** Matching only "it failed"
  makes a backend panic and a clean rejection look the same.
- **stderr is asserted**, not only stdout.
- **The live-allocation check runs on every `run` test**, automatically, and
  nobody opts in. In v1 this "found more real bugs than every deliberate
  assertion combined". A missing report is a failure, not a zero: `main` calls
  `gf_runtime_init`, so every program that returns from `main` reports, and an
  absent report means the program died before exiting.
- **Exit codes are eight bits.** A program returning 300 really does exit 300,
  and this observation says 44. Print what you want to assert.

`test.failing` marks a known defect whose fix is not in this change. It fails
the run when the behaviour starts working, which is the point — it forces the
marker to be removed rather than forgotten.

The C++ oracle (`tests/oracle/`) is the arbiter for value semantics: each case
is written twice, once in Goblin and once in C++, and the two allocation traces
must be identical. Where Goblin is *meant* to differ, the divergence is written
into the suite so that every intentional departure is checked rather than
remembered.

The bar for C++ compatibility is "close enough that semantics translate", not
byte-identical behaviour. Chasing an exact match on things like a container's
growth strategy tests the standard library's policy, not this language.

## Diagnostics

Codes live in `packages/checker/src/codes.ts` with a title and a long-form
explanation. The message itself lives at the site that raises it, because a good
message names the specific construct; the table is the stable identity and the
prose.

- `GF00xx` — the build itself: configuration, entry point, unsupported syntax
- `GF01xx` — widths and arithmetic
- `GF02xx` — ownership, references, pointers, the value model
- `GF03xx` — layout and the C boundary
- `GF04xx` — generics and instantiation
- `GF90xx` — the compiler is broken, not your program

`GF0001` is "valid TypeScript, meant to be valid Goblin, not lowered yet" — a
gap. `GF0002` is "TypeScript allows this and Goblin does not" — a rule. The
difference matters to whoever reads it, so pick deliberately.

A code is never reused for a different rule. If a rule goes away, its code goes
with it. `tests/diagnostics.test.ts` raises every code from a real program and
names the ones nothing can reach, with the reason.

## Conventions

- Development happens on `master`. Commit there directly.
- Comments explain *why*, not what. The existing source is the reference for
  tone and density — match it rather than adding a different register.
- `bun run typecheck`, `cargo test --workspace`, and `bun test` should all be
  clean before a commit. So should
  `cargo clippy --workspace --all-targets -- -D warnings`.
- **And the same two in `packages/runtime/native`**, which is a separate
  workspace that none of the above reaches. Four commands, not two:

  ```console
  cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  cd packages/runtime/native && cargo test && cargo clippy --all-targets -- -D warnings
  ```
- Green on one platform is not green. The last two defects were both "passes on
  Windows, fails on Linux" — a test that hardcoded CodeView, and the runtime
  profile above. `.github/workflows/ci.yml` has the Linux job and is parked on
  `workflow_dispatch`; run it by hand, or expect to find these the slow way.
- Avoid raw NUL bytes in source. One in `lower.ts` made git treat the file as
  binary and ripgrep skip it, which silently broke every grep over the largest
  file in the project. Write `\0` in a string literal instead.
- TypeScript is 4-space indented (not 2), per the 2026-08-17 WebStorm reformat.
  One-line interface/type members (`interface Foo {}`, `readonly x: T;` with no
  comment) get a blank line between them; a run of related one-liners, like the
  `SCALARS` array or a single-line union arm such as
  `| { readonly kind: "void" }`, stays tight. A union arm that is a multi-line
  object literal indents its body and closing `}` to line up under the `{`
  that opens it, e.g. (`packages/checker/src/types.ts`, `MachineType`):
  ```ts
      | { readonly kind: "array"; readonly element: MachineType }
      | {
            /** `FixedArray<T, N>`: `N` elements, inline, no allocation. */
            readonly kind: "fixedArray";
            readonly element: MachineType;
            readonly length: number;
        }
  ```
  WebStorm's reformat got this last case wrong across the codebase (dropped
  the body and closing brace to the `|`'s own indent) — that was fixed by hand
  in `types.ts` and `lower.ts`; match the corrected form, not the bulk diff.
