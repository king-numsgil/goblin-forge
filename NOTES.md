# Implementation notes

State of the build after milestone 8 — classes *and* interface dispatch —
written so that milestones 9–10 can be picked up cold.

- [`REWRITE-PLAN.md`](REWRITE-PLAN.md) is the design. It does not change.
- [`DECISIONS.md`](DECISIONS.md) is what was decided and why, including the §11
  answers. Read it before re-litigating anything.
- This file is *where the code is* and *what it does not do yet*.

Everything below is as of milestone 8 complete, both halves: 217 TS tests, 6
Rust test binaries, `tsc --noEmit` clean, `cargo fmt --all --check` clean,
`cargo clippy --workspace --all-targets -D warnings` clean.

---

## The pipeline, end to end

```
compile(options)                          packages/forge/src/compile.ts
  1. Checker.check()                      packages/checker/src/program.ts
       tsconfig load + validate           packages/checker/src/tsconfig.ts
       tsc diagnostics → Diagnostic       packages/checker/src/diagnostics.ts
  2. lower(program, checker, name)        packages/forge/src/lower.ts
       ts.Type → MachineType              packages/checker/src/types.ts
       width rules (tables)               packages/checker/src/widths.ts
       MIR construction                   packages/backend/js/builder.ts
  2a. elaborateDrops(module)              packages/forge/src/drop-elaboration.ts
  2b. emit.ir → printModule()             packages/backend/js/print.ts
  3. encodeModule() → Backend.compileModule()
       generated postcard encoder         packages/backend/js/mir.generated.ts
       ── napi boundary ──
       decode + layout + Cranelift        crates/goblin-codegen/
  4. buildRuntime() + Backend.link()      packages/runtime/src/build.ts
```

## Where things live

| Path | Lines | What it is |
|---|---:|---|
| `crates/goblin-mir/src/ty.rs` | 235 | `TyKind`, `Category`, `StorageClass`, `Signature`, `Abi` |
| `crates/goblin-mir/src/body.rs` | 428 | `Place`, `Operand`, `Rvalue`, `Statement`, `Terminator`, `UnwindAction` |
| `crates/goblin-mir/src/bindings.rs` | 610 | **generates** the TS types *and* the postcard encoder |
| `crates/goblin-mir/src/schema.rs` | 174 | reflection over the type graph, wire fingerprint |
| `crates/goblin-codegen/src/layout.rs` | 277 | `Layout` (bytes) and `Repr` (registers) — §5.2's two questions |
| `crates/goblin-codegen/src/abi.rs` | 626 | Win64 + System V classification, with unit tests |
| `crates/goblin-codegen/src/translate.rs` | 1789 | MIR → Cranelift. The big one. |
| `crates/goblin-codegen/src/vtable.rs` | 199 | per-class descriptor, vtable and itabs, as static data |
| `crates/goblin-codegen/src/runtime.rs` | 153 | runtime symbols, string literal data layout |
| `crates/goblin-codegen/src/link.rs` | 199 | linker discovery, lifted from v1 |
| `packages/forge/src/lower.ts` | 2701 | AST → MIR. The other big one. |
| `packages/forge/src/classes.ts` | 313 | class discovery, field/vtable flattening, slot assignment |
| `packages/forge/src/drop-elaboration.ts` | 461 | §5.1's pass: initialisedness dataflow, drop flags |
| `packages/runtime/native/src/lib.rs` | 369 | string runtime, `console`, live-allocation counter |
| `packages/runtime/global.d.ts` | — | **the entire language surface** |

## Commands

```bash
bun install
bun run build:backend        # regenerates MIR bindings, then builds the addon
bun test                     # everything
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run bench:boundary       # §2's de-risk measurement
bun run examples/hello/build.ts
```

**`build:backend` regenerates before it compiles, in that order.** Editing
`crates/goblin-mir` and not rerunning it leaves a stale `.node` beside fresh
JavaScript; the wire fingerprint catches that with one clear message rather than
a silent misparse.

---

## What the language has

Functions (`export` → C ABI, plain → internal, no body → `extern "C"` import),
the twelve widths, `boolean`, `string`, structs from `interface`/type literals,
`FixedArray<T, N>`, `Pointer<T>`, `if`/`while`/`for`/`break`/`continue`/`return`,
blocks and scoping, arithmetic with the full width rules, `nativeCast`, `move`,
template literals, `console.*`, object literals, field and element access and
assignment, `.length`, and **classes**: fields, a constructor, methods,
`super(…)` and `super.m(…)`, single inheritance, virtual dispatch through a
vtable, slicing on copy, and a generated destructor that chains to the base's.
Accessibility modifiers (`public`/`private`/`protected`) are accepted and
erased — tsc enforces them, and they have no run-time meaning.

## What it does not have yet

Grep for these markers — each is a `GF0001` with a file and a line, never a
backend failure:

| Not implemented | Where it is refused | Milestone |
|---|---|---|
| **dynamic** interface casts (`x instanceof Pet`) | no spelling yet — see below | later |
| `T[]` — the owning, runtime-length array | `checker/src/types.ts`, `isArrayType` branch | later |
| `Reference<T>` as a *written* type, except `Reference<I>` for a contract | erasure refuses it; the contract case works | 9 |
| an interface mixing methods and data | `checker/src/types.ts`, `contractOf` — a rule, not a gap | — |
| `nativeSizeOf`/`nativeAlignOf`/`nativeNew`/`alloc`/… | lowerer, no intrinsic case | later |
| `allocArray` / `freeArray()` | declared in the prelude, not lowered | later |
| static fields and methods, getters, setters | `classes.ts`, `describeMember` | later |
| parameter properties (`constructor(private x)`) | `classes.ts`, `#classFnParams` | later |
| calling through a `FnPtr` value | `translate.rs`, `Callee::Indirect` | later |
| `switch` | lowerer `#statement` | — |
| `main(argc, argv)` | `#checkEntryPoint` | needs `T[]` |
| `static-lib` / `shared-lib` | `link.rs:50` | 9 |
| multi-module | — | 10 |
| `throw` / unwinding | `Terminator::Resume` errors | after 9 |

`Rvalue::Ref` and `Rvalue::AddrOf` **are** implemented now — the lowerer emits a
`Ref` for every `this` and every method receiver.

MIR already has `Terminator::Call`'s `unwind` edge, `BlockKind::Cleanup` and
`Terminator::Resume` — put in at milestone 4 because retrofitting them is a
rewrite of the drop pass (§11.5). Every action the frontend emits today is
`Unreachable`.

## Diagnostic codes in use

`GF0001` not supported yet · `GF0002` not part of the language · `GF0003`
tsconfig · `GF0004` entry point · `GF0160` implicit narrowing · `GF0161` no
common type · `GF0162` integer-only operator on a float · `GF0163` `nativeCast`
cannot convert · `GF0164` literal out of range · `GF0165` unary minus on
unsigned · `GF0227` pointer where a value is expected · `GF0234` reference
borrowing a temporary · `GF0235` moved-from value read · `GF0236` moving out of
a by-value parameter · `GF9001`–`GF9005` the compiler is broken, not your
program.

`GF0227` and `GF0234` are **registered but not yet raised** — they arrive when
`Pointer<T>` and `Reference<T>` become types you can write.

`packages/checker/test/codes.test.ts` scans every `.rs` and `.ts` source for
`GF####` literals and fails if one is not in the registry. Add the entry when
you add the code.

---

## Invariants that will bite if broken

**The backend never reports a user error** (§8). Anything reachable from source
tsc accepted is a missing frontend check. `internal_error!` panics when
`strictInternalErrors` is on, and the test harness always turns it on — so a
compiler crash cannot read as a clean rejection.

**The MIR type graph must stay acyclic.** `schema.rs` walks it to generate the
bindings, and a cycle would be an infinitely recursive `const`. Places are flat
(root local + projection path) partly for this reason.

**Struct-variant fields must not be named `kind`**, and two fields must not
collide after camel-casing. The generator checks both and fails with a message
naming the rename.

**A statement beginning with `declare` is parsed as an ambient declaration and
erased.** A test helper called `declare(...)` compiles to nothing. Cost half an
hour in the layout suite; the helper is named `shape` now.

**Copy, move and borrow are three different reads** and stay distinguishable all
the way to the store:

| | applies the copy op | source dies | who destroys |
|---|---|---|---|
| `Copy(place)` | yes | no | the new owner |
| `Move(place)` | no | yes | the new owner |
| `Borrow(place)` | no | no | whoever already owned it |

Storing takes `Copy` (or `Move` from a temporary); *reading* — concatenation,
comparison, `length`, `console.log` — takes `Borrow`; a by-value argument is a
`Copy` into a temporary then a `Borrow` of it, because the caller makes the copy
and the caller destroys it (§4.5, Itanium).

`write_place_with` takes "is this a move" as an **argument**, because by then the
value is just an address and the distinction is gone. For an owning aggregate,
`memcpy` on a copy is §10's shallow-copy double free, and a field-wise clone on a
move leaks everything the source held.

**A move poisons a one-word handle but never an aggregate** — there is no single
word to null, and writing one memcpys from address zero.

**Scope exits are identity, not arithmetic.** Every scope carries an id; `break`
unwinds while the top is not the loop's enclosing scope, comparing objects. §10's
first trap is the depth version of this.

**Condition temporaries die on dedicated edge blocks.** They cannot die before
the branch (the terminator is part of the same full-expression) and cannot die at
the top of the targets (a loop exit is reached by both the condition failing and
`break`, so it would run twice).

**ABI carriers go through a zeroed scratch slot** of whole eightbytes, then a
byte copy of the real size. A carrier is 8 bytes wide even when the struct's tail
is not.

---

## Testing

| File | What it covers |
|---|---|
| `tests/pipeline.test.ts` | end to end, diagnostics, control flow |
| `tests/types.test.ts` + `packages/checker/test/widths.test.ts` | the width rules, as behaviour and as data |
| `tests/mir.test.ts` | golden MIR snapshots — drop placement regressions |
| `packages/forge/test/drop-elaboration.test.ts` | the pass, on synthetic owning types |
| `tests/strings.test.ts` | the first owning type |
| `tests/structs.test.ts`, `tests/arrays.test.ts` | aggregates and value semantics |
| `tests/layout.test.ts` | layout vs a **real C compiler**, ten shapes |
| `tests/struct-abi.test.ts` | the C ABI vs a **real `extern "C"` library**, 24 cases |
| `tests/classes.test.ts` | vtables, dispatch, slicing, destructor chains, and what is refused |
| `tests/interfaces.test.ts` | contracts, itabs, structural conversion, slot ordering |
| `tests/oracle.test.ts` | allocation traces vs **real C++**, 9 paired cases |
| `packages/backend/test/roundtrip.test.ts` | the wire format, byte-for-byte |

**Every `run()` test asserts the live allocation count is zero**, automatically.
§9 calls it non-negotiable and it has earned that twice already.

The C++ oracle and both differential suites build through **CMake**
(`tests/oracle/CMakeLists.txt`), which finds the compiler itself — no Visual
Studio path probing. `tests/oracle/cases/` is globbed, so a new pair is picked up
by adding two files.

Golden MIR: `bun test --update-snapshots`. Read the diff; a changed golden file
is the point of having it.

---

## Known unverified

**The Linux CI job has never run.** `.github/workflows/ci.yml` runs everything on
`windows-latest` and `ubuntu-latest`, and the Linux half is what makes System V
real rather than read — but development has been on Windows throughout. Expect
friction on the first push in the runtime's Unix link path
(`link.rs::unix_command`, which drives `cc`) and in the CMake C library. The
System V *classification* is unit-tested from Windows, so a failure there would
be plumbing rather than rules.

**Exit codes are 8 bits** through Bun on every platform. A compiled program
returning 300 really does exit 300; `RunResult.exitCode` still says 44. Observe
wider values through stdout.

---

## Classes, as built

Read this before touching `classes.ts` or the class paths in `translate.rs`.

**Fields and vtables are flattened at lowering, base entries first.** A
`FieldId` and a vtable slot therefore mean the same thing whatever the static
type is, a `Base` is a byte-for-byte prefix of every `Derived`, and an upcast is
a no-op. `ClassDef::own_fields` marks where a class's own fields begin — the
destructor needs it, and nothing else does.

**Slot 0 is the destructor**, always. An override reuses the slot it inherited;
a new method appends one. Slots are per *class*, never per method name across
the module — v1 numbered them by name so an interface could dispatch with no
side table, and REWRITE-PLAN §3 lists that as one of the two things a library
boundary breaks on day one.

**The emitted vtable is Itanium-shaped**: `[ descriptor ][ slot 0 ][ slot 1 ] …`,
and the pointer stored in an object addresses **slot 0**, not the descriptor. So
a virtual call is `load [vptr + slot * 8]` with no bias, and the descriptor is at
`[vptr - 8]`. `vtable.rs` is where that is built and `ClassData::vtable_bias` is
the one place the offset is written down.

**Every class has a vtable pointer**, including one with no virtual methods, and
the pointer is installed once by `Rvalue::Default` at the most-derived type. Both
are deliberate divergences from C++ with reasons in `DECISIONS.md`.

**`this` is a `Reference<Self>`** (§4.6), bound as parameter 0 under the name
`this`. A method receiver is an `Rvalue::Ref` of the receiver's place, so a call
on a value and a call through a reference produce the same shape.

**`super.m()` is a *direct* call and must stay one.** A virtual call there would
load the receiver's vtable, find the derived override, and re-enter the method
doing the `super` — an override calling `super.m()` would call itself until the
stack ran out. `super` names a body; `this.m()` names a slot. The body is the
base's final overrider as of the base, so a middle class that overrides is what
a three-deep chain reaches.

**`#asClass` sees through exactly one `Reference<T>`** and is the single place
that happens. Nothing is ever *retyped* — the projection carries a `Deref`,
which is the v1 bug REWRITE-PLAN §10 opens with.

**`classNameAt` asks tsc, and reports nothing.** The width pass raises
diagnostics as it goes, so it cannot be used to *ask whether* something is a
class: running it over `console` in `console.log(x)` reports an unresolved name
before the caller can decide it was not a method call. Any new "is this about a
class?" test belongs on `classNameAt`, not on `width`.

---

## Contracts, as built

**`TyKind::Interface` is the `(itab, data)` pair**, not the contract. It is what
`Reference<I>` erases to; a bare `I` has no value form and is refused. There is
no `TyKind` for a contract itself.

**It is an aggregate of two handles, not a fat handle.** That framing is what
kept this cheap: `layout.rs`'s "every handle is one machine word" is still true
and still says the same thing, `Repr` needed no two-register form, and `abi.rs`
was not touched. The pair travels by address internally, exactly like a struct.
The cost is copying sixteen bytes instead of filling two registers — a later,
isolated optimisation.

**Shape or contract, decided by AST node kind**, in `contractOf`:
`feed(): void` is a `MethodSignature` → dispatched; `feed: () => void` is a
`PropertySignature` → an ordinary `FnPtr` field, and the interface stays a
struct. Nothing is inferred from a type. An interface with **both** is rejected
(`GF0002`) rather than guessed at.

**Slots are the interface's method set sorted by name**, so a slot is a function
of the set rather than of the declaration's source order. `tests/interfaces.test.ts`
declares one out of order on purpose — two of its three methods have compatible
signatures, so a shifted slot would print plausible numbers rather than crash.

**Itabs are `[ descriptor ][ method 0 ] …`**, the same shape as a vtable, so a
dynamic cast can later hand one back and reaching the descriptor at `[-1]` works
unchanged. They are emitted statically, per `(interface, class)` pair actually
converted. `ModuleBuilder.implementInterface` is called *while bodies are being
lowered*, not at `defineClass`, because a structural conversion is only known
once its site has been seen — that ordering is deliberate.

**The itab is chosen from the source's *static* class.** Converting a `Base`
yields a `Base`'s itab even when the object is a `Derived`, and dispatch still
reaches the derived override, because the itab holds `Base`'s final overriders —
which is where a virtual call through a `Base` would have gone anyway.

**Nothing may compare an itab's address.** An itab is a *cache*; the type
descriptor is the identity, and it has exactly one owner. Two modules converting
the same pair will each emit an itab, and that is correct.

**`#contractAt` reports nothing**, like `classNameAt` and for the same reason:
it decides *whether* a call is interface dispatch before anything commits to
lowering it that way.

**`implements` is accepted and recorded but not required.** A static conversion
is structural, matching TypeScript. Declaring the clause is what will make a
class findable by a dynamic cast, which needs the itab reachable from the type
descriptor and therefore known at the class's own declaration.

---

## What interface dispatch still does not do

**Dynamic casts.** `ClassDef::implements` and the per-class descriptor are in
place and populated; what is missing is the operation that searches them. §11.3
settles the mechanism — walk the base chain, compare descriptor pointers — and
the itab array on the descriptor is already sorted by `InterfaceId` for a binary
search.

There is **no spelling** for one and it has to be invented: `x instanceof Pet` is
already a TypeScript error ("only refers to a type"), so nothing can diverge. An
intrinsic returning null on failure fits the machinery that already exists for
`nativeCast<u8>`, and needs no general generics. Ask before choosing one.

**Contracts at the C boundary.** Refused. Revisit with header emission at
milestone 9.

**Interface-to-interface conversion**, and a contract extending another. Neither
is implemented; both are ordinary work on top of what is here.
