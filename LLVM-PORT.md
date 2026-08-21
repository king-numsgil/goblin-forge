# Porting the backend to LLVM

The *why* is [`DECISIONS.md`](DECISIONS.md) §17 and is not re-argued here: LLVM
replaces Cranelift, it happens before any vector work, the IR is emitted as text
and compiled by a `clang` subprocess, and `x86-64-v3` is the baseline. Read §17
first. This file is the *how* — the order the work happens in, what each step is
finished by, and the specific places where the port can go wrong quietly.

The plan is built around one constraint that dominates everything else. §17
records it as a risk; it is really the shape of the whole schedule:

> **LLVM's failure mode for a whole class of mistakes is a silent miscompile.**

Cranelift's verifier or a panic caught a malformed lowering before it reached an
object file. LLVM's verifier checks structure, not intent — a `byval` with the
wrong alignment, an `sret` on the wrong parameter, a GEP off by one field all
produce a module that verifies, links, runs, and is wrong. So every stage below
ends at a *behavioural* checkpoint rather than at "it compiles", and the two
stages most exposed to this get an oracle built before the code they check.

---

## Ground truth, measured on this machine (2026-08-21)

§17's toolchain survey was 2026-08-18. Re-checked, and extended with the parts
that change the plan:

- `clang` 22.1.8, `x86_64-pc-windows-msvc`, on `PATH`. `lld-link`, `ld.lld`,
  `llvm-ar`, `llvm-objdump`, `llvm-mca` present. Still **no** `llc`, `opt`,
  `llvm-as`, `llvm-dis`, `llvm-mc` or `FileCheck`. None of them are on the
  critical path.
- `clang -c module.ll -o module.obj -O2 -march=x86-64-v3` works and produces a
  COFF object. §17's `vadd` disassembly reproduces exactly — `vmovapd (%rcx)`,
  `vaddpd (%rdx)`, `retq`.
- **Spawn cost is ~55 ms per module** (ten invocations in 0.55 s, cold-ish).
  That is the whole of what the subprocess design costs per module, and it is
  not a number worth designing around.
- **The module triple has to be spelled exactly or the warning has to be
  suppressed.** A `.ll` with no `target triple` line, and a `.ll` naming
  `x86_64-pc-windows-msvc`, both draw
  `warning: overriding the module target triple with
  x86_64-pc-windows-msvc19.43.34810 [-Woverride-module]`. Only the full
  MSVC-versioned spelling is silent, and that version is not something this
  compiler can know. So: emit no triple, pass `--target=`, and pass
  `-Wno-override-module`.

### What clang actually emits at the C boundary

This is the finding that most changes the plan, and it was cheap to get —
`clang -S -emit-llvm` on three C prototypes, once per convention:

| C signature | Win64 | System V |
|---|---|---|
| `Twelve f1(Twelve)` (12 bytes) | `void @f1(ptr sret(%Twelve) align 4, ptr dead_on_return)` | `{ i64, i32 } @f1(i64, i32)` |
| `TwoFloats f2(TwoFloats)` (8 bytes, 2×f32) | `i64 @f2(i64)` | `<2 x float> @f2(<2 x float>)` |
| `Big f3(Big)` (24 bytes) | `void @f3(ptr sret(%Big) align 8, ptr dead_on_return)` | `void @f3(ptr sret(%Big) align 8, ptr byval(%Big) align 8)` |

Three things fall out of that table, and all three are load-bearing:

**Win64 by-address is a plain `ptr`, not `byval`.** The caller `memcpy`s into
its own alloca and passes the address. System V's MEMORY class *is* `byval`, and
LLVM makes the copy. `abi::Slot::ByAddress` and `abi::Slot::OnStack` are already
two different variants for exactly this reason — the port must keep them
distinct, and swapping them is a silent miscompile on the stack rather than a
crash.

**Our carriers are coarser than clang's, and that is fine.** This started as a
suspected defect and probing killed it, which is worth recording so nobody
re-derives the wrong half. For the 12-byte struct clang declares `(i64, i32)`
where `abi.rs`'s `eightbytes()` says `[I64, I64]`, and the tempting reading is
that an `i64` load off a 12-byte object runs four bytes past the end. It does
not. clang's rule is `GetINTEGERTypeAtOffset`, which names the carrier after the
field actually sitting at that offset — so `{i64,char}` is `(i64, i8)`,
`{i64,short}` is `(i64, i16)` — and falls back to `i64` when no single field
covers the eightbyte. An 11-byte `{i64,char,char,char}` is therefore
`(i64, i64)`: **clang itself declares a carrier three bytes wider than the
struct**, and relies on the padding of the alloca it copies out of, exactly as
`scatter_carriers` relies on its scratch slot. A 5- or 6-byte struct stays a
plain `i64` for the same reason.

Reproducing that rule would be real work buying nothing, since none of it
changes which bytes land in which register. So the divergence is written down in
`Slot::Registers` and left alone, and stage 4's differential suite is what holds
the claim up. The float half diverges the same way and for the same reason:
clang spells an all-float eightbyte `<2 x float>` and a lone trailing one
`float`, where we say `F64` throughout.

---

## File-by-file disposition

| file | lines | fate |
|---|---|---|
| `link.rs` | 468 | untouched, outright |
| `layout.rs` | 401 | one `use`, one `Repr` variant, one `pointer_type` |
| `abi.rs` | 755 | classification untouched; the `ClifType`/`AbiParam` vocabulary swapped, one bug fixed |
| `runtime.rs` | 204 | signature declarations re-spelled; the `RuntimeFn` table itself untouched |
| `vtable.rs` | 288 | `DataDescription` → LLVM global constants; layout and bias unchanged |
| `translate.rs` | 2770 | rewritten against a new emitter, but mechanically — ~50 opcodes, each with a direct equivalent |
| `object.rs` | 266 | replaced |

The instruction set in use, counted: `iadd_imm_s` ×17, `iconst` ×15, `load` ×10,
`iadd` ×9, `jump` ×7, `stack_addr` ×6, and a tail of forty more each appearing
once or twice. Every one has a one-line LLVM spelling.

---

## Tracking

- [x] **Stage 0** — Cranelift out of the type vocabulary *(done 2026-08-21)*
- [x] **Stage 1** — the emitter skeleton, the backend switch, and the ABI oracle
      *(done 2026-08-21)*
- [x] **Stage 2** — types, globals, and the data half *(done 2026-08-21)*
- [ ] **Stage 3** — function bodies
- [ ] **Stage 4** — the C boundary
- [ ] **Stage 5** — options, targets, and the `.ll` beside the object
- [ ] **Stage 6** — delete Cranelift
- [ ] **Stage 7** — debug information

Decided along the way, so it does not get re-litigated:

- **The backend stays in Rust.** Emitting LLVM IR from the TypeScript frontend
  was considered and rejected. MIR is load-bearing regardless — drop elaboration
  is a dataflow pass over its CFG and cannot run on LLVM IR, where ownership has
  already been erased — but the boundary itself was the real question. Staying
  in Rust keeps `llvm-sys` reachable as the later in-process option, and §17
  notes that door needs an LLVM built from source to walk through, so it is
  worth not closing.
- **Both backends do not stay.** The switch is a test lever for stages 1–5 and
  is deleted at stage 6.

## Stage 0 — Get Cranelift out of the type vocabulary

**Done.** No behaviour change beyond the baseline fix below; full suite green.

§17 calls this out as worth doing separately, and it is the step that makes the
rest a port rather than a rewrite. Today `layout.rs` and `abi.rs` speak
`cranelift_codegen::ir::Type`, so the two files that must survive intact are
written in the vocabulary of the thing being removed.

1. Introduce a backend-owned scalar enum in `layout.rs` — `I8 I16 I32 I64 F32
   F64 Ptr` — and make it what `Repr::Register` and `Slot::Registers.carriers`
   carry. `TargetInfo::pointer_type()` returns it.
2. `abi::extended` stops returning an `AbiParam` and starts returning the
   *extension* as data (`None | Sext | Zext`); the choice is the ABI rule, the
   `AbiParam` was the encoding.
3. `abi::to_signature` moves out of `abi.rs` into the Cranelift layer. It is the
   only function in the file that is about Cranelift rather than about the ABI,
   and it will have an LLVM sibling.
4. `Conv::of_call_conv` dies. `Conv::of(&Triple)` already exists and is the real
   rule; the call-conv detour exists only because `object.rs` had an ISA to ask.
   An unsupported architecture is now a loud failure rather than a guess at
   System V.

**Done when:** `grep -c cranelift` is zero in `abi.rs` and `layout.rs`, and
`bun test` plus `cargo test` are unchanged and green.

### What landed

`Scalar` (`layout.rs`) is the new vocabulary, and `clif.rs` is the only file
that turns it into `cranelift_codegen::ir` — signatures, parameter attributes
and all. `abi.rs` and `layout.rs` are now free of Cranelift entirely; `abi.rs`
kept its classification untouched and gave up `to_signature`, which was the one
function in it that was about a code generator rather than about the ABI.

**`Scalar::Ptr` is deliberately not `Scalar::I64`.** Cranelift has no pointer
type and wants the integer width; LLVM has an opaque `ptr` and wants nothing
else. `usize` is the integer, a `Pointer<T>` is the pointer, and the distinction
is now recorded once instead of being re-derived at each load. `clif.rs`
collapses the two — that collapse is a code generator's business, and it is the
kind of thing the next one must not inherit.

Also landed, because §17 lists both as live faults independent of the port and
the AVX2 baseline is now an accepted crash-if-absent requirement:

- `make_isa` enables the six `x86-64-v3` features on **both** paths. Previously
  the host path detected them and `isa::lookup` on an explicit triple did not,
  so naming your own machine's triple produced different code from naming
  nothing. `the_baseline_is_actually_enabled` and `the_host_and_its_own_triple_agree`
  read the flags back off a finished ISA, because `builder.enable` discards a
  misspelled setting in silence.
- `packages/runtime/src/build.ts` passes `-C target-cpu=x86-64-v3`. The runtime
  already goes through LLVM and was being built at baseline, so `gf_string_concat`
  and friends were the one part of a program compiled for a 2003 CPU. Verified in
  the object: `vmovups`, `vzeroupper`, `tzcnt`, `bzhi`.

881 TS tests, 35 Rust tests, `tsc --build` and `cargo clippy -D warnings` clean.

## Stage 1 — A second backend behind a switch, and the ABI oracle

**Nothing compiles through LLVM yet. The scaffolding and the safety net.**

Add `crates/goblin-codegen/src/llvm/` with an IR text emitter (value naming,
type printing, string escaping, function writing), a MIR-type → LLVM-type
mapping driven by `Layouts` so offsets agree by construction, and a driver that
writes a `.ll` and spawns clang.

Selection is `CodegenOptions.backend`, threaded to a `backend` field on the napi
`BackendOptions` and readable from `GOBLIN_BACKEND`. **This is the central
testing lever of the whole port**: the existing 736-test suite is the acceptance
criterion, and being able to run all of it under either backend, one failure at
a time, is what turns a rewrite into a bisect. Cranelift stays until stage 6.

Build the ABI oracle *now*, before the code it protects. Given a MIR signature,
it renders the equivalent C prototype, runs `clang -S -emit-llvm` for both
triples, and compares the declaration against what `abi.rs` + the new LLVM
signature writer produce. clang is on `PATH` and the round trip is milliseconds,
so this is the cheapest possible defence against the one failure mode §17 says
is not compressible by throwing compute at it.

**Done when:** the oracle runs on both triples from either host and agrees with
`abi.rs` on every shape currently in `abi.rs`'s unit tests, plus the three from
the table above. Also: one hand-written smoke module compiled by clang, linked
by the untouched `link.rs` against the MSVC-built Rust runtime staticlib, and
run. That confirms COFF interop end to end before anything depends on it.

### What landed

`crates/goblin-codegen/src/llvm/` — `ty.rs`, `sig.rs`, `driver.rs` — plus
`Backend::{Cranelift, Llvm}` on `CodegenOptions`, a `backend` field on the napi
options, and `GOBLIN_BACKEND` behind both. `link.rs` is untouched, as promised.

**LLVM never computes a layout; ours is imposed.** Every aggregate renders as a
*packed* struct with its padding spelled out — `<{ i32, [4 x i8], i64 }>` —
driven by `Layouts`. Letting LLVM lay out a `{ i32, i64 }` itself would mean two
layout engines that agree until they do not, and the symptom of that
disagreement is a field read from the wrong offset. The cost is that a packed
struct has alignment 1 to LLVM, so every use carries an explicit `align`.

**`GOBLIN_BACKEND=llvm` fails loudly rather than producing a broken binary.**
Bodies are stage 3, so the LLVM path emits types and declarations, writes the
`.ll`, has clang check it, and then says what it cannot do and where the IR is.
An object that links and does nothing would have been the wrong kind of honest.

Two things the new tests caught immediately, both worth recording:

- **Parameter and return extension attributes go on opposite sides of the
  type.** `declare signext i8 @f(i8 signext)` — the return attribute precedes
  the result type, the parameter attribute follows its own. Written backwards
  first; `every_type_shape_parses` failed on it within a minute of existing.
  Confirmed against clang rather than guessed.
- **The oracle has teeth.** Spelling Win64's `ByAddress` as `byval` — the exact
  silent-corruption swap `Slot`'s two variants exist to prevent — was
  deliberately introduced and the oracle named every affected case and both
  answers. It also passed on the first honest run for both conventions, which
  is the more reassuring half.

The oracle covers fifteen shapes in both argument and return position on both
triples, unions included — a union's eightbyte merges every overlapping member,
so `union { char; double; }` is INTEGER, and `SDL_Event` is the reason that is
not a corner case.

40 Rust tests, 881 TS tests, `tsc --build` and `cargo clippy -D warnings` clean.

### Still owed, and deliberately not done here

- **Classes and interfaces have no named type yet.** `Types::aggregate` handles
  them, but nothing exercises a real vtable-bearing class, because the module
  fixtures would need class tables — that arrives with stage 2's descriptors.
- **The oracle's fixtures are hand-built MIR.** Running it over the real corpus
  needs a napi seam that stage 3 will want anyway; adding one now would be
  surface invented ahead of a caller.

## Stage 2 — Types, globals, and the data half

Struct and fixed-array types; string literals in the runtime's 16-byte header
shape with the value being the symbol's address plus 16; class descriptors,
vtables and itabs.

The vtable bias is the one place to be careful: the object's pointer aims at the
*first method slot*, one pointer past the object, so the constant expression is
`getelementptr(i8, ptr @__gf_vt$Dog, i64 8)` rather than the global's own
address. `vtable.rs` documents why; the arithmetic does not change, only its
spelling.

Data is a good second stage because it is verifiable without running anything:
`llvm-objdump` on the object, and the linker resolving every symbol.

**Done when:** a module of nothing but classes and literals compiles, links, and
`llvm-objdump` shows the same relocations and the same bytes the Cranelift path
produces.

### What landed

`llvm/data.rs` (the `Word`/`Globals` constant writer), `llvm/vtable.rs` (the
class tables), and `Literals` on the module emitter. Every object is `internal
constant <{ … }>` with an explicit `align` — packed for the same reason `ty.rs`
is packed, and aligned because a packed struct is align-1 to LLVM while a string
literal's header is two `u64` loads the runtime performs at a negative offset.

**The comparison method changed, and the replacement is better.** Diffing
`llvm-objdump` output against the Cranelift path was the stated checkpoint;
section naming and ordering differ enough between the two that the diff would
have tested the differences rather than the data. What replaced it:

- The descriptor, vtable, itab and name constants are asserted **as text**, for
  a class with a base, an interface and two methods. Word *order* is the
  contract and the itab address carries a one-pointer bias; both are
  off-by-one-shaped, and an off-by-one here is a wrong answer from `instanceof`
  rather than a crash. The interface key is recomputed in the test rather than
  copied.
- The bias is checked **at run time**, by a linked program that does what a
  compiled object does: hold a vtable pointer aimed at slot 0, reach the
  descriptor at `[-1]`, read its first word, and exit non-zero if it is not the
  name. Verified to fail when the emitted vtable is perturbed. It also prints an
  emitted literal, which proves the sixteen-byte header sits in front of the
  text rather than in it.

That pair covers what the objdump diff was for — that the bytes and the
relocations are right — and the second half covers something the diff could not
have: that the arrangement is right *when a program depends on it*.

**`module.globals` is untouched, and so is the Cranelift path.** Module-level
constants and statics are unimplemented on both backends; the port owes nothing
here that was not already owed.

Real programs now emit real data. Under `GOBLIN_BACKEND=llvm` a class program
renders its `__gf_name$`, `__gf_desc$` and `__gf_vt$` objects — `$` needs no
quoting, being in LLVM's bare identifier set — and then stops at stage 3.

47 Rust tests, 881 TS tests, `tsc --build` and `cargo clippy -D warnings` clean.

## Stage 3 — Function bodies

**The structural simplification, and the one thing to state plainly before
anyone benchmarks.**

`translate.rs` today decides per local between an SSA `Variable` and a stack
slot, because cranelift-frontend builds SSA and inserts block parameters. LLVM
has no such helper and needs none: MIR blocks carry no parameters, so the
answer is clang's own — **every local is an `alloca` in the entry block, and
mem2reg builds the SSA.** `LocalSlot::{Register, Indirect, Memory}` collapses to
one case, `Indirect` becoming simply an alloca that holds a pointer.

The consequence, said out loud so it is not discovered as a regression: at
`optLevel: "none"` LLVM does not run mem2reg, so every local really does live in
memory. That is exactly what `clang -O0` does, it is correct, and it will make
test binaries slower than today, because the harness's default is `"none"`. It
is not a problem and it is not worth fixing.

Then the opcode transcription. `Switch` → `switch`. `trap` → `call void
@llvm.trap()` followed by `unreachable`. `fcvt_to_sint_sat` →
`@llvm.fptosi.sat.*`. `stack_addr` → the alloca. `symbol_value` → the global.
The `_imm` forms fold into constants.

**Emit no `nsw`, no `nuw`, no `noalias`, no TBAA, no poison-generating flags.**
§17: the hazard is asserting one accidentally and having it be true for two
years. There should be exactly one place in the emitter where such a flag could
be attached, and it should be empty with a comment saying why.

Cleanup blocks keep trapping. Nothing can unwind yet, `invoke` and `landingpad`
stay unbuilt, and the port owes nothing new here.

**Done when:** the suites that do not cross the C boundary — `control-flow`,
`operators`, `structs`, `classes`, `arrays`, `strings`, `heap`, `ownership` —
are green under `GOBLIN_BACKEND=llvm`, including the automatic live-allocation
check on every `run` test.

## Stage 4 — The C boundary

`Slot` → LLVM parameters and attributes: `sret(T) align N` first, `byval(T)
align N` for System V MEMORY, a bare `ptr` for Win64 by-address with an emitted
`memcpy` at the call site, `signext`/`zeroext` for sub-register integers.

`Slot::Registers` is the work. LLVM has no "pass this struct as these carriers";
the carriers must be spelled as literal parameters, with the caller storing the
aggregate to a temporary and loading the carriers back out, and the callee doing
the reverse. That is what clang emits and it is where a wrong answer is quietest.

The oracle from stage 1 is now doing its job, alongside `tests/struct-abi.test.ts`
and the C++ oracle.

**Done when:** `struct-abi`, `cstring`, `libraries`, `function-pointers` and the
`tests/oracle/` differential suite are green under LLVM on Windows, and the
Linux CI job is green for System V.

## Stage 5 — Options, targets, and two standing faults

- `target` → `--target=`; `opt_level` → `-O0` / `-O2` / `-Oz`;
  `-march=x86-64-v3` unconditionally; `-Wno-override-module`; `-fPIC` where the
  platform wants it.
- **The host/explicit-triple divergence disappears.** §17 records that
  `make_isa` gives the host AVX and FMA but an explicitly-named triple a
  baseline ISA, so `--target x86_64-pc-windows-msvc` and no `--target` silently
  produce different instruction sets. clang takes a triple and a `-march`
  uniformly, so there is no second path to diverge. The fault is fixed by the
  port rather than around it, and it does not need an interim patch.
- **`packages/runtime/src/build.ts:69` gets `-C target-cpu=x86-64-v3`.** Today
  the runtime is compiled at baseline. Independent of the port, small, and it
  belongs in the change that establishes the baseline.
- `verify_ir` loses its meaning — clang verifies everything it parses. Retire
  it, and replace it with keeping the `.ll` beside the object. That is free, and
  it is the diffable, paste-into-Godbolt benefit §17 wanted from this design.

**Done when:** `build-options`, `cli`, `pipeline` and `backend-contract` are
green under LLVM, and `backend-contract` in particular still distinguishes a
panic from a clean rejection.

## Stage 6 — Delete Cranelift

Only after the whole suite is green under LLVM on Windows *and* the Linux CI
job. Remove the five `cranelift-*` dependencies, the `backend` switch, and
`object.rs`'s ISA construction. The committed `.node` addon gets smaller, which
is the distribution argument §17 made for text IR in the first place.

## Stage 7 — Debug information

Deliberately after the switch, so the port lands without it. `debug_info: bool`
is currently declared, threaded, and read by nothing — §17 calls it a lie. This
is where it stops being one: `DIFile` from `module.files`, `DISubprogram` per
function, `DILocation` from the spans MIR already carries. DWARF and CodeView
both come out of the same metadata, which is the reason this was one of the four
arguments for the port.

**Done when:** a breakpoint in a Goblin function stops in a debugger, and a
profile symbolizes.

---

## Then the thing this was all for

MIR vector types, the packed/aligned `dvecN` pair, `__m256` classification,
contraction semantics. Out of scope here — §17 is clear that this is most of the
calendar time and that it is required under either backend. The point of the
ordering is that it happens once, on top of LLVM, instead of twice.

---

## Two questions worth settling before stage 1

**Do both backends stay?** §17 leaves the door open to rustc's arrangement —
Cranelift for debug builds, LLVM for release. The recommendation is no: keep the
switch as a test lever through stages 1–5 and delete it at stage 6. Two backends
is a permanent doubling of the surface where a silent miscompile can live, in
exchange for a compile-speed win against a measured 55 ms per module. Reopen it
if that number ever shows up in a profile.

**Does floating-point contraction get settled first?** §17 says it is a language
question, not a backend one, and that it should be answered before the port
rather than becoming a flag attached to whichever backend is underneath. It does
not block stage 0. It does want an answer before stage 3 writes `fadd` and
`fmul`, because "no contraction" is a default that has to be *chosen* — LLVM
will honour `contract` fast-math flags if they are ever emitted, and per stage
3, nothing should emit one by accident.
