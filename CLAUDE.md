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
- [`LLVM-PORT.md`](LLVM-PORT.md) — the staged plan for replacing Cranelift,
  decided by DECISIONS §17. §17 is the reasoning; this is the order of
  operations and the checkpoint each stage ends at.
- [`POINTER-ERASURE.md`](POINTER-ERASURE.md) — how `void *` was arrived at,
  including the design that was probed and rejected. Answered by DECISIONS §13;
  worth reading before changing anything about `erase()` / `reify<U>()`, because
  the obvious answer to both halves is wrong in a way that is silent.

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
built on demand by `cargo rustc` for the user's target and cached per process.

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

**They are checked before the type-check, not when they are first run.**
`packages/forge/src/toolchain.ts` walks `PATH` for clang, cargo and the linker —
`ar` instead, for a `static-lib`, since an archive is not a link — and a build
that cannot finish says so as `GF0006` before it does anything. Without that, a
machine with no clang compiles the whole program and then fails inside the
backend with an `InternalError`, which is a `GF90xx` claiming the compiler is
broken about a machine that is only missing a package.

Two things it deliberately does not check. **Bun**, because it cannot be
missing: the executable *is* Bun. And **the linker on Windows**, which is found
through the registry rather than `PATH` — a `PATH` walk would report it missing
on a machine where the build then succeeds, and a check that cries wolf is worse
than no check.

The `.ll` is written beside every object and kept. When the backend is
suspected, read it first — that is half of what text IR was chosen for.

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
