# Generics, by monomorphisation

REWRITE-PLAN §11.7 asks the question — "monomorphisation or nothing" — and
DECISIONS §11.7 parks it, correctly, because nothing needed it yet. This file
answers it and says how the work is ordered.

The short version: **monomorphisation, in the frontend, before any MIR is
built.** Every distinct set of type arguments a generic is *used* with becomes
its own function, its own struct, its own class. `identity<i32>` and
`identity<f64>` are two functions that share a source declaration and nothing
else. Nothing about the MIR, the backend, the drop pass or the C boundary
changes, because by the time any of them sees the program there are no type
parameters left in it.

That is not a preference. Everything below §1 is the argument that the
alternative — one shared body, uniform representation, dictionaries passed at
run time — is not a smaller change than monomorphisation but a much larger one,
and would have to undo two of the rules the compiler is built on.

---

## 1. Why the alternative is not available here

A polymorphic language has to answer, for a value of type `T`: how big is it,
how is it copied, how is it destroyed, and how is it laid out inside something
else. There are exactly two ways to answer. Monomorphisation answers at compile
time by making `T` concrete. Uniform representation answers at run time by
making every `T` the same size — a pointer — and passing the copy and destroy
operations alongside it as a witness table. Java boxes; Go passes gcshape
dictionaries; Swift passes value witness tables.

Five things in this compiler close the second door.

**The MIR has no type variable.** DECISIONS §11.7 already records that "either
answer leaves the MIR monomorphic". There is no `TyKind` for a type parameter,
no struct whose size is a run-time value, no `sizeof` that is not a constant.
A shared body would have nothing to be shared *as* — it would need a MIR that
does not exist and a wire-format change to add it.

**Ownership is written down, never inferred** (CLAUDE.md, rule one). Every type
has a category computed once from the type, and every value a storage class
that is a static property of a place. A `T` has neither until `T` is known: it
is `trivial` for an `i32` and `owning` for a `string`, and the copy at a
binding is a `memcpy` in one case and a clone in the other. Copy and move are
separate MIR nodes *chosen by the frontend*. A frontend that does not know
which one to write is the exact failure mode REWRITE-PLAN §4.1 catalogues.

**Drops are placed by a pass from CFG liveness**, from the concrete type. A
polymorphic body would need its drop glue passed in as a function value — and
the compiler already knows what that costs, because it says so in
`packages/checker/src/types.ts:329`, where a `T[]` inside `T` is refused with:

> This is a gap rather than a rule: it wants the copy and the drop to be
> *functions* that call themselves, which is how `std::vector<T>` inside `T`
> works in C++.

Out-of-line copy and drop glue is a real feature this compiler does not have.
Uniform representation would require building it *first*, and then building
witness tables on top. Monomorphisation requires neither.

**Layout is C's, inline, and never reordered.** A `Pair<T>` has no offsets
until `T` is known, and the whole point of the layout rules is that the bytes
match what a C compiler produces for the same declaration. There is no
declaration to match for a `Pair<T>`.

**The width pass needs a width.** `GF0161` refuses a plain `number` because
"the machine type is written down rather than guessed". A `T` in arithmetic
position is that same hole one level up, and it gets the same answer.

The precedent is already in the tree, and DECISIONS §11.7 is careful to say it
is *not* a foundation: `cast<T>`, `sizeOf<T>`, `alignOf<T>`, `zeroed<T>`,
`FixedArray<T, N>` and `reify<U>` are generic in the source and read their type
argument off the resolved type at the use site, burning a concrete answer into
the code. §11.7 is right that special-casing six intrinsics is not a generics
implementation. It is, however, exactly the right *shape*: the type argument is
tsc's answer at the use site, and the code that comes out has no `T` in it.
Monomorphisation is that, generalised and given a worklist.

### What it costs, stated plainly

- **Code size.** Each instantiation is a full copy. This is C++'s and Rust's
  bill and there is no version of this that does not pay it.
- **Compile time**, linearly in instantiations.
- **A generic has no symbol**, so it is not something a linker can hand over. A
  `static-lib` or `shared-lib` exports symbols, and a generic has none until it
  is instantiated — which happens in whoever *uses* it. Rust and C++ pay this
  the same way and answer it the same way: the generic's body travels with the
  library and is compiled into the consumer. So does this. §6 is how.

---

## 2. What TypeScript decides for us

This is the part that is easy to get wrong by analogy, because the two
languages people reach for behave differently and Goblin inherits one of them
without a choice in the matter.

**TypeScript checks a generic at its definition, not at its instantiation.**
`function f<T>(x: T) { return x.foo() }` is an error at the declaration, not at
`f<Dog>(d)`. C++ templates are the opposite — a template body is checked once
per instantiation, which is what makes duck-typed templates work and what makes
their errors famous.

So **Goblin's generics are Rust-shaped, not C++-shaped**: what you may do with
a `T` is what its constraint permits, decided once, at the declaration. This is
not a rule this compiler has to implement or enforce. tsc enforces it before
the compiler is called, and the diagnostic is a `TS####` that underlines in the
editor — which REWRITE-PLAN §8 says is the preferred half of the two whenever
the rule can be expressed in the type system.

It also means the compiler does **not** get to re-check a body per
instantiation, and does not want to.

### Which does *not* mean instantiation cannot fail

`function identity<T>(x: T): T { return x }` type-checks. `identity<Speaker>`,
for a contract, does not have a machine meaning — a contract has no value form
(`GF0002`). Erasure is a Goblin rule that tsc knows nothing about, so a body
that is fine generically can be refused at one instantiation and accepted at
another.

That makes an **instantiation backtrace** a requirement rather than a nicety: a
diagnostic raised while lowering `identity<Speaker>` must underline the thing
in the body that has no representation *and* say where `T` became `Speaker`.
The diagnostic model already carries this — `Note` has an optional `Location`
and `format()` renders it with its own excerpt — so this is a matter of
threading a note through, not a model change.

### What tsc actually accepts (probed, 2026-08-28, not assumed)

Compiled against the real prelude. `(clean)` means tsc raised nothing and only
`GF0001` — the existing "a generic function is not supported yet" — stopped it.

| Written | tsc says |
|---|---|
| `function first<T>(xs: T[]): T { return xs[0] }` | clean |
| `function count<T>(xs: T[]): usize { return xs.length }` | clean |
| `function swap<T>(a: Pointer<T>, b: Pointer<T>)` | clean |
| `interface Pair<T> { a: T; b: T }`, used as `Pair<i32>` | clean |
| `class Box<T>` | clean |
| `function twice<T extends i32>(x: T): T { return x + x }` | `TS2322` |
| `function twice<T extends i32>(x: T): T { return cast<T>(x + x) }` | clean |
| `function firstOf<T>(p: Pointer<T>): T { return p.deref() }` | `TS2322` |
| `function ask<T extends Speaker>(x: Reference<T>): i32 { return x.speak() }` | `TS2339` |

Three of these shape the staging directly.

**Arithmetic on a bounded numeric parameter needs `cast<T>`.** `x + x` where
`x: T extends i32` has type `number` to tsc, which is not assignable to `T`.
Writing `cast<T>(x + x)` is clean — and `cast` is already the intrinsic that
reads its target width off the call's resolved type, so under substitution it
gets a concrete width for free. Numeric generics are reachable; they just are
not silent.

**`Reference<T>` over a type parameter does not work at all.** The prelude
declares it as a conditional type, for a good reason recorded in
`global.d.ts`:

```ts
type Reference<T> = [T] extends [GfPrimitive] ? ReferenceCore<T> : T & ReferenceCore<T>;
```

Over an unresolved `T`, tsc defers the conditional and resolves member access
against the union of both branches — `ReferenceCore<T> | (Speaker &
ReferenceCore<T>)` — which has no `speak`. Adding `& object` to the constraint
does not help. `p.deref()` returns `Reference<T>` and hits the same wall from
the other side (`TS2322`).

This is a **prelude problem, not a lowering problem**, and it is the single
thing standing between this plan and constraint-bounded generics that call
methods. It gets its own stage and its own spike (§6, stage 5), because the
answer may well be a change to how `Reference` and `Pointer` are declared, and
that is a decision with blast radius well beyond generics.

---

## 3. The bug that had to be fixed first *(done, 2026-08-28)*

Found while probing this, and it is not a generics bug — generics only make it
easy to hit. **Two structs with the same name silently share a layout.**

`packages/checker/src/types.ts`, `structNameOf`, names a struct from its symbol
and nothing else. `packages/forge/src/lower/module.ts`, `#structTy`, interns by
that name, and says so:

> By name rather than by shape: erasure already decided what the name is, and
> two types with the same fields in a different order are different layouts.

The second half is right. The first half assumes the name is unique, and it is
not. Two programs, both accepted with **no diagnostic**, both wrong:

```ts
// main.ts                          // other.ts
interface Pair { a: i32; b: i32 }   interface Pair { a: u32; b: u32 }
```

`-1 < 0` in `main.ts` prints `not less`. Whichever file tsc hands over first
interns `Pair`, and the other one gets its layout and its signedness.

```ts
interface Pair<T> { a: T; b: T }
const small: Pair<u8>  = {a: 1, b: 2};
const big:   Pair<f64> = {a: 1.5, b: 2.5};
```

Both instantiations are the struct named `Pair`. This one is loud, but it is
loud in the worst possible way: it reaches clang, which answers `Intrinsic has
incorrect argument type! ptr @llvm.fptosi.sat.i32.i8`, and the compiler reports
it as `GF9003` — *the compiler is broken*. For a program tsc accepted. That is
precisely the class of failure CLAUDE.md's second rule exists to prevent, and
LLVM-PORT.md's governing constraint ("LLVM's failure mode for a whole class of
mistakes is a silent miscompile") in its purest form.

The compiler already knows about this hazard and has fixed it twice, in one
direction each time:

- `linalgStructName` emits `linalg.dvec3`, not `dvec3`, precisely so a user's
  own `dvec3` does not take the compiler's layout — and `.` is unforgeable in a
  TypeScript identifier, which is what makes it safe.
- `collectClasses` **refuses** two classes of the same name outright, with a
  comment saying qualifying is the right fix, is not free, and is cheap to lift
  later.

Structs got neither.

### What it turned out to be

`layoutKey` in `packages/checker/src/types.ts`. A struct is its **name and its
layout, together**, and neither half alone:

| Two declarations | Same struct? |
|---|---|
| `Point {x: i32; y: i32}` in each of two files | yes — one name, one layout |
| `Pair {a: i32}` and `Pair {a: u32}` | no — the layouts differ |
| `Point {x: i32}` and `Vec2 {x: i32}` | no — the names differ |

Cycles close on a de Bruijn back reference, which is what keeps
`interface Node { next: Pointer<Node> }` finite *and* canonical, so two
identical recursive `Node`s in two files still key alike. `sameType` compares
the same key, so what the frontend calls one type and what the module gives one
`TyId` cannot drift apart.

**Two things this cost that are worth knowing before touching it again.**

The first attempt keyed by *declaration site* — file plus name, the argument
`#keyOf` makes for functions. It over-shot: two files declaring the same
`Point` became two types, and passing one to the other came back as "this is a
`Point`, which does not convert to `Point`". A legal program, refused, with a
message naming one type twice. The rule is that the key may not be *finer* than
what `sameType` is willing to call equal, and that case is now a test.

The second is that fixing the frontend exposed the same conflation one layer
down: the itab symbol was `__gf_itab$<interface>$<class>`, and one class
convertible to two same-named contracts is two itabs under one symbol — an LLVM
redefinition. The `InterfaceId` is in the symbol now. Adding a
duplicate-interface-name refusal would have worked too and was the wrong
direction, because stage 5 wants the *class* one lifted rather than a second
one added.

---

## 4. The design

### 4.1 A substitution is a map from type parameter to concrete `ts.Type`

```ts
/** What each of an instantiation's type parameters actually is. */
export type Substitution = ReadonlyMap<ts.Symbol, ts.Type>;
```

Keyed by the type parameter's **symbol**, and mapping to a **`ts.Type`**, not
to a `MachineType`. Both halves of that are deliberate.

By symbol, because that is what makes an imported generic the same generic
however it is spelled at the call site — the same argument `#keyOf` and
`resolveCallee` already make for functions.

To a `ts.Type`, because erasure is not the only question asked about a type.
`classNameAt`, `arrayElementAt`, `linalgTypeOf` and the width pass all ask tsc
things, and a `MachineType` cannot answer them. Mapping to the concrete
`ts.Type` means every one of those keeps working by resolving the leaf first.

**Substitution happens at the leaf, in `erase`.** This is the whole trick and
it is why the change is small. `erase` already decomposes a type structurally —
`T[]` via `getIndexTypeOfType`, `Pointer<T>` via `pointeeOf`, `Pair<T>` via
`getPropertiesOfType` — so every composite reaches a bare `T` eventually, and
one new case at the top of the cascade handles all of them:

```ts
if (type.isTypeParameter()) {
    const bound = bindings.get(type.symbol);
    if (bound === undefined) {
        throw new ErasureError(/* GF0402: a T with nothing bound to it */);
    }
    return erase(checker, bound, state, bindings);
}
```

There is no need for a general `instantiateType` — which is just as well,
because tsc does not export one, and reaching into the internal checker for it
would be a dependency on an unstable API that this codebase should not take.

### 4.2 The substitution is threaded, not ambient

`erase` gains a fourth parameter; `Lowerer.erase(at, type, bindings)` gains a
third; `BodyLowerer` holds the substitution it is lowering under and passes it
at each of its ~14 `outer.erase` sites. The default everywhere is the empty
substitution, so every existing call site keeps working unchanged.

The tempting alternative is a mutable "currently instantiating" field on
`Lowerer` with push/pop around each body. Do not. `liftClosure` already runs
*while the enclosing function is mid-lowering*, so the stack discipline has a
re-entrant case on day one, and a substitution that is read from ambient state
is a property of the program that is not written down — which is the failure
mode the first of the two rules exists to prevent. Threading it costs about
twenty argument sites, once.

### 4.3 Names carry their type arguments, and their declaration

An instantiation's identity is `(declaration, type arguments)`. Two rules:

- A **named** aggregate is identified by its declaring symbol plus its erased
  type arguments. `Pair<i32>` declared in `a.ts` is one struct wherever it is
  used, and is not the `Pair` in `b.ts`.
- An **anonymous** one keeps being identified by its shape — `{a,b}` — because
  two identical inline object types genuinely are one type to tsc, and
  splitting them by file would be a behaviour change with no bug behind it.

The MIR name follows the `linalg.dvec3` precedent: use characters a TypeScript
identifier cannot hold, so a hand-written type can never forge one. `<`, `>`
and `,` are all unforgeable, and `Pair<i32>` reads correctly in a diagnostic.

Two consequences to keep in view:

- `renderType` and every diagnostic get the readable name for free.
- `packages/forge/src/header.ts`'s `identifier()` replaces every non-C
  character with `_`, so `Pair<i32>` becomes `Pair_i32_` in a generated header.
  That is acceptable and it is also where a *new* collision could be
  manufactured (`Pair<i32>` versus a user's `Pair_i32_`). It is a pre-existing
  property of `identifier()` — `linalg.dvec3` already relies on it — and it
  should be noted in the header module rather than fixed here.

### 4.4 Instantiation is a worklist, run to a fixed point

Lowering currently makes two passes: declare every function, then lower every
body. Generics add a third phase that alternates with the second, because
lowering a body is what discovers the instantiations it needs.

```text
declare non-generic functions and classes
    │
    ▼
lower bodies ──── discovers `identity<i32>` ────┐
    ▲                                            │
    │                                            ▼
    └──── declare + queue the instantiation ◄────┘
              (memoised by (declaration, type arguments))
```

Two properties this needs and does not get for free:

- **Memoisation by identity**, so `identity<i32>` called from forty places is
  one function. Keyed the same way §4.3 names things.
- **A depth limit.** `function f<T>() { f<Pair<T>>() }` type-checks and has
  infinitely many instantiations. Rust caps recursion depth and reports it;
  so does this, with a diagnostic naming the chain rather than a stack
  overflow inside the compiler.

### 4.5 Where a type argument comes from

At `identity<i32>(7)`, from `call.typeArguments` via
`checker.getTypeFromTypeNode` — all public API, all exact.

At `identity(i)`, tsc inferred it, and the public surface does not hand the
inference result back directly. What it does hand back is
`getResolvedSignature`, whose parameters are the *instantiated* types — so the
mapping is recovered by **unification**: walk the declaration's parameter types,
which still mention `T`, alongside the resolved ones, which do not, and read `T`
off wherever the two line up. Only three shapes need walking, and that is the
whole set rather than a shortcut: a bare `T`, a `T[]`, and a type reference's
arguments pairwise.

Both spellings have to reach the *same* instantiation, and they do, because the
memo is on the erased arguments rather than on how they were written.

**`identity(1)` is a separate rule and must not be answered by this one.** The
literal determines `T` perfectly well — as the type `1`, which has no width. So
the complaint belongs to `GF0161` and the fix is at the literal, and telling the
programmer to write type arguments there would send them to the wrong place.
What `GF0404` is left saying is the narrow, true thing: this call determines
nothing, which in practice means a type parameter that appears in no argument.

---

## 5. Stages

Each ends somewhere runnable, tested, and committable, in the style
LLVM-PORT.md set. The checkpoint is behavioural, never "it compiles".

### Stage 0 — struct identity ✅ *(done, 2026-08-28)*

**Not a generics change.** A live silent-miscompile fix (§3) that everything
after it stands on. `layoutKey`, `sameType`, `#structTy`, `#interfaceTy`, the
itab symbol.

*Checkpoint, met:* four tests in `tests/structs.test.ts` under "a struct is its
name and its layout". Three of them fail without the fix — two of those as
`GF9003`, which is the compiler calling itself broken — and the fourth is the
over-strictness guard and passes either way, on purpose. Full suite green,
golden MIR unchanged.

### Stage 1 — the substitution, and generic functions ✅ *(done, 2026-08-28)*

`Substitution` and the leaf case in `erase`; templates in `#declare`;
instantiation behind `resolveCallee`; the worklist; the backtrace note.
**Inference came with it** rather than waiting for stage 4 — the unification in
§4.5 turned out to be about sixty lines, and shipping the explicit form alone
would have meant a diagnostic telling people to write what tsc already knew.

Reaches: `identity<T>`, `first<T>(xs: T[]): T`, `unwrap<T>(w: Wrap<T>): T`,
`alloc<T>()`, `sizeOf<T>()`, `T` in and out by value, a generic calling a
generic with its own `T`, and a generic reached through a module namespace.

**Does not reach `swap<T>(a: Pointer<T>, b: Pointer<T>)`**, which this plan
listed and should not have. The signature type-checks — which is all the
original probe established, because `GF0001` stopped it at the declaration and
the body was never reached — but `p.deref()` and `p.store(v)` inside it are
`TS2339`/`TS2322`. Same conditional-type problem as `Reference<T>`, same
prelude spike (§2, stage 5). Erasure sees through the shape now, which is what
makes `alloc<T>()` work; tsc refusing the member access is the part that is
left.

*Checkpoint, met:* `tests/generics.test.ts`. `first<i32>` and `first<string>`
in one program, both results asserted **and** the live-allocation count — the
`string` instantiation clones and drops where the `i32` one does neither, and
the harness's automatic check is what proves the category came from the
substituted type rather than from the declaration.

Three things this plan got wrong, all found by running it, all now in the
commit message and the code: a binding cannot be a `ts.Type` (§4.1's
`TypeBinding` is why); the depth limit has to ride on the worklist item,
because a queue never nests; and `Pointer<T>` erases through a *substitution
type*, which prints as `T`, is `T`, and does not carry the type-parameter flag.

### Stage 2 — generic aggregates

`interface Pair<T>`, `type Pair<T> = {…}`, and generic type aliases. Mostly
falls out of stage 0's naming plus stage 1's erasure; the work is the
registry and making sure a generic aggregate reached only from inside another
instantiation is queued rather than missed.

*Checkpoint:* the `Pair<u8>` / `Pair<f64>` program from §3, running, both
values correct. A `Pair<string>` for the ownership half.

### Stage 3 — numeric generics

`T extends i32` and friends. The width pass has to see through a bound type
parameter to its substituted width, and `cast<T>` has to resolve `T` from the
substitution rather than from the call's own type.

*Checkpoint:* one `clamp<T extends f64>`-shaped function instantiated at `f32`
and `f64`, with the `f32` result asserted to actually be `f32`-rounded — the
cheap wrong implementation computes both at `f64`.

### Stage 4 — instantiations as values

Inference moved into stage 1, so what is left here is the address of one.

`identity<i32>` in value position, as a function pointer. The existing refusal
in `eraseSignature` ("a generic function type cannot be a function pointer:
there is no one body to take the address of") stays exactly right for the
*uninstantiated* form and should keep its wording; what has to change is that a
written instantiation is not that.

*Checkpoint:* a callback table built from instantiations of one generic.

### Stage 5 — generic classes, and constraints that carry methods

The largest stage, and the one to re-plan when it is reached rather than now.
It needs at least:

- `collectClasses` to grow an instantiation phase. It currently runs to
  completion *before* functions are declared, keyed by bare name, and a generic
  class cannot be flattened until its arguments are known — so `Box<i32>` is a
  `ClassInfo` produced on demand, with its own vtable, constructor, destructor
  and methods.
- The class-name-collision refusal to be revisited, since instantiated names
  are no longer bare.
- `instanceof` and the type descriptors to treat `Box<i32>` and `Box<f64>` as
  unrelated types, which they are.
- **A spike on the prelude first** (§2): `Reference<T>` and `Pointer<T>` are
  conditional types that do not survive a type parameter, so a method call on a
  constrained `T` cannot be *written* today, never mind lowered. Candidates:
  an overloaded declaration, a non-conditional form guarded differently, or
  accepting that a constrained generic takes its receiver some other way. The
  distribution hazard the current spelling exists to avoid is documented at
  length in `global.d.ts` and must not be reintroduced — that comment ends
  "Verified against real tsc, not assumed", and so should its replacement.

### Stage 6 — crossing a Goblin boundary

A generic exported by a Goblin library, instantiated in a Goblin consumer.
Its own section, because it is the one stage that reaches past the frontend:
§6.

---

## 6. Crossing a Goblin boundary

The generic's body travels with the library and is instantiated in the
consumer — C++'s header-only template, Rust's rlib. **Goblin to Goblin only.**
`std::vector<T>` cannot be used from C either, and for the same reason: there
is nothing to hand a C compiler that it could instantiate.

### The mechanism already exists

DECISIONS §11.8 settled that `.gbi` does not survive, because "a Goblin module
is a TypeScript program: many files, one compilation, one object file", and
because "tsc resolves the imports". That decision is what makes this cheap:
**a generic body travelling as source is not a new mechanism, it is the only
mechanism.** A library publishes the `.ts` of its generic surface beside the C
header; the consumer's `ts.Program` contains those files like any other import;
the instantiations are lowered into the consumer's module like any other
function. No interface format, no serialised MIR, nothing to keep in step by
hand — which was §11.8's whole argument.

What changes is that a Goblin library now has **two** published interfaces, and
they are not the same size:

| Consumer | Gets | Generic surface |
|---|---|---|
| C | the archive + the generated header | absent, and correctly so |
| Goblin | the archive + the header + the published Goblin source | instantiated locally |

§11.8 says "two Goblin libraries meet the way a Goblin library and a C one do,
which is one mechanism instead of two". That stays true for everything with a
symbol. Generics are the exception, and they are the exception because they
have no symbol — so this is not a second mechanism competing with the first, it
is the part the first cannot express. That distinction is worth keeping sharp,
because the wrong reading of it is "let us also send classes and strings this
way", which §11.8 deliberately did not do.

### Three things this needs, and none of them are free

**Instantiations must fold, so they need stable symbols and weak linkage.**
If the library instantiates `Vec<i32>` internally and the consumer instantiates
it too, both objects reach one link. Today `#symbolOf` qualifies an internal
symbol with a hash of the module's path *relative to that build's project
root* — and the library and the consumer have different roots, so the two
copies get different symbols, do not fold, and both ship. An instantiation's
symbol therefore has to be derived from something **both compilations agree
on**: the generic's declaring module identified package-relatively, its name,
and the erased type arguments. The same reasoning that made `#relative` use the
project root instead of the absolute path, taken one level further out.

Folding then needs a linkage the MIR does not have. `Export` and `Internal` are
the two today; an instantiation wants C++'s vague linkage —
`linkonce_odr` — so that N copies collapse to one and the odd one out is not a
duplicate-symbol error. **That is a wire-format change** (a new `Linkage`
variant), which is fine and expected: regenerate, read the diff. It is called
out here because it is the one part of this plan that reaches past the frontend.

**Vtable identity is the sharp edge.** For a generic *function*, two unfolded
copies are wasted bytes and nothing worse. For a generic *class*, `Box<i32>`
instantiated on both sides without folding has two `ClassId`s, two vtables and
two type descriptors — so `instanceof` across the boundary answers no, and an
interface conversion resolves against the wrong itab. This is C++'s ODR problem
exactly, and it is why folding is not optional once generic classes cross.
Non-generic classes cannot cross today at all (`abi.rs` refuses one: "a vtable
pointer that only means something inside this build"), so this hazard is
entirely new with this section, and it arrives with stage 5 rather than before.

**The two halves must come from one build.** A consumer compiling the library's
published generic source against a *different* build's archive gets layouts
that disagree, silently — the §3 bug again, arrived at from across a boundary
where no single compilation can see both. The compiler already has the pattern
for this and should reuse it rather than invent one: the MIR bindings carry a
wire-format fingerprint that is checked on every decode, for exactly this
reason. The published Goblin interface wants the same stamp, checked when the
consumer compiles.

### And it makes `runtime: "shared"` matter more

LINKING.md's two-artefacts-one-process section already says that two Goblin
artefacts each carrying their own runtime means two heaps, and that a `string`
allocated in one and released in the other is a free against a heap that never
allocated it. An instantiation compiled into the consumer but operating on
values the library made is that case by construction rather than by accident.
Nothing new is required — `runtime: "shared"` is already the answer — but the
documentation for a library that exports generics should say so rather than
leaving it to be discovered.

### Stage

This is **stage 6**, after generic classes, and it should not be pulled
earlier. Stages 0–5 are all within one compilation, where none of the above
exists: the generic and its instantiation are in the same `ts.Program`, share
one symbol table and one set of `ClassId`s, and fold trivially by being one
thing. Getting the single-compilation case right first is what makes the
boundary case a linkage-and-naming problem rather than a design problem.

*Checkpoint:* a Goblin `static-lib` exporting `Vec<T>`-shaped source and a
Goblin `bin` consuming it, where both sides instantiate `Vec<i32>`, the symbol
appears **once** in the linked binary (checked with `llvm-objdump`, as
`tests/libraries.test.ts` already reaches for), and the live-allocation count
comes back to zero across the boundary.

---

## 7. Not in this plan

- **Variance, conditional types, mapped types, `infer`, overloads.** tsc has
  them; a machine type does not. They stay `GF0001`.
- **Specialisation.** One body per declaration, always.
- **Uniform representation as an escape hatch.** §1.
- **Generic externs.** `declare function f<T>(x: T)` has no body to
  instantiate, so it is a rule, not a gap: `GF0403` (§8).
- **A generic in the C header.** A C consumer cannot instantiate anything, so a
  generic is simply absent from the header — exactly as `std::vector<T>` is
  absent from a C header. This is not a refusal and needs no code: the header
  is generated from the MIR, and an uninstantiated generic never reaches it.

---

## 8. Diagnostics to add

CLAUDE.md's bands have no home for these — they are not widths, not ownership,
not layout, and not the build itself — so this proposes a band, which is a
documented act rather than a quiet one. `GF04xx` — generics and instantiation:

| Code | Rule |
|---|---|
| `GF0401` | A published Goblin interface and the archive beside it came from different builds (§6). Only reachable once stage 6 lands. |
| `GF0402` | Instantiation is unbounded. `f<T>` reaches `f<Pair<T>>`; names the chain. |
| `GF0403` | A generic `declare function`. There is no body to instantiate. |
| `GF0404` | The call determines no type arguments — a type parameter that appears in none of them. *Not* `identity(1)`, which determines `T` as a literal with no width and is `GF0161`. |

Everything else reuses what exists, and should: a type argument with no value
form is already `GF0002`, an unerasable one is already `GF0001`, and both now
arrive with a note pointing at the instantiation.

`tests/diagnostics.test.ts` raises every code from a real program, so each of
these needs one.

---

## 9. What was probed, so nobody re-derives it

2026-08-28, against this tree at `fee37f7`, real compiler, real binaries.

1. `interface Pair { a: i32 }` in two files with different field types: **both
   programs miscompile silently, no diagnostic**. §3.
2. `Pair<u8>` and `Pair<f64>` in one program: reaches clang, comes back as
   `GF9003`. §3.
3. `Pair<i32>` and `Pair<u32>` in one program: compiles clean, **prints the
   wrong answer** — an unsigned comparison emitted signed. §3.
4. The nine generic shapes in §2's table, against the real prelude.
5. `Reference<Speaker>` — non-generic, a plain contract — is clean and works
   today. Only the *generic* reference is broken.
