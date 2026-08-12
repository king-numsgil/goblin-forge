# Decisions

REWRITE-PLAN §11 lists eight questions that have to be *answered*, not drifted
into, because each one changes the IR. This file is where the answers live, with
the reasoning attached, so that a decision made once is not re-litigated at every
site that depends on it.

Each entry is dated and says which milestone it binds.

---

## §11.4 — Who destroys a by-value argument

**Answer: the caller.** Itanium-style.

Settled by REWRITE-PLAN §4.5 rather than left open: it is what v1 does, and it
makes the callee's parameter an ordinary borrow of a copy. The MSVC convention
(callee destroys) is also coherent, but mixing them is a leak or a double free at
every call site, so the point is that it is written down, not which one won.

Binds: milestone 5 onward, and both ABI classifications in milestone 7.

---

## §11.5 — Exception model *(2026-08-11)*

**Answer: exceptions are planned. Unwind edges go into the MIR now.**

The user's decision, with the note: *"We'll have to add checks around C-ABI
boundaries to prevent throws, but that's a future problem."*

What that means concretely, today:

- `Terminator::Call` carries an `unwind: UnwindAction`, and so does
  `Statement::Drop`.
- `UnwindAction` has four cases: `Continue`, `Cleanup(BlockId)`, `Unreachable`,
  and `Terminate`. `Terminate` is the C-ABI boundary case — unwinding past a
  function that cannot carry it aborts.
- `Block` carries a `BlockKind`, so cleanup blocks are distinguishable from
  normal ones, and `Terminator::Resume` ends them.
- Drop elaboration (milestone 4) computes cleanup paths as it places drops,
  because that is the only time it is cheap. REWRITE-PLAN §11.5 is explicit that
  retrofitting unwind edges afterwards is a rewrite of the pass.
- The language has no `throw` yet, so every unwind action the frontend currently
  emits is `Unreachable`, and the backend lowers cleanup blocks to nothing. The
  runtime cost today is zero.

**Deferred, and deliberately so:** enforcing `noexcept` at C-ABI boundaries. When
`throw` lands, every `Abi::C` function becomes a translation point or a
`Terminate` edge. Nothing about that changes the IR, which is why it can wait.

Binds: milestone 4 onward.

---

## §11.1 — How a move is produced *(2026-08-11)*

**Answer: written, plus `return local`.** The intrinsic is spelled `move`, with
no prefix, matching `alloc`.

```ts
const a = "hello, " + name;
const b = a;              // a copy — an allocation
const c = move(a);        // a move — no allocation; `a` is dead afterwards
take(move(c));            // ownership into a parameter
```

The alternative considered was inferring a move from last use, the way Rust
does. It produces better code with less typing, and it was rejected for the
reason REWRITE-PLAN §1 gives for every v1 memory bug: ownership that is derived
from how the code happens to be arranged is ownership that has to be re-derived
at every site, and one site always gets missed. Under last-use inference,
whether a line allocates depends on whether a *later* line reads the value —
so deleting a `console.log` silently changes an earlier line from a copy into a
move. That is the same habit `Reference<T>` exists to break.

`return local` is the one move nobody writes, because there is nothing else it
could mean: the local is about to go out of scope, so copying it and destroying
the original differ only in cost.

**Use-after-move is `GF0235`, and the check is lexical**: a move is seen for the
rest of the function once it has happened. A move under an `if`, read after the
`if`, is not caught. To make that gap harmless rather than dangerous, a move
**nulls its source**, so the value read back is empty rather than dangling — a
wrong answer, never memory corruption. A dataflow version can replace the
lexical one without changing the language.

Binds: milestone 5 onward.

## §11.6 — Mutable containers *(2026-08-12, revised the same day)*

**Answer: three array types, mirroring C++'s three.**

The first answer was "`T[]` is fixed-length with mutable elements". Talking it
through turned up a better split, and the reason is worth keeping: C++ has
`char buf[128]`, `std::vector<char>`, and `new char[n]`, and they are three
different things rather than one thing with options.

| C++ | Goblin | storage | status |
|---|---|---|---|
| `char buf[128]` | `FixedArray<T, N>` | **Inline** — no allocation | type, layout and destruction in; construction and indexing still to lower |
| `std::vector<char>` | `T[]` | Owning handle, runtime length | declared, deliberately not implemented |
| `new char[n]` / `delete[]` | `allocArray<T>(n)` / `p.freeArray()` | raw `Pointer<T>` | declared |

The correction that drove it: **a C array is not a pointer.** `char buf[128]`
*is* the 128 bytes; `sizeof` says 128, it cannot be reassigned, and as a struct
field it occupies its whole layout inline. It *decays* to a pointer in
expression contexts, which is where the intuition that it is one comes from.
That distinction is the difference between an array being a value and an array
being a handle, and Goblin already had the right word for it — `Inline` storage
from §4.2. Not "stack": a fixed array inside a heap object is on the heap and is
still inline.

### The brand has to be required

`FixedArray<T, N>` decays to `Pointer<T>`, which is what makes a C function
taking `uint8_t*` callable with one. Encoding that needs care:

```ts
interface FixedArray<T, N extends number> extends CorePointer<T> {
  readonly [FixedLengthBrand]: N;   // required, not optional
  readonly length: N;
}
```

The brand is **required**, unlike the width brand. An optional one would be
optional-and-*absent* on a plain `Pointer<T>`, and optional-and-absent is
assignable — so any pointer would silently become a fixed array of whatever
length was asked for. That is REWRITE-PLAN §7's trap in a new place. Checked
against tsc 6.0 rather than assumed:

| | |
|---|---|
| `takesPointer(buf)` | allowed |
| `const p: Pointer<u8> = buf` | allowed |
| `const a: FixedArray<u8,8> = somePointer` | `TS2739` |
| `const b: FixedArray<u8,4> = buf` | `TS2322: '8' is not assignable to '4'` |

`free()` and `freeArray()` are inherited and are undefined behaviour on a fixed
array — exactly as `free(buf)` is in C. The alternative is a second pointer type
whose only difference is which mistakes it permits, and this is an unsafe
language on purpose.

### Indexing lives on `Pointer<T>`, not on a new type

`p[i]` is `*(p + i)`, as in C, and `nativeOffset` already commits to pointer
arithmetic being legal. A separate `ArrayPointer<T>` would add a type without
adding a distinction: in C, a pointer to one `T` and a pointer to the first of
many are the same thing.

The distinction that *is* worth having is `free` versus `freeArray` — the one
place C++ genuinely needs to know whether one destructor runs or `n` of them.

### Superseded: fixed length, mutable elements

**Answer: fixed length, mutable elements.**

`a[i] = x` works. The length never changes, so there is no capacity word, no
reallocation, and no iterator invalidation to reason about — a reference or
pointer into an array stays valid for the array's lifetime, which is a property
worth more than `push` is.

The header is the same shape a `string` has:

```text
  [ len: u64 ][ owned: u64 ][ elements … ]
                            ^ the `T[]` value points here
```

Elements are **inline**: an element occupies its stride, not a pointer to
itself. An element of an owning type is destroyed by the array as part of
destroying itself.

`push` and growth stay `GF0001`. Adding them later changes the header and the
runtime, but not the language's semantics for anything that exists today, which
is why deferring them is cheap and getting invalidation wrong would not be.

## §11.3 — `instanceof` across a library boundary *(provisional)*

**Leaning: static type descriptors with a pointer to the base descriptor, walked
at runtime.** REWRITE-PLAN §3 says "almost certainly", and nothing has argued
otherwise yet.

The closed-world trick — comparing against the set of vtables known at compile
time — has to go regardless, because it is only correct when the compiler can see
every class, and `static-lib` breaks that on day one.

Confirm at milestone 8, when the class representation is actually being built.

---

## §11.2 — Interface dispatch *(settled and built, 2026-08-12)*

**Answer: itables, Go-shaped — a two-word reference `(itab, data)`, with the itab
emitted statically at the conversion site.** REWRITE-PLAN §3's option (b), which
it already called "what most languages land on and is the least clever".

Built at milestone 8b. Everything below stood up except one prediction, recorded
at the end: the fat reference was expected to be the expensive part and was not.

### Why itables rather than per-name slots

Because the language is **structurally typed**, and that is not a stylistic
detail — it decides where the dispatch information can physically live.

Java and C# can put interface dispatch data *in the class*, because a class there
says `implements Drawable` and the pairing is known where the class is defined.
TypeScript has no such rule: a class satisfies an interface by having the right
shape, and `implements` is erased. So the (interface, class) pairing is only
known at the **conversion site**, which may be in a different module from either
declaration. Go is structurally typed for the same reason and reached the same
place; its `itab` is that third object, owned by neither side.

That also rules out the C++/MSVC multiple-inheritance layout, where each
interface gets a vtable embedded in the object and casting adjusts `this`. Under
structural typing the set of interfaces a class satisfies is open-ended, so the
object's size would depend on which interfaces happen to exist elsewhere in the
program. §6's whole layout story is "checked against a real C compiler"; one
hidden pointer at offset 0 is a known quantity, *N* of them is not. An itab adds
nothing to the object, which is what matters when the class came from a library.

Per-name slots (option a) need a global name→slot registry merged on import, and
version-skew between two libraries is silent. Hashed slots (option c) need
collision handling forever. Both are cleverer and neither buys anything.

### Steal Go's layout, not Go's laziness

Go builds itabs at runtime through a global open-addressed hash table, because
Go has reflection, `interface{}` assertions, plugins, and code the compiler never
saw. None of that applies here: the conversion site is always in the module being
compiled, even when the class comes from a library, because the interface's
method list and the class's method symbols are both nameable. So every itab is
**static data with relocations** — no hash table, no lock, no startup pass, no
sorted-merge algorithm. Go itself does this for conversions it can see
(`go:itab.T,I`); the runtime table is only its fallback.

```
Reference<Pet>  =  { itab: *const Itab, data: *mut () }     // two words
Itab            =  { class: *const TypeDescriptor, methods: [fn; N] }
```

The `class` pointer is §11.3's descriptor, so `instanceof` and the virtual
destructor come along without the itab duplicating either. Method order is the
interface's method set **sorted by name**, so a slot assignment is a function of
the set rather than of the declaration's source order.

For a hierarchy the itab is a static gather from the vtable: `Pet.feed` resolves
to whatever the final overrider is, which the vtable already holds.

### An interface is a *shape* or a *contract*, decided by syntax

The two must not be distinguishable only by what happens to be assigned, because
`{string, fn}` as an inline struct and `{itab, data}` as a fat reference are both
sixteen bytes and mean entirely different things. Confusing them produces wrong
numbers rather than a crash. So the interface's own declaration decides, once:

| Written | Is | Because |
|---|---|---|
| `feed(): void` — a `MethodSignature` | a **contract**: dispatched, itab | shared per class |
| `feed: () => void` — a `PropertySignature` of function type | a **shape**: an `FnPtr` field | per instance data |

*The user's distinction, and it is the right one* — the two are different AST
node kinds, so the rule is syntactic and visible at the declaration rather than
inferred from a type. Three things support it:

- **TypeScript already agrees.** Under `strictFunctionTypes`, method signatures
  are bivariant and function-typed properties are contravariant. tsc treats them
  as different things today; this is the same seam.
- **JavaScript already agrees.** `feed() {}` in a class goes on the prototype —
  one copy, shared, looked up dynamically. `feed = () => {}` is an instance
  property — one per object, part of its data. That is the vtable/field
  distinction exactly, and it is why the erasure experiment that prompted this
  (`Vec2 is not defined`, but `class Dog` *is*) points the way it does.
- **It keeps C's struct-of-callbacks.** A struct of function pointers is how a
  great deal of C API surface is shaped, and it stays a plain struct here,
  layout-compatible, crossing the boundary unchanged.

An interface with only data members is what exists today and does not change:
a struct, C-compatible, copied by value. So adding classes retroactively changes
the meaning of no existing declaration — the apparatus switches on only when
someone writes a method signature, which is a `GF0001` right now anyway.

### An interface type has no layout

A contract cannot be a local, a field, or a by-value parameter. It exists only as
`Reference<Pet>` — C++'s abstract base, which cannot be held by value either.
`global.d.ts:320` already says a `Reference<Shape>` keeps the dynamic type while
copying slices, so the prelude has been telling this story since milestone 5.

**`Pointer<Pet>` is not the spelling.** `Pointer<T>` is a machine address: it
does arithmetic, decays from `FixedArray`, answers `nativeSizeOf`, has
`free()`/`freeArray()`, and crosses the C boundary as one word. Making it
secretly two words for some `T` breaks all of those; Rust's `*mut dyn Trait` is
the cautionary version. `Reference<T>` carries none of those obligations and
never goes to C, so it is the one that gets to be fat.

### `implements` is what makes a dynamic cast possible

tsc erases `implements`, but the heritage clause is in the AST and the checker
retains the `ts.Program`, so the lowerer reads it for free — and using it diverges
from TypeScript not at all, since tsc accepts the annotation and merely ignores
it.

- **Static conversion** — `const p: Reference<Pet> = dog`, `dog` statically a
  `Dog`. Purely structural, no `implements` required, itab emitted at the site.
  Dispatch afterwards is two loads and an indirect call: the same cost as a
  virtual call, and nothing about it is lazy.
- **Dynamic conversion** — asking a `Reference<Animal>` whether it is also a
  `Pet`. This needs the itab for the *dynamic* type, and a class's descriptor can
  only be populated with itabs known at the class's own definition site; a
  structural conversion in another module cannot retroactively add to a
  descriptor that is already compiled. So this **requires `implements`**, and the
  class's descriptor carries a sorted `(interface id → itab*)` array to
  binary-search. No global table, no synchronisation.

Missing `implements` is therefore a diagnostic at the cast site, naming the class
and the interface — never a silent runtime `false`, which would be miserable to
debug.

There is no spelling for this yet and one has to be invented regardless:
`x instanceof Pet` is *already* a TypeScript error ("only refers to a type"), so
no divergence is even possible. An intrinsic returning null on failure fits the
machinery that already exists for `nativeCast<u8>` and `allocArray<T>`, and needs
no general generics — §11.7 stays parked.

Class → *shape* conversion stays rejected (`GF0002`), so slicing happens only
class → base class, where it is visible.

### The prediction that was wrong: it did not break the handle invariant

This entry said, before it was built, that the fat reference was the real price:
that `layout.rs`'s "every handle in this language is one machine word" would have
to go, that `Repr` would need a two-register form, and that the change would land
in `layout.rs`, `abi.rs` and `translate.rs` together.

None of that happened, because the framing was wrong. **A `Reference<I>` is an
aggregate of two handles, not a fat handle.** Nothing about it is a *handle* —
it is two words at fixed offsets, which is a struct, and structs have travelled
by address internally since milestone 6. `layout.rs` gained one arm returning a
two-word layout and one more type in an existing `Repr::Aggregate` list. `abi.rs`
was not touched at all. The invariant it was going to break is still true and
still says the same thing.

The residue is real but small: passing one internally copies sixteen bytes
rather than filling two registers. That is a later optimisation and an isolated
one — it changes how the pair travels, not what it is — and it only matters at
`Abi::Internal`, since a contract is refused at the C boundary anyway.

Worth keeping as a note about estimating: "this needs a new `Repr`" was an
assumption about the *implementation*, made while the design was still being
argued, and it survived into the written decision as though it were part of it.

**Itabs are not unique across modules, and nothing may depend on their address.**
Two modules converting the same `(interface, class)` pair each emit an itab, and
there is no cheap way to stop that: `Linkage::Preemptible` does map to a weak
symbol (`cranelift-object-0.134.3/src/backend.rs:1128`), which gets ELF
duplicate-definition merging, but COFF weak externals are an alias fallback
rather than definition merging, so Windows would want COMDAT and cranelift-object
does not expose it.

This is fine, because **the uniqueness requirement is on the type descriptor, not
on the itab**, and those are different objects:

- The **descriptor is the identity**. It belongs to exactly one class, declared
  in exactly one module, so it is emitted there, exported, and imported by
  everyone else. One definition by ordinary linking, identically under
  `static-lib` and `shared-lib`. No dedup mechanism is involved at all.
- The **itab is a cache** of which of the class's methods answer the interface's
  method set, derived wholly from the vtable. A duplicated cache costs a few
  words of `.rodata` and nothing else.

Go interns itabs because Go's `==` on interface values means *(same dynamic type,
equal value)* and uses the itab pointer as the proxy for the type. Keep identity
in the descriptor and that reason evaporates. So: **nothing observes an itab's
address.** Interface comparison is `data == data` (same object) or
`itab->class == itab->class` (same dynamic type), both stable under duplication.

`data == data` is also strictly better than the embedded-vtable alternative,
where comparing a `Pet*` against an `Animal*` aimed at one object needs
this-adjustment and gives two unequal pointers to the same object when it is got
wrong. Here `data` is always the unadjusted object address, because the object's
layout never changed, so cross-interface comparison needs no thunk.

Do still intern itabs by `(interface, class)` **within** a compilation — a hash
map during lowering, so two conversion sites in one module share one itab. It is
free. Interning across libraries would need a load-time pass over every module's
itab section, which is Go's `itabsinit`, and that buys a guarantee this language
does not make.

The failure this avoids is a well-known one: it is C++'s `typeid` and
`dynamic_cast` across a shared-object boundary, where RTTI emitted into two
`.so`s compares unequal and the cast silently returns null. The fix there was
always to give the identity symbol one owner and export it.

**Contracts do not cross the C boundary.** Revisit with header emission at
milestone 9.

### One rule added while building it: no mixed interfaces

An interface declaring **both** a method and a data member is rejected
(`GF0002`). It would have to be a layout *and* a dispatch table at once, and
neither reading is better than the other. Split it, or make the data a method
that returns it.

This was not in the design; it fell out of implementing the shape/contract
split, and it is the one case where the syntactic rule does not decide on its
own.

---

## §11.8 — Multi-module linking, and `.gbi` *(settled, 2026-08-12)*

**Answer: `.gbi` does not survive. A Goblin module is a TypeScript program:
many files, one compilation, one object file.**

Most of what a module-interface file was for turned out to be somebody else's
job already:

- **tsc resolves the imports.** A `ts.Program` already contains every file
  reachable from the entry, in dependency order, type-checked together. A
  bespoke interface format would be a second and weaker copy of that, kept in
  step by hand — which is the mistake §2 calls out about v1's wire contract.
- **The lowerer already walks all of them.** It always did; multi-file worked
  the day classes did, and nobody had noticed because no test had two files.
- **A real library boundary already has a format**, and milestone 9 built it:
  the C ABI plus a generated header. Two Goblin libraries meet the way a Goblin
  library and a C one do, which is one mechanism instead of two.

REWRITE-PLAN §11.8 guessed at this — "if the frontend and backend are one
process, a lot of what `.gbi` was for is now just holding state in memory" —
and the guess was right, minus the part about holding state: nothing needs to
be held, because there is only one compilation.

**Incremental builds are a separate question**, deliberately unanswered. They
would want a cache keyed by content, not an interface file, and `CompileOptions`
already reserves `incremental` for whoever answers it.

### What it cost: names had to stop being global

Two modules may each declare a private `helper`, and both are right — the names
are scoped to their modules and tsc says so. The function table was keyed by the
bare name, so the second overwrote the first, and both were emitted under that
name: a duplicate-symbol error from Cranelift with no file and no line.

Two changes fix it, and they are the substance of this milestone:

- **Calls resolve through tsc's symbol**, not through a name string. An
  imported function is the same symbol as its declaration however it is spelled
  at the call site, and two same-named privates in different files are different
  symbols even though they are spelled alike. `resolveCallee` follows an import
  alias to get there.
- **Internal symbols are qualified** by a hash of the module's path *relative to
  the project root*. Relative, so the same sources produce the same symbols on
  two machines — an absolute path would make a build unreproducible and the
  golden MIR churn on every move. Exported symbols keep their bare name, because
  that is the C ABI contract and what the header declares.

### Known restriction: class names are global to a build

Two classes with the same name in different modules are legal TypeScript and are
rejected here (`GF0002`, naming both files). A class is emitted under its name —
its vtable, its descriptor, its methods — so two of them collide.

Qualifying is the right fix and is not free: a class would need a **symbol**
distinct from its **name**, so a descriptor still carries the readable one for
`instanceof` and for diagnostics. That is a wire-format change, and the
restriction is cheap to lift once somebody wants it.

### `allowImportingTsExtensions` is on

`import { add } from "./math.ts"` — with the extension, because that is the file.
Nothing here emits JavaScript, so there is no rewriting step for an
extensionless specifier to survive and no bundler to guess for you. tsc permits
this only when it is not emitting, which is permanently true.

---

## Still open

| § | Question | Needed by |
|---|---|---|
| 11.7 | Generics: monomorphisation or nothing. Either way the MIR is monomorphic, so this is a frontend decision. Milestone 3 turned out not to need it — see below. | milestone 8 at the earliest |
| — | **`free()` and `freeArray()` are callable on a `FixedArray<T, N>`.** They come with the `CorePointer<T>` that makes array-to-pointer decay work, and calling either is undefined behaviour — exactly as `free(buf)` is in C, and for the same reason. Taken deliberately over adding a second pointer type whose only difference is which mistakes it permits, but it is a real unsafety rather than an oversight, and it is the kind that a diagnostic could close cheaply: the compiler knows statically that the receiver is a fixed array. Revisit once classes settle what `Pointer<T>`'s member surface actually needs to be. | revisit at milestone 8 |

---

## Class decisions *(2026-08-12, milestone 8)*

### Every class has a vtable pointer, including one with no virtual methods

C++ omits the pointer for a class with no virtual functions, so a small class
stays the size of its fields. REWRITE-PLAN §5 states the uniform rule instead —
"a class carries a vtable pointer at offset 0" — and taking it literally is
worth more than the eight bytes.

It makes `Category::Polymorphic` mean exactly **"is a class"**. Destruction,
type descriptors and dynamic casts then need no "is this one polymorphic?"
analysis anywhere, and there is no second layout rule for the classes that
happen not to have a method yet — adding the first method to a class does not
silently change its size or its C compatibility, because it never had either.

A class is not layout-compatible with a C struct regardless, so nothing was lost
that was not already gone. `interface`/`type` declarations remain the way to
describe a C struct, and they are unaffected.

### The vtable pointer is installed once, by `Default`, at the most-derived type

C++ reassigns the vtable pointer as each constructor in the chain runs, so a
virtual call from inside a base constructor dispatches to the *base's* override
rather than the derived one. Here `Rvalue::Default` installs the most-derived
vtable before any constructor runs, and no constructor touches it again.

**This is a stated divergence.** A virtual call made from inside a constructor
reaches the derived override, and it will observe fields the derived constructor
has not assigned yet — which are zero rather than garbage, because `Default`
zeroed them.

Taken deliberately: the C++ behaviour costs a vtable store per level of the
hierarchy on every construction, and it exists to protect a pattern (calling a
virtual from a constructor) that every C++ style guide tells you not to use.
Zeroed fields make the failure mode a wrong value rather than undefined
behaviour. Revisit if it ever bites.

### A destructor is generated, never written

There is no syntax for one, and none is needed yet: a class holding a `string`
releases it because the field's *type* says so. The generated `Class$drop`
releases this class's **own** fields in reverse declaration order and then calls
the base's — own fields only, or every inherited field is released once per
level.

A user-visible destructor would need syntax TypeScript does not have, and there
is nothing yet that needs one. Revisit when `Pointer<T>` ownership arrives.

### `strictPropertyInitialization` is off

tsc's check guards against reading a field that is `undefined` because no
constructor assigned it. Here every class is zero-initialised before its
constructor runs, so a field with no initialiser deterministically holds `0`, an
empty string, or a null pointer. Leaving the check on would reject correct
programs, and the alternative spelling — `x: i32 = 0` on every field — says
nothing the language does not already guarantee.

Recorded next to `noUncheckedIndexedAccess`, which is off for the same shape of
reason: both exist to make a JavaScript hazard visible, and neither hazard is
reachable here.

### `GF0236`: a by-value parameter cannot be moved out of

**Found by the C++ oracle as a double free**, which is the entire reason the
oracle exists.

§11.4 puts destruction of a by-value argument on the **caller**. C++ permits
`std::move(param)` under the same convention because the parameter object *is*
the thing the caller destroys — the move empties the very object whose
destructor will run. Here an owning value travels as a one-word handle in a
register (§4.5), so the callee holds a *different local*: emptying it does
nothing to the caller's temporary, and both release the same buffer.

So `move(param)` is rejected. Assigning the parameter is already a copy, which
is what was usually meant; a caller that should keep ownership passes a
`Reference<T>`.

The alternative — passing owning by-value parameters by address so a callee move
can poison the caller's temporary — is a real option and a much larger change to
the internal ABI. Not taken now; `GF0236`'s explanation is where to start if it
is ever wanted.

---

## Library targets *(2026-08-12, milestone 9)*

### `export` means "visible to the linker", and that is all it means

REWRITE-PLAN §3 asks whether `export` in the source means "visible to other
Goblin modules" or "visible to the dynamic linker". **The linker.** An exported
function is `Abi::C`, gets `Linkage::Export`, appears in the generated header,
and is named in a DLL's `.def` file.

Cross-module *Goblin* visibility is milestone 10's problem and a different
mechanism — a module interface, not a linkage attribute. Conflating them is what
v1 did, and it got away with it only because it built nothing but executables.

### A static library carries only its own objects

Not the runtime, not the native libraries it was told about. Two Goblin
archives in one program must not each bring a copy of `gf_string_free`, and an
archive is a bag of objects rather than a link — nothing is resolved and nothing
is discarded, so a duplicate is a duplicate symbol at the executable.

The consumer links the runtime once, at the executable. `CompileResult`
therefore reports `runtimeLibrary`, because leaving that to be discovered from
an unresolved-external is unkind, and the generated header says so in its
banner.

A `shared-lib` is the opposite: it *is* a link, so it takes the runtime and
everything else, and is self-contained.

### Windows needs an export list; ELF does not

An ELF shared object publishes every symbol with default visibility, which is
what Cranelift's `Linkage::Export` already produces. A DLL exports **nothing**
unless told, so `msvc_command` writes a `.def` file naming
`ModuleArtifact::defines` and passes `/DEF:`.

The asymmetry is the platforms', not this compiler's, and the code says so
rather than inventing a uniform abstraction over it. Windows also gets an
import library (`/IMPLIB:`), reported as `importLibrary`, because there is no
equivalent of linking straight against a `.so`.

### The header is generated from the MIR, not from the AST

By the time a module reaches header emission every type is concrete and sized,
the C ABI has already accepted it, and the struct layout is the one the backend
actually used. Reading the AST again would be a second derivation of the same
facts and a second thing to keep in step.

Structs are emitted in **post-order** — a struct after everything it contains —
because nested aggregates are inline, so C needs the full definition of a member
and not a forward declaration. Marking on the way down instead produces the
reverse order, which compiles fine for pointers and fails for exactly the case
this language cares about. Caught by the first differential test.

### A `bin` requires `main`; a library does not

Without the check the failure is an unresolved external from the linker with no
file and no line, which is the shape of error REWRITE-PLAN §8 exists to prevent.
`lower` takes `requireMain`, set from the target kind.

---

## Architecture notes settled by measurement

### The C ABI is classified, not passed our way *(2026-08-12)*

Inside a module an aggregate travels as the address of its storage: one machine
word, whoever is calling. That is nobody's ABI but ours, and it is the right
choice for calls this compiler emits both halves of.

At the boundary it is wrong. A C function declared to take a `Point` expects the
*struct* — packed into registers or copied onto the stack by rules that differ
per platform — and handing it an address produces an answer made of the address.
So `Abi::C` goes through `crates/goblin-codegen/src/abi.rs`, carried across from
v1 nearly unchanged per REWRITE-PLAN §13, and `Abi::Internal` keeps the address.

The classification produces a `Slot` per parameter and per return:

| | Win64 | System V |
|---|---|---|
| 1, 2, 4, 8 bytes | one **integer** register, whatever is inside | one eightbyte, INTEGER or SSE by content |
| 9–16 bytes | by address | two eightbytes |
| more | by address; return through a hidden pointer | on the stack; return through a hidden pointer |

The two rows that matter most are the ones §6 singles out. `struct { float x, y; }`
goes to **one SSE register** under System V and to an **integer** register under
Win64; `struct { int; float; }` goes to an integer register under both, because
one integer anywhere in an eightbyte makes the whole eightbyte INTEGER. Getting
either backwards is silent corruption rather than a crash, so both are unit
tests *and* end-to-end cases.

Two implementation notes worth keeping:

- **Carriers go through a scratch slot.** A carrier is eight bytes wide even
  when the tail of the struct is not, so storing one directly writes past the
  end. Everything goes via a scratch slot of whole eightbytes and then a byte
  copy of the real size — and the scratch is zeroed first, so the padding a
  struct does not fill is not whatever the frame happened to hold.
- **`ByAddress` means the caller makes the copy.** Win64's rule is "by address,
  pointing at a copy the caller made", and the copy is what stops the callee
  writing through to the caller's value. `gf_c_clobber` in the suite exists to
  check exactly that.

### System V is tested, not asserted *(2026-08-12)*

v1's System V half was written from the psABI and never executed — this compiler
had only ever been built on Windows. REWRITE-PLAN §6 is blunt about what that is
worth, so it is covered twice:

- `tests/struct-abi.test.ts` builds a real `extern "C"` library with the
  platform's own C compiler and requires this compiler to agree with it about
  registers, stack slots and hidden return pointers. 24 cases: every size class,
  returns in registers and through `sret`, nested aggregates, by-value copy
  semantics, and calls that exhaust the register budget.
- `abi.rs`'s own tests pin both conventions' classification from whichever
  machine is building, so the System V rules are checked even on Windows.

`.github/workflows/ci.yml` runs the whole suite on `windows-latest` and
`ubuntu-latest`, and the Linux job is the one that makes the System V half real.
It is configured but has not run here — this machine is Windows, so the Linux
result is unverified until the first push.

### Layout is checked against a C compiler, not asserted *(2026-08-12)*

REWRITE-PLAN §6 asks for the layout to be differential-tested rather than
asserted, and v1's experience is the argument: the struct-ABI suite that asks
the C compiler for `size_of` and `offset_of` is why its layout code is the
best-tested part of the project.

`tests/oracle/layout/layout.cpp` declares ten shapes and prints what the C
compiler decided; `tests/layout.test.ts` builds the same shapes as MIR and asks
the backend's layout engine — the same computation code generation uses, not a
reimplementation. Size, alignment and every field offset have to match.

The shapes cover padding in the middle and at the end, a wide-then-narrow
struct, two and three levels of nesting, all ten integer and float widths in one
struct, a `bool` beside a `float`, and a machine-word handle beside an `i32`.
All ten agree with MSVC.

One trap worth recording, because it cost a confusing half hour: a statement
beginning with `declare` is parsed as an **ambient declaration** and erased. A
test helper named `declare(...)` called as a bare statement therefore compiles
to nothing at all, and the shapes it was supposed to register silently stop
being tested — while the test still reports the ones that were assigned to a
variable. It is named `shape` now.

### The MIR crosses as one buffer per module *(2026-08-11)*

REWRITE-PLAN §2 asks for this to be proven before anything else, because the
failure mode is not "it doesn't work" but "it works and marshalling dominates the
compile" — and the fix, emitting per function rather than one blob per module, is
cheap early and annoying later.

Measured on the host (Windows, x86-64, release addon), with a synthetic module of
realistic shape — five basic blocks per function, a loop, a branch, a C call:

| functions | statements | bytes | encode | cross + decode | round trip |
|---:|---:|---:|---:|---:|---:|
| 1 | 12 | 255 | 0.02 ms | 0.01 ms | 0.01 ms |
| 16 | 192 | 2,607 | 0.07 ms | 0.04 ms | 0.06 ms |
| 128 | 1,536 | 20,448 | 0.22 ms | 0.34 ms | 0.39 ms |
| 512 | 6,144 | 82,272 | 1.15 ms | 2.09 ms | 2.87 ms |
| 2,048 | 24,576 | 331,434 | 7.37 ms | 9.00 ms | 11.65 ms |

The MIR costs about 13.5 bytes per statement, which is postcard's varints doing
their job. A 128-function module — a large source file — spends about half a
millisecond in total on the boundary. Cranelift will spend considerably more than
that generating code for it.

**Conclusion: one buffer per module stands.** Revisit only if a real module ever
lands in the 2,000-function range *and* profiling shows the boundary rather than
codegen. Reproduce with `bun run bench:boundary`.

One thing that measurement caught, worth recording because it is the kind of cost
that never gets found later: the schema fingerprint was being recomputed from the
type graph on every call, putting a flat two milliseconds under every module
regardless of size. It is cached now.

### The ES5 target is gone, and nothing was lost *(2026-08-11)*

v1's `runtime/tsconfig.base.json` set `"target": "ES5"` for one specific,
carefully documented reason: at that target tsc types `for...of` as *index-based*
iteration over arrays, which is exactly what the compiler emits. Any later
target was believed to demand a `[Symbol.iterator]` method, and declaring one
would be a fiction — this language has no iterator protocol.

That reasoning does not survive contact with TypeScript 6.0, in two ways.

First, ES5 is now deprecated (`TS5107`) and stops functioning in 7.0, so it was
going to have to go regardless.

Second, and more usefully, **the premise was never true under `noLib`**. With no
`Symbol` in scope at all, tsc falls back to the index signature and infers the
element type correctly. Checked against tsc 6.0.3 rather than assumed:

```ts
// noLib, target ES2015, global.d.ts only
export function sum(xs: i32[]): i32 {
  let total: i32 = 0;
  for (const x of xs) { total = total + x; }   // x: i32
  return total;
}
```

So the base config targets ES2015 and the comment explaining ES5 is replaced by
one explaining why it is not needed.

A related TypeScript 6.0 change caught the same file: unknown keys inside
`compilerOptions` are now a hard error (`TS5025`), so the `"//noLib": [...]`
style of inline documentation had to become ordinary `//` comments. tsconfig.json
has always been JSONC; nothing else changes.

### Declaration emit is off until §11.8 is answered *(2026-08-11)*

v1 used tsc's declaration emit as the module-interface cache: importing a module
read the emitted `.d.ts` rather than the original `.ts`. Whether that arrangement
survives is REWRITE-PLAN §11.8 — still open, and now genuinely in question, since
the frontend and backend share a process and can simply hold state in memory
across `compileModule` calls.

Turning it on before the answer is known is not free: TypeScript 6.0 requires an
explicit `rootDir` when declaration emit is on, and the right `rootDir` depends
on a multi-module layout nobody has designed yet. So the base config is `noEmit`
and the question stays open on its merits rather than being settled by a
configuration accident.

### An object literal has no type of its own *(2026-08-12)*

The same rule numeric literals already follow, arrived at for the same reason.
`{ x: 1, y: 2 }` erased on its own terms gives an anonymous shape whose fields
are plain `number` — no width, no name, no layout. It is not a value with a type;
it is an *initialiser* for whatever struct is expected.

So it is **polymorphic** in the width pass's sense, exactly like `42`, and takes
its type from context. The case that forced it was `fixedArray(2, { x: 1, y: 2 })`,
where tsc infers the element type from the literal and lands on the anonymous
shape rather than on the annotated `Point` — but the same reasoning applied
everywhere, so the fix went in the general place rather than at that call.

### `fixedArray(N, fill)` zeroes first, then constructs *(2026-08-12)*

Two things about the fill loop are worth writing down, because the obvious
version of each is wrong.

**Zero the storage first.** REWRITE-PLAN §10: constructing into a stack slot
runs a constructor, and a constructor releases whatever the field used to hold —
on uninitialised stack that is a garbage pointer. Zeroing also makes the
degenerate cases correct for free: `N` of zero, or a destructor running over a
slot the loop never reached, sees null handles, and freeing null is a no-op.

**The fill is copied, not moved.** The lowerer's usual optimisation is to move
out of a temporary, which is correct precisely because a temporary is used once.
A fill loop is the case where it is not: moving put the value in element zero
and left every other element holding what the move left behind. `#repeatable`
exists for values read more than once, and it always produces a `Copy`.

### Copy and move stay distinguishable all the way to the store *(2026-08-12)*

Aggregates made the copy/move distinction load-bearing in a place it had not
been before, and the allocation counter found each step of getting it wrong.

For a one-word handle, `Copy` and `Move` differ only in whether the source is
poisoned afterwards — the store itself is the same instruction. For a struct
they are genuinely different operations:

- a **copy** clones every owning field, because the source and the destination
  will both be destroyed;
- a **move** takes the bytes exactly as they are, because the source has been
  made dead and will not be.

`memcpy` for the first is REWRITE-PLAN §10's shallow-copy double free. A
field-wise clone for the second is a leak of everything the source held. So the
store has to know which it is, and `write_place_with` takes that as an argument
rather than inferring it from the value it was handed — by then the operand is
just an address and the distinction is gone.

Two related fixes the same tests forced:

- **A by-value struct argument needs a copy the caller makes.** Passing the
  address of the caller's own local let a callee write through to it, which is
  the opposite of the value semantics the language is built on. Scalars are
  copied by being put in a register; anything travelling by address or by handle
  is not, and needs the copy spelled (§4.5).
- **A move must not poison an aggregate.** Nulling the source is right for a
  handle and meaningless for a struct — there is no single word to null, and
  writing one memcpys from address zero. Drop elaboration is what actually
  prevents the double free; poisoning is only extra insurance for the handle
  case.

### `Operand::Borrow`, and the three ways a value can be read *(2026-08-11)*

The allocation counter turned on at milestone 5 and immediately reported leaks
on programs whose output was completely correct. Every one of them was the same
mistake: `Operand::Copy` applies the type's copy operation, and for an owning
type that is an allocation — so reading a string to print it, to concatenate it,
or to pass it allocated a second buffer that nothing ever freed.

The fix is that "read a value" is three different operations, and the IR now
says which:

| | what it does | who destroys the value |
|---|---|---|
| `Copy(place)` | applies the type's copy operation | the new owner |
| `Move(place)` | takes the value, leaves the source dead | the new owner |
| `Borrow(place)` | reads the machine value, ownership unmoved | whoever already owned it |

`Borrow` is REWRITE-PLAN §4.5's own sentence as an operand: "for a `string` or
`T[]` that value is a one-word handle, so the callee shares the buffer and the
caller keeps owning it".

Which one applies where:

- **Storing** into something that will own it — a binding, an assignment, the
  return place — is a `Copy`, except from a temporary, which is `Move`. A
  temporary *is* the copy; cloning it would allocate twice and leave the first
  to the full-expression to clean up.
- **Reading** — concatenation, comparison, `length`, `console.log` — is a
  `Borrow`. None of those takes ownership, so none of them needs a copy.
- **A by-value argument to a user function** is a `Copy` into a temporary, then
  a `Borrow` of that temporary. The caller makes the copy and the caller
  destroys it, Itanium-style per §4.5, which is what lets the callee treat its
  parameter as a borrow of something it cannot outlive.

None of this is visible in a program's output. All of it is visible in the
allocation count, which is exactly why §9 calls that check non-negotiable.

### Golden MIR paid for itself immediately *(2026-08-11)*

REWRITE-PLAN §9 asks for MIR snapshots because "drop placement is the thing most
likely to regress invisibly". The first six snapshots, taken on a milestone
where *nothing owns anything and no `drop` is emitted at all*, exposed two real
bugs in temporary lifetimes:

- `StorageDead` for a condition's temporary was emitted **before** the branch
  that reads it. At milestone 5 that is a read of a destroyed value.
- A declaration's initialiser temporaries were never released at all — the
  full-expression wrapper was on statements and conditions but not on
  declarations. At milestone 5 that is a leak on every `const s = f(x)`.

Neither is observable by running a program made only of trivial types. Both are
obvious in a snapshot.

The fix for the first is worth recording because the obvious version is wrong. A
condition's temporaries cannot die before the branch (the terminator is part of
the same full-expression), and they cannot die at the top of the branch's
*targets* either, because a target is reachable from more than one place — a
loop's exit block is entered both by the condition failing and by `break`, so a
`StorageDead` there runs twice on the `break` path. Each edge therefore gets a
block of its own. Cranelift folds the empty ones away.

### Scope exits are identity, not arithmetic *(2026-08-11)*

REWRITE-PLAN §10's first trap is v1's `switch` double free: `break` released
"everything down to depth N" with the bound inclusive where it should have been
exclusive. The fix is not to get the arithmetic right — it is to have none.

Every scope carries an identity. A loop records the scope it *lives in*, and
`break` unwinds while the top of the stack is not that scope, comparing objects.
The scope holding the loop is released by its own block exit, and there is no
depth to be off by one about. The golden MIR shows the result directly: on the
`break` edge the body's locals are released and the loop variable is not, and on
the `continue` edge the same, which is what leaves the loop variable live for
the update expression.

### The width pass is two passes, not one *(2026-08-11)*

REWRITE-PLAN §7 asks for the width rules to live in "one table-driven place
rather than scattered through lowering". They do: `packages/checker/src/widths.ts`
is the promotion relation, the operator table, and the literal ranges, as pure
data over `MachineType`, with no knowledge of MIR or tsc. That is what makes it
testable the way v1's `types.test.ts` tested it, which §12.3 asks for and which
is ported verbatim.

What was less obvious is that *applying* those rules cannot be done in one walk.
A literal has no width of its own — `42` is an `i32` in one place and a `u8` in
another, and neither is a conversion — so the width of `a * b < c` is not
knowable bottom-up or top-down alone. The lowerer therefore runs:

1. **`width(expr)`** — bottom-up, memoised, and the *only* place a width
   diagnostic is raised. It answers with a definite type, `poly` (built only from
   literals, takes its width from context), or `error`.
2. **`#value(expr, expected)`** — top-down, with the answer in hand, so a literal
   is range-checked against the width it is actually becoming and a promotion is
   emitted as an explicit `Cast` rather than assumed.

Memoising the first pass is what keeps a diagnostic from being reported twice
when the second pass revisits the same node.

### Exit codes are 8 bits, and the harness says so *(2026-08-11)*

Two width tests failed at first against exit codes of 1200 and 400, both coming
back as their low byte. The compiler was right: checked against PowerShell's
`$LASTEXITCODE`, a compiled program returning 300 really does exit 300. **Bun
truncates to 8 bits on Windows** — through `node:child_process` and
`Bun.spawnSync` alike — even though the OS carries a full 32-bit code there.

Not worth working around, because POSIX `waitpid` gives 8 bits regardless, so an
exit code was never a portable way to observe a value wider than a byte. The
harness documents the truncation on `RunResult.exitCode`, and a test that needs
a wider value compares it *inside* the program and returns a small verdict. Once
milestone 5 brings `console.log`, such values get printed and asserted against
stdout, which REWRITE-PLAN §9 wants to be the primary mechanism anyway.

### §11.7 (generics) did not need answering yet *(2026-08-11)*

The table below listed generics as needed by milestone 3. On reaching it, it was
not: the width pass operates on concrete types, and `nativeCast<T>` is an
intrinsic whose target width is read off the call's resolved type rather than
off any generics machinery. Either answer to §11.7 also leaves the MIR
monomorphic, since monomorphisation would happen in the frontend.

So it stays open, and a user-written generic function is `GF0001` — a gap in the
implementation rather than a rule about the language. The question now lands
wherever generic *user code* first matters, which is milestone 8 at the earliest.

### The TypeScript encoder is generated, not written *(2026-08-11)*

REWRITE-PLAN §2 says to define the MIR once in Rust and generate the TypeScript
types from it. Generating the *types* is not enough. postcard is not
self-describing — struct fields and enum variants are positional, and no name
reaches the wire — so a hand-written encoder that drifted by one field would not
fail to decode. It would decode into a different, entirely plausible module. That
is strictly worse than v1's hand-synced JSON, which at least had field names on
the wire to disagree about.

So `crates/goblin-mir/src/bindings.rs` walks the `postcard-schema` type graph and
emits both the types and the encoder, and three things keep the two halves
honest:

- a wire-format fingerprint, baked into the generated TypeScript and checked on
  every decode, so a prebuilt `.node` beside regenerated JavaScript is one clear
  message rather than a silent misparse;
- a Rust test asserting the checked-in bindings match what the generator would
  produce right now;
- a test that encodes in TypeScript, decodes in Rust, re-encodes in Rust, and
  requires byte equality — because "it decoded without error" is not evidence of
  anything.
