# Implementation notes

State of the build with **all ten milestones complete**, written so the next
person — or the next session — can pick it up cold.

- [`REWRITE-PLAN.md`](REWRITE-PLAN.md) is the design. It does not change.
- [`DECISIONS.md`](DECISIONS.md) is what was decided and why, including the §11
  answers. Read it before re-litigating anything.
- This file is *where the code is* and *what it does not do yet*.

736 TS tests, 6 Rust test binaries, `tsc --noEmit` clean, `cargo clippy
--workspace --all-targets -D warnings` clean. `cargo fmt --all --check` is clean
on the toolchain this was written against but not on rustfmt 1.9 — see the last
section for why that was left alone.

REWRITE-PLAN §12's build order is finished. What is left is not a milestone: it
is the list under "What it does not have yet".

**System V has now been run for real** — Ubuntu, x86_64, GCC 15, the whole suite
green from a cold checkout. §6 asked for that on day one and it took until after
milestone 10; see "What the first System V run found" below for the two things
it caught, only one of which was about System V.

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

**Opaque handles**: `declare class FILE { private _opaque: never }`, C's
incomplete type, usable only as `Pointer<FILE>`. See below.

**Unions**: `interface E extends Union` — every member at offset 0, sized by
the largest and aligned by the strictest. Members must be plain data
(`GF0303`), and an object literal cannot build one (`GF0304`), so `zeroed<T>()`
is how one comes into being. `tests/unions.test.ts` builds SDL3's `SDL_Event`
and matches the 128-byte size its header asserts.

**Enums** — integer ones; a string enum is a `GF0001` gap. The underlying type
is written as a merged namespace, `declare namespace E { type Underlying = u32 }`,
defaulting to `i32`, in either order. Members are constants folded by tsc and
range-checked against the width at the declaration. See DECISIONS §12 for why it
is spelled that way and not as a decorator (TypeScript refuses one on an enum)
or a comment.

**`zeroed<T>()`**: a `T` whose bytes are all zero, from the same `Default` a
class gets before its constructor runs. Refuses a class, because that would
skip the constructor.

## What it does not have yet

Grep for these markers — each is a `GF0001` with a file and a line, never a
backend failure:

| Not implemented | Where it is refused | Milestone |
|---|---|---|
| interface-to-interface conversion, and a contract extending another | nothing lowers either | later |
| `Reference<T>` for anything but a class or a contract | `checker/src/types.ts`, the `isReferenceType` branch | later |
| an interface mixing methods and data | `checker/src/types.ts`, `contractOf` — a rule, not a gap | — |
| writing *through* a `Pointer<Pointer<T>>` for a primitive `T` — `cells[i] = p` | tsc, not the compiler. `Pointer<Pointer<u8>>` is `CorePointer<u8> & CorePointer<CorePointer<u8>>`, and the two index signatures merge to `u8 & CorePointer<u8>`, which nothing produces. Reading is fine, and `Pointer<CString>` is the spelling for a `char **` that has to be written | later |
| static **fields** | `classes.ts`, the `isStatic` branch over property declarations — needs module-level storage the backend has never emitted; see below | later |
| closures / arrow functions | `lower.ts` — Tier 0 (function pointers) shipped, capture did not | later |
| generic functions, optional/rest/defaulted/destructured parameters | `lower.ts`, `#classFnParams` and `#signature` | later |
| two classes with the same name in two modules | `classes.ts`, `collectClasses` — a stated restriction, see DECISIONS §11.8 | later |
| incremental builds | `CompileOptions.incremental` is reserved and unread | later |
| `throw` / unwinding | `Terminator::Resume` errors | later |
| a binding with no initialiser — `let e: SDL_Event;` | `lower.ts` — tsc wants `let e!: T` for its own definite-assignment rule, and the lowerer refuses either spelling. `zeroed<T>()` is the way to write it meanwhile | later |
| **taking the address of a local** — C's `&x` | nothing produces one: `alloc` and `allocArray` are the only sources of a `Pointer<T>`, and both are heap. So a C function that fills a struct or union out-parameter needs `alloc<T>()` and a `.free()`, where C would have used a stack slot. Wants a decision about escape analysis before it can be safe | later |
| a namespace holding anything but `type Underlying` | `lower.ts`, `#checkEnumNamespace` — a rule, not a gap: there is no module-level storage for one to hold | — |
| **string enums** | `checker/src/types.ts`, `enumUnderlying` — implementable and cheap (the members are string constants), and currently the only way to write named string constants, since module-level `const` is unsupported | later |
| `>>>`, the comma operator, `&&=` / `\|\|=` / `??=`, `??` | `lower.ts` — `>>>` also wants a decision, since an explicit unsigned width already spells a logical shift as `>>` | later |
| the **value** of `a++` / `++a` / `(a += 1)` | `lower.ts`, `#unary` — they update as statements; only the value is missing, which is the half where prefix and postfix differ | later |

`Rvalue::Ref` and `Rvalue::AddrOf` **are** implemented now — the lowerer emits a
`Ref` for every `this`, every method receiver and every `p.deref()`, and an
`AddrOf` for `p.offset(n)`.

**Static fields need a piece the backend does not have.** `Module::globals` and
`Global` exist in the MIR and nothing reads them: `crates/goblin-codegen` never
emits a data object, and there is no way to *name* one from a `Place`, whose
root is always a local. So a `static count: i32` needs a MIR change (a global
place root, and therefore a new wire-format fingerprint), data emission in the
codegen, and an answer for initialisation order when the initialiser is not a
constant. Static *methods* and static *accessors* need none of that, which is
why they are done and this is not.

**`Reference<T>` for a struct is the next real gap in the value model.** Today
every struct parameter copies and there is no way to say otherwise. Erasing it
is one branch in `checker/src/types.ts`; making it work is roughly six sites in
`lower.ts` — `#propertyWidth` and `#property` (which unwrap a pointer to a
struct but not a reference to one), `#fieldAssignment`, `#coerce` and
`#toClassReference`, and argument passing — and each missed site is a wrong
answer rather than a diagnostic.

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
| `tests/libraries.test.ts` | a **real C program** links a Goblin archive and calls it |
| `tests/modules.test.ts` | many files, one compilation; private names that collide |
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

**System V has never been executed.** The classification is unit-tested from
Windows — 12 tests in `abi.rs` pinning both conventions — but no System V binary
has ever run, and REWRITE-PLAN §6 is blunt about what that is worth: "the
classification is the part of a compiler where 'looks right' is worth nothing."

`.github/workflows/ci.yml` would check it and is **parked, manual-only**, by
decision: hosted CI costs money on a two-person project with no pull requests to
gate. The plan is a real Linux machine once milestones 9 and 10 land.

Expect friction in `link.rs::unix_command` (which drives `cc` and has never
executed), in the CMake oracle picking up gcc or clang instead of MSVC, and in
building the addon on a fresh box. A failure in those is plumbing. A failure in
`tests/struct-abi.test.ts` is not — that one is a real disagreement with the
platform about registers, and it is the reason to run this at all.

Nothing enforces `cargo fmt --all --check` while CI is parked. Run it before a
commit, or a later formatter run folds churn into an unrelated diff.

**Exit codes are 8 bits** through Bun on every platform. A compiled program
returning 300 really does exit 300; `RunResult.exitCode` still says 44. Observe
wider values through stdout.

---

## What the backend optimises, and what it does not

Cranelift 0.134. `optLevel` defaults to `"speed"` (`compile.ts`), and `"size"`
maps to Cranelift's `speed_and_size` rather than to a pure size mode.

From `Context::optimize`, at `"speed"`:

| Runs | What |
|---|---|
| always, every level | unreachable-code elimination, constant-phi removal, alias resolution; then instruction selection, regalloc2, branch ordering and emission in `isa.compile_function` |
| `opt_level != none` | `egraph_pass` — the mid-end: GVN, constant folding, algebraic rewrites, LICM, and redundant-load elimination through `AliasAnalysis` |

`enable_alias_analysis` is left at its default of `true`; Cranelift documents it
as effective only at `speed` / `speed_and_size`, so the default level is what
switches it on.

**The IR verifier is off unless `strictInternalErrors` is set.** Cranelift
defaults `enable_verifier` to `true` and runs it *twice* per function — once in
`Context::compile`, once inside `Context::optimize`. It checks that the CLIF
this compiler produced is well formed, which says nothing about the program
being compiled, so it is a pure compile-time cost in a shipped build. It is now
tied to the flag that already means "a compiler bug should be loud here"
(REWRITE-PLAN §8), which the test harness sets — so every test still compiles
with it on. If the two ever need to be separated, `verify_ir` on
`CodegenOptions` is the seam.

**Nothing is inlined — worth researching.** Cranelift 0.134 does have an
inliner, but `Context::inline(impl Inline)` is caller-driven: the embedder
supplies the policy and calls it. `object.rs` only calls `define_function`, so
no call is ever inlined. For a value-semantics language whose ordinary shape is
small accessors, one-line methods and `this`-borrowing wrappers, that is
probably the largest single performance item outstanding. Open questions before
attempting it: where the policy lives (a size heuristic in `object.rs`, or
something the frontend marks in the MIR), whether it can run at all when each
module is compiled to its own object file, and what it does to compile time —
which is the budget this project has otherwise been careful with.

A smaller note: host builds go through `cranelift_native::builder()` and pick
up the host's CPU features. An explicit `--target` triple goes through
`isa::lookup()`, which is **baseline only** — so a cross-compiled binary is
more conservative than a native build of the same source.

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

**Contracts at the C boundary.** Refused. Revisit with header emission at
milestone 9.

**Interface-to-interface conversion**, and a contract extending another. Neither
is implemented; both are ordinary work on top of what is here.

---

## `tryCast<T>` and `Reference<C>`

```ts
function report(a: Reference<Animal>): void {
  const d = tryCast<Dog>(a);          // a class: walk the base chain
  const s = tryCast<Speaker>(a);      // a contract: search the itab table
  if (d !== null) { … }
}
```

**`| null` is the design, not a detail.** `strictNullChecks` *rejects*
`tryCast<Pet>(x).feed()`, so the check is the only way to reach the value — a
boolean type guard could have been ignored, and would have needed flow-sensitive
rebinding in the lowerer that this does not.

**It is the language's only union.** `Reference<I> | null` is the *same sixteen
bytes* as `Reference<I>`, with a zero itab meaning "no", so nullability stays
tsc's view and never becomes a second representation. `nullableOf` recognises
exactly one shape; anything else with a `|` falls through and is refused.

**Two mechanisms, two nodes.** `Rvalue::TryInterface` searches the dynamic type
descriptor's itab table (`gf_find_itab`); `Rvalue::TryClass` walks its base chain
comparing descriptor *addresses* (`gf_is_a`). Addresses, not names, is what makes
§11.3 work across a library boundary.

**Descriptor keys are a hash of the interface's name**, never its `InterfaceId`.
Ids are numbered per compilation and two modules would disagree the moment
`static-lib` exists. `vtable::interface_key`, FNV-1a.

**Itab tables are flattened onto every derived class**, not inherited. A derived
class needs its *own* itab holding its *own* final overriders — inheriting the
base's gives the right shape and the wrong bodies, which nothing about the
program looks wrong while doing. `Lowerer.implement` propagates, and is
idempotent because it re-enters itself.

**`Reference<C>` keeps the dynamic type; a by-value `C` slices.** That pair of
behaviours is the reason `Reference<T>` is written rather than inferred, and
`tests/classes.test.ts` pins both in one test.

**No lifetime extension** (§4.4). Borrowing a temporary is fine as an
*argument* — it dies at the end of the enclosing full-expression, after the call
returns — and is `GF0234` as a *binding*, which would outlive it. `Typed.borrowsTemporary`
carries the distinction, set in `#toClassReference` and read only in the
declaration path.

**Watch `addressed_locals` when adding an `Rvalue` that holds a `Place`.** It
decides which locals get a stack slot, and a place held *directly* by an rvalue
rather than inside an operand is invisible to it — the result is
`_n is projected into but lives in a register`, a panic rather than a wrong
answer. `rvalue_places` is the list to extend, and it sits next to
`rvalue_operands` for that reason. `Rvalue::Len` had this bug from milestone 5
and nothing reached it until class references existed.

---

## Opaque handles

`declare class FILE { private _opaque: never }` — the shape the prelude's
pointer commentary has always recommended, now implemented. **An ambient class
is an opaque handle**, and that is the whole rule: `declare` says the
implementation lives elsewhere, and for a class the layout lives there too. The
private member is tsc's business — it is what keeps two handles nominal — and
the compiler never reads it.

It is its own MIR variant, `TyKind::Opaque(SymId)`, and the reason is worth not
losing. The tempting representations for "no layout" are a zero-field struct or
a `Void` pointee, and **both have a layout**: size 0, align 1. So `p[i]` strides
by nothing, `offset` adds nothing, and `free` hands `dealloc` a size of zero —
a corrupt heap rather than a diagnostic. POINTER-ERASURE.md worked this out for
`erase()` and it applies unchanged here. `Opaque` has no layout at all, so
`layouts.layout` and `layouts.repr` both `internal_error!` on one, and a missed
frontend check is a loud panic instead of a silent wrong answer.

Which matters, because **nothing here refuses itself**. Eleven operations
reached the backend and panicked before the checks existed. They are now
`GF0302`, from two guards in `lower.ts`:

- `requireKnownLayout` — `p[i]`, `p.offset(n)`, `p.deref()`, `p.free()`,
  `p.freeArray()`, `alloc`, `allocArray`, `sizeOf`, `alignOf`.
- `requireValueForm` — a parameter, a return, a struct field (including a
  nested one), an array or `FixedArray` element.

`p.address` is deliberately still allowed: it is the one member that never
needed a size. If you add a member to `CorePointer<T>`, ask which of those two
guards it belongs behind — the answer is almost never "neither".

That guard is what made `void *` cheap when it landed a few days later
(DECISIONS §13). `Pointer<unknown>` erases to `Pointer<void>`, which has the
zero-size problem this section describes and none of the refusals for free — but
`requireKnownLayout` was already the one place they all pass through, so it took
a single `void` arm rather than the five hand-written guards POINTER-ERASURE.md
budgeted for. `erase` and `reify` sit *in front of* the guard, with `address`,
because they relabel the address rather than read through it.

The C header forward-declares each handle it mentions (`struct FILE;`) and
spells the pointer `struct FILE*`, which is C's own incomplete type.
`tests/libraries.test.ts` builds a real C consumer against one, because a C
compiler is the arbiter of whether that spelling is right.

---

## What the first System V run found

The Linux job in `.github/workflows/ci.yml` had never run, and §6 is blunt about
what that is worth: "the classification is the part of a compiler where 'looks
right' is worth nothing." So it was finally run, on Ubuntu with GCC 15 and
CMake, against a cold checkout.

**The System V classification was right.** Every case in
`tests/struct-abi.test.ts` passed on the first attempt — the eightbyte split,
`struct { float, float }` into one SSE register, `struct { int, float }` into one
integer register, the twelve-byte two-eightbyte case Win64 passes by address, the
hidden return pointer, and the sub-register-width extensions. The half of this
compiler that had never been executed turned out to be correct as written, which
is a pleasant answer and not one that could have been assumed.

What the run *did* find was in code that has nothing to do with the C ABI.

**Self-assignment was corrupting memory, on every platform.** `Assign` destroyed
the destination before evaluating the source, so `s = s` released a buffer and
then cloned it. glibc turns that into `SIGABRT`; Windows' heap had been quietly
handing back a plausible answer, which is why 727 tests and a C++ oracle had
never noticed. It is not a Linux bug — Linux is only where it stopped being
silent, which is exactly the argument §6 makes for running the second platform.

The fix is `assignment_overlaps` / `assign_overlapping` in `translate.rs`: when
an assignment reads the local it writes, the new value is built *before* the old
one is destroyed. Aggregates clone into a stack temporary and then move the bytes
home; a one-word handle needs no temporary, because the clone is already a
separate value by the time the old handle is released. A move out of the very
place being assigned is a no-op — the value is already there, and destroying
would release the thing being moved in.

The overlap test is **by local, not by place**: `a[i] = a[j]` takes the careful
path whether or not the indices turn out to be equal. Paying for a temporary is
the better half of that trade — the other half is proving two indices differ,
and being wrong about it corrupts the heap.

`rvalue_reads` is the third member of the `rvalue_places` / `rvalue_operands`
pair, and the same warning applies: **an rvalue that reads a place and is not
listed there will miscompile a self-assignment.** It errs towards naming a place
that is not really read, because that costs a temporary, and the other error
costs a use-after-free.

**`_strdup` is not a POSIX name.** `tests/cstring.test.ts` declared the MSVC
spelling; POSIX standardised it unprefixed. A `declare` names the C symbol
exactly, so this was the test's bug and not the compiler's — the test now picks
the spelling per platform.

### Two things to know before running this on a fresh Linux box

**The runtime staticlib must be built before the suite, not inside it.** A cold
`cargo` build of `packages/runtime/native` takes tens of seconds, `buildRuntime`
caches per process, and so whichever test compiled first was billed for a fixture
against bun's five-second timeout — and lost. Worse, the timeout killed cargo
mid-build, so the report was "building the Goblin runtime failed:" followed by
nothing at all, on three tests in `modules.test.ts` that had no connection to the
runtime. `bunfig.toml` now preloads `tests/preload.ts`, which builds it once with
no test's clock running.

**`cargo fmt --all --check` is not clean on rustfmt 1.9.** Ten hunks in
`goblin-codegen`, all of them rustfmt changing its own mind about line breaking
since the version this was written against. None is a real formatting problem and
none was introduced by the System V work — reformatting was left alone rather
than mixed into an unrelated change, which is the rule this file's neighbours
already follow. Whoever bumps the pinned toolchain should do it in a commit of
its own.
