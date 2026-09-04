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

| C++ | Goblin | storage |
|---|---|---|
| `char buf[128]` | `FixedArray<T, N>` | **Inline** — no allocation |
| `std::vector<char>` | `T[]` | Owning handle, runtime length, growable |
| `new char[n]` / `delete[]` | `allocArray<T>(n)` / `p.freeArray()` | raw `Pointer<T>` |

All three are built. `T[]` grows by doubling from a floor of four, copies
element-wise with each element's own copy operation, and is released by the
scope that holds it; `tests/vector.test.ts` is its suite and the C++ oracle is
the arbiter for the value semantics.

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

### The array header, and what growth costs

`T[]`'s header is the shape a `string` has, with a capacity word behind it:

```text
  [ len: u64 ][ owned: u64 ][ elements … ]
                            ^ the `T[]` value points here
```

Elements are **inline**: an element occupies its stride, not a pointer to
itself. An element of an owning type is destroyed by the array as part of
destroying itself.

Growth reallocates, which **moves the elements** — so a `Pointer<T>` into an
array is dangling after a `push`, exactly as it is with
`std::vector::push_back`. That is the property the fixed-length design was
protecting, and it was given up knowingly: a growable vector is worth more than
an invalidation rule that holds only because nothing can grow.

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

An interface with only data members is a struct: C-compatible, copied by value,
and unchanged by any of this. The apparatus switches on only when someone writes
a method signature, which is what makes the interface a *contract* — so adding
classes changed the meaning of no declaration that already existed.

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
| — | **`free()` and `freeArray()` are callable on a `FixedArray<T, N>`.** They come with the `CorePointer<T>` that makes array-to-pointer decay work, and calling either is undefined behaviour — exactly as `free(buf)` is in C, and for the same reason. Taken deliberately over adding a second pointer type whose only difference is which mistakes it permits, but it is a real unsafety rather than an oversight, and it is the kind that a diagnostic could close cheaply: the compiler knows statically that the receiver is a fixed array. Revisit once classes settle what `Pointer<T>`'s member surface actually needs to be. | revisit at milestone 8 |

---

## §12 — Unions and enums *(settled and built, 2026-08-16)*

Both exist because a C header needs them, and both had the same problem: the
thing C says is not something TypeScript has syntax for. Neither answer adds
syntax — a Goblin program is a TypeScript program tsc accepts unmodified, and
that constraint is what picked both spellings.

### A union is `interface E extends Union`

`Union` is an empty, symbol-branded marker in the prelude, recognised the same
way `Pointer` and the widths are. The layout is C's: every member at offset 0,
size the largest member's rounded up, alignment the strictest member's.

**Not a `TyKind` of its own — a flag on `StructDef`.** A union *is* a struct
everywhere but the offset computation: the same fields, the same projections,
the same nominal identity, the same ABI classification, the same copy. A
separate variant would have meant nine `Struct | Union` arms doing identical
work and one doing something different, and the nine are where a missed case
would hide.

Two rules, and both fall out of what a union is rather than being policy:

- **Members must be plain data** (`GF0303`). Nothing in the bytes says which
  member is live, so nothing can say which one to destroy. C++ answers this by
  deleting the destructor and handing the problem back; here the member is
  refused at the declaration, where there is something to point at. The
  predicate is the existing `needsDrop`, so the rule and the drop pass cannot
  drift apart.
- **No object literal builds one** (`GF0304`). tsc asks for every property
  because it sees an ordinary interface, and a union has room for one.

Reading a member other than the one last written is undefined, exactly as in C,
and is **not** diagnosed. This is an unsafe language on purpose, and the
reliable read — the common initial sequence every member shares — is the whole
technique a tagged union is built on.

That left unions unconstructible, because a binding without an initialiser is
still `GF0001`. Hence **`zeroed<T>()`**: what `alloc<T>()` gives on the heap,
given on the stack, built from the `Default` a class already gets before its
constructor runs. Zero is a valid starting state for every member of a union.
It refuses a class, because `Default` would install a vtable without running a
constructor and `new C(…)` is the spelling that runs it.

### An enum's width is a merged namespace holding a *type*

```ts
enum SDL_EventType { Quit = 0x100 }
declare namespace SDL_EventType { type Underlying = u32 }
```

TypeScript allows decorators only on classes and class elements — `TS1206` on
an enum, checked rather than assumed — so the decorator spelling this started
as is not available. Of the forms that *are* legal, this one is the only one
that keeps every property worth having:

| | namespace + type | namespace + `const` | JSDoc comment | intersection alias |
|---|---|---|---|---|
| tsc checks the width | yes | yes | **no** | yes |
| clean value-position completion | yes | **no** | yes | yes |
| one name at the use site | yes | yes | yes | **no** |

A *type* rather than a `const` is the load-bearing part: `E.Underlying`
resolves in type position and a typo is an ordinary `TS2304`, while in value
position it does not exist at all, so an editor offers only the members.

**Rejected: a comment.** It works — the frontend can read a `@underlying u32`
tag off the AST — but comments are trivia. A formatter reflow, a doc rewrite or
a careless paste would silently change the width of every value in the enum and
nothing would fail. That is the failure class REWRITE-PLAN is built against;
the underlying type belongs where deleting it is a compile error.

**Rejected: inheriting the width from context.** An enum member could have been
a poly literal, taking its width from wherever it lands, exactly as `42` does.
That needs no declaration at all — but it also leaves nothing to check against,
so a `u32` constant narrowing into a `u8` field would only be caught when the
value happened to be out of range. Explicit is what makes `GF0160` reachable.

**The default is `i32`**, which is what a C enum is unless the ABI says
otherwise, so omitting the declaration is the common case rather than an error.
Order does not matter — symbol merging does not care, and the namespace may be
written first.

Members are folded by tsc, computed forms (`1 << 4`, `Previous + 1`) included,
and range-checked against the width **at the declaration** — so a member that
does not fit is wrong whether or not anything reads it. One trap worth
recording: `checker.getConstantValue()` answers for an `EnumMember` declaration
and returns `undefined` for the `E.A` that names it. Asking the wrong one does
not fail, it just yields no constant, and the expression lowers to nothing.

**String enums are `GF0001` — a gap, not a rule.** TypeScript has them and
there is nothing wrong with one; what is missing is the lowering. They are
implementable, and cheaply: the members would be string constants, which the
language already has. They are also the *only* way to write named string
constants while module-level `const` is unsupported, which is a real reason to
want them. They need no width at all, so a string enum and an integer one are
two lowerings rather than one with a flag — which is why the check is on the
whole enum rather than per member, and why one string member in a mixed enum
decides it.

---

## §13 — `void *` *(settled and built, 2026-08-16)*

POINTER-ERASURE.md is the working-out; this is what landed. The forcing case was
binding SDL3, where `void *` appears in a callback's userdata, in `memcpy`, in a
property bag, and as `void **` on every function that hands back a buffer.

**`Pointer<unknown>` erases to `Pointer<void>`.** Option 1 of the three the
document weighs, and the cheapest by a distance: `void` is already a `TyKind`,
`TyKind::Pointer(_)` is one machine word without ever consulting its pointee, and
the header generator already spells it `void*`. The backend needed **nothing** —
no new variant, no fingerprint change.

`unknown` is recognised as a pointee and nowhere else. A general `unknown` →
`void` rule in `erase()` would give a bare `let x: unknown` a machine type
occupying no bytes; as a pointee it is the one position where "no type" means
something. The mechanical part that had gone unnoticed is that
`getNonNullableType(unknown)` is `{}`, so before this the failure was "an object
with no fields has no machine representation" — true of `{}`, and nothing to do
with what was written.

**The dangerous operations are refused, and the refusals are inherited.** The
document predicted five hand-written guards. The opaque-handle work made that
obsolete: every operation needing a pointee's layout already funnels through
`requireKnownLayout`, so a single `void` arm covers `p[i]`, `p.offset(n)`,
`p.deref()`, `p.free()`, `p.freeArray()`, `alloc`, `allocArray`, `sizeOf`,
`alignOf` and `zeroed` (`GF0305`). They have to be written down because `void`
*has* a layout — nought bytes, aligned to one — so not one of them fails on its
own. `free()` is the one that would not merely be wrong: it would run no
destructor, so whatever the value owned is leaked in silence. (As first written
this said `gf_free` was Rust's `dealloc` and had to be handed the layout, making
the call a corrupted heap. That stopped being true when the allocator became
mimalloc — see §15 — and the refusal now rests on the destructor alone.)

**Erasing is implicit; reifying is written.** C's asymmetry, for C's reason —
throwing the type away cannot be wrong, and guessing it back can. tsc already
agrees in both directions with no prelude change, because `CorePointer<T>` is
covariant in `T`: `Pointer<Rect>` is assignable to `Pointer<unknown>` and not the
reverse. So the compiler side is one arm in `#coerce` beside the existing
`Pointer<Derived>` → `Pointer<Base>` one, and the same non-event at runtime.
Without it every SDL call touching a `void *` grows a conversion that says
nothing the C header did not.

**`reify<U>()` is refused on a pointer that never lost its type** (`GF0306`).
This is the wart the document names: `reify` is declared on `CorePointer<T>`, so
tsc allows `somePointerToI32.reify<Rect>()`, which is exactly the "unchecked cast
between two concrete pointee types" the prelude says does not exist. The rule
makes the round trip visible — `p.erase().reify<Other>()` — at the site that
depends on it.

**Rejected: folding both into `cast<Pointer<T>>`.** The design POINTER-ERASURE.md
probed. It kills the wart structurally rather than by rule, which is better, but
`GF0163` already states in the code table that `cast` "is not a reinterpretation
and not an escape hatch: converting a pointer, a string, or an aggregate is a
different operation with different rules, and each has its own spelling." C++
separates `static_cast` from `reinterpret_cast` for the same reason. Changing
that meant a second overload, a worse tsc message for `cast<i32>(p)`, and
rewriting a decision already recorded — against a wart that a frontend rule
closes.

**Rejected: `Void` and `ConstVoid` as declared types.** They would read like the
C header and let the generator emit `const void*`, but a nominal `Void` breaks
implicit erasure (a `private` member makes `Pointer<Rect>` unassignable), and a
structural one is `unknown` with more names. `ConstVoid` is the worse half: there
is no const anywhere else in the type system, so it would be a qualifier that
exists for exactly one pointee type and enforces nothing — `const` in a generated
header is a whole-language question about every pointer, not this one. A binding
writes `Pointer<unknown>` for both `void *` and `const void *`, which is
truthful: they are the same machine type and the same ABI.

---

## §14 — `null`, and array-to-pointer decay *(settled and built, 2026-08-16)*

The two things a C binding wanted immediately after `void *`, landed together
because writing SDL3 declarations needs all three at once.

### `null` is a value, and only three types have one

The *type* half had worked for a while — `Pointer<T> | null` erases to the same
machine word as `Pointer<T>`, and `p === null` was already a comparison against
zero — so what was missing was writing the word. `Const::Null` was already in
the MIR and already emitted by the null *test*, so the lowering is `null` as a
context-typed expression, `POLY` in the width pass like a numeric literal.

**Which types may hold one is the whole of the rule** (`GF0237`), and it is
closed rather than "anything one machine word wide":

- **`Pointer<T>`, `CString`, a function pointer** — yes. All three are borrowed:
  nobody here owns what they point at, so a zero is a value the type already has
  to survive, and C hands them back all day.
- **`string`, `T[]`** — no. One word each, and *owning*, so a null one would
  reach the drop pass at the end of its scope and be released like any other.
  The value that means "nothing" for those is an empty one.
- **`Reference<T>`, a contract reference** — no, for a different reason. A
  reference is bound once and read through without asking; `tryCast` is what
  produces a nullable one, and its result is checked before it is used. A
  contract reference is also not one word — it is the `(itab, data)` pair — and
  `Const::Null` is a pointer-width zero whatever type it carries.

That last clause is why the set is a written rule and not a guess: the backend
lowers `Const::Null` to `iconst(pointer_type, 0)` unconditionally, so a type
this list wrongly admitted would get one zero word where its representation
wanted something else.

**`const x = null` is refused** (`GF0161`), with its own message rather than the
literal's — `null` has no *type*, where `42` merely has no *width*.

### `FixedArray<T, N>` decays to `Pointer<T>` and to `Pointer<unknown>`

C's conversion, and the spelling every C example uses: `char buf[1024]` passed
to `fwrite`. POINTER-ERASURE.md flagged that this is **not** free once pointer
casts exist, and it is right — a fixed array *is* the bytes, so decay lowers to
an `AddrOf` of the array's place, not a retype of a value. Retyping the operand
would give the same word by luck rather than by rule.

To its own element type or to `void`, and nothing else — C's rule exactly. It is
also all tsc permits: `FixedArray<T, N>` extends `CorePointer<T>`, so the width
brands keep `Pointer<u8>` and `Pointer<i32>` apart before the compiler is
reached, and a mismatched decay is a `TS2322` rather than a diagnostic of this
compiler's own. There is deliberately no `GF0xxx` for it; a code nothing can
reach is one `tests/diagnostics.test.ts` would have to carry an excuse for.

**A temporary may be decayed as an argument and not bound to a name.** The same
rule a borrow gets, enforced by the same `borrowsTemporary` flag and reported as
the same `GF0234`: the call finishes inside the enclosing full-expression, so a
pointer to a temporary array is alive for exactly as long as the call, and a
binding would outlive it.

---

## §15 — The allocator is mimalloc *(settled and built, 2026-08-18)*

The runtime called `std::alloc::{alloc, dealloc}` at seven sites. It now calls
mimalloc's C API directly, by FFI, bypassing `std::alloc` entirely. There are
three separate things here and conflating them is the mistake to avoid.

**The direct `mi_malloc`/`mi_free` calls are the substance.** Nearly all of a
Goblin program's allocation traffic goes through `gf_alloc`, `gf_string_*` and
the two array families, so this is both the Windows performance win — the
platform default is the weakest of the three — and the thing that changes the
ABI. `libc` was already the runtime's only dependency and a `cc` toolchain is
already required for linking on every user's machine, so mimalloc's C source
compiles through a path that had to exist anyway.

**Every free in the ABI now takes one argument.** `gf_free(p)`,
`gf_free_array(p)`, `gf_array_free(a)`, `gf_alloc_array_count(p)`. Rust's
`dealloc` is *given* the layout and cannot be asked; mimalloc can, so the size
and the alignment stopped being numbers a call site carries — and therefore
stopped being numbers a call site can carry wrongly. Ownership stays written
down, and one fewer thing about it has to be re-derived at each site.

The alignment half is subtler and is the part worth recording. The obvious
arrangement — round the header up to the element's alignment and align the
*base* — is what the code did, and it forces the free to be told the alignment
again to find its way back. Instead the headers are **fixed sizes** (one word
for an `allocArray` run, two for a `T[]`) and it is `base + offset` that is
aligned, through `mi_malloc_aligned_at`. The base is then a constant distance
behind the pointer, which is what makes the one-argument free possible at all.

That also fixed a live bug rather than only enabling an ABI. `T[]` aligned the
block and put the elements at a fixed 16 bytes past it, so any element wanting
more than 16 was under-aligned. Unreachable today, since nothing the layout
engine produces exceeds 8 — and exactly what the planned SIMD work would have
hit first. `packages/runtime/native/src/lib.rs`'s tests cover alignments up to
128 for that reason: it is the one arrangement no Goblin program can currently
ask for, so the language cannot test it.

**`#[global_allocator]` is a separate, smaller step**, taken in the same change
and worth keeping distinct. It covers the runtime's own incidental Rust
allocations (`to_string` in the number conversions, `std::io` buffering) and the
compiler's, in the napi addon. It would **not** have delivered the ABI
simplification on its own: `GlobalAlloc::dealloc` takes a `Layout` by the trait's
definition, so a `gf_free` left on `std::alloc` would still have needed one.

**`p.erase().free()` is still refused, for a different reason.** It was a
corrupted heap, because the layout could not be reconstructed. It is now a
silent leak, because no destructor can run without a type. `GF0305` stands and
its prose was rewritten; POINTER-ERASURE.md carries the amendment beside the
original claim rather than in place of it.

**Sharing the heap is opt-in and needs no override machinery.** `mi_malloc`,
`mi_calloc`, `mi_realloc`, `mi_free`, `mi_zalloc`, `mi_malloc_aligned`,
`mi_realloc_aligned` and `mi_usable_size` are published from `"std/alloc"` as
ordinary `extern "C"` imports, so

```ts
import { mi_calloc, mi_free, mi_malloc, mi_realloc } from "std/alloc";

SDL_SetMemoryFunctions(mi_malloc, mi_calloc, mi_realloc, mi_free);
```

is a pair of lines that compiles — the signatures match C's exactly. No
`mimalloc-override` feature and no redirect DLL: that machinery exists for
*unqualified* `malloc()` calls in third-party code, which a library's own hook
sidesteps.

These eight are not intrinsics, and they are an **allowlist** in
`lower/tables.ts` rather than a general "any std declaration nothing else claims
is an extern" rule. The fallback matters when it is wrong: a new intrinsic added
to the prelude and not yet lowered should be `GF0001` with a caret under it, not
an unresolved external from the linker with no file and no line.

### The standard library arrives as ambient modules

This is where that mechanism was settled, and these eight are what settled it —
ordinary `extern "C"` declarations rather than intrinsics, and so the honest
test of whether a std module could carry anything at all. The global surface has
room for `console` and the twelve widths, and not for a hundred functions per
module.

**It needs no configuration.** tsc matches the specifier against the ambient
declaration directly: no `paths` entry, no package, and nothing on disk to
resolve to. The declaration in the prelude is the whole of it.

**`STD_MODULES` is keyed by specifier before name**, which is not cosmetic. A
flat table of names would match a declaration in *any* `.d.ts` the project
included, so a user's own `declare function mi_malloc` would be silently
rebound to the runtime's trampoline. `mi_malloc` is only this `mi_malloc` when
it came from `"std/alloc"`, and that is exactly what an ambient module is for.

The externs are registered per *declaration*, not per import, which is what
makes every spelling reach the same symbol: a named import, an `as` rename, a
re-export through a user module, and a namespace import all land on the one
declaration in the prelude, whichever file did the importing. So one module may
write `import * as alloc` and another `import { mi_malloc }` in the same
program, and there is nothing to reconcile because there is nothing per import.

**A namespace is not a receiver.** `ns.f` sits exactly where `C.f` sits: a
qualified *name* rather than a property of an object, resolved through tsc's
symbol before anything asks the thing on the left for a value. It emits the same
**direct** call the bare name does — `call ptr @gf_mi_malloc(i64 64)`, no load
and nothing indirect — so there is no module object at run time. That is the
point rather than the obstacle: nothing has to exist for a name to be qualified
by it.

---

## §16 — The runtime may be linked shared *(settled and built, 2026-08-18)*

`runtime: "static" | "shared"` on the build config, defaulting to `"static"`.
Everything below follows from one fact: a statically linked runtime is a *copy*,
and two copies in one process is two of everything the runtime owns.

**The problem is not new, and it was worse than it looked.** Two Goblin
artefacts in one process — a `shared-lib` loaded by a `bin` — each carry a
mimalloc, a `LIVE` counter, an `atexit` reporter and a `gf_string_free`. A
`string` allocated in the library and released by the scope holding it in the
executable is a cross-heap free. Before mimalloc the two copies happened to land
in the same CRT heap and the corruption was silent; §15 made it loud, which is
an improvement and not a regression.

Checking the configuration turned up a second, independent bug: a `shared-lib`'s
`.def` lists only the module's own defines, so a string-returning Goblin DLL
exports `greet` and not `gf_string_free` — while its generated header tells the
consumer to call exactly that. On Windows a C consumer could not link. So the
path had never worked end to end, and there was less to preserve than it
appeared.

**Shared linking is the whole fix, and only for the case that needs it.** Both
artefacts import one runtime: one heap, one counter, one reporter. The
live-allocation check gets *more* correct rather than less — two artefacts used
to produce two report lines. The cost is a file beside the binary, so it is
opt-in; a single program stays one self-contained artefact, which is what almost
every build is.

**The `mi_*` surface is trampolined, and that was forced.** §15 published eight
mimalloc entry points under their C names. A cdylib exports the Rust symbols it
defines and does **not** re-export C symbols reaching it from a bundled native
static library, and each platform hides them differently: MSVC wants `/EXPORT:`
per symbol (verified working, and it composes — rustc uses `/EXPORT:` itself
rather than a `.def`), ELF has a version script whose `local: *` outranks
`--export-dynamic-symbol`, and Mach-O **fails the link** if `-exported_symbol`
is passed beside the `-exported_symbols_list` rustc already supplies. Three
mechanisms, one of them a hard error, and only the first testable on the machine
this was written on.

So the runtime defines eight one-line `gf_mi_*` wrappers instead. A Rust symbol
exports from a staticlib and a cdylib identically on all three platforms with no
linker argument anywhere. The prelude still spells them `mi_malloc` — the name
has to type-check against a signature C wrote — and `STD_MODULES` maps the
declaration to the symbol. The secondary benefit is the one likely to matter
later: the published surface is now *ours*, so the allocator underneath it can
change again without it moving.

**The header and the export list are now one list.** The second bug above is
fixed rather than worked around, and independently of heap sharing: a
`shared-lib` publishes the runtime functions its own header declares. Both read
`RUNTIME_STRING_API` in `header.ts`, so the pair cannot drift — which is the
only reason they disagreed in the first place, one being a literal in the
header generator and the other a field on the link request.

Gated on the runtime being linked *statically*, and the reason is not the one
that first suggests itself. `link.exe` accepts an imported symbol in a `.def`
quite happily and emits a forwarder; that was checked rather than assumed. It is
gated because ELF records an import as an undefined entry rather than a
definition, so a consumer there has to link the runtime whichever way this went.
One rule for both platforms is worth more than one fewer import library on one
of them.

The header's banner had the same class of fault and is fixed with it. It told
every consumer to "link the Goblin runtime alongside this library", which is
right for an archive and actively harmful for a DLL — the runtime is already
inside, so taking the advice puts a second copy in the program. Three cases,
three different sentences, and a test that they are different.

---

## §17 — The backend becomes LLVM *(settled and built, 2026-08-18)*

**Answer: LLVM replaces Cranelift, and it happens before any vector work
lands.** The requirement that forces it is f64 linear algebra at speed, for a
space simulation whose world coordinates cannot be f32. The ordering is
deliberate: every further feature built on Cranelift is another thing to port,
so the swap goes first rather than after the pit is deeper.

### The requirement is f64, and that is what makes it structural

For f32 this decision would not be worth making. A `vec4<f32>` is one XMM
register, a `mat4<f32>` is four, and GLM — the shape being copied — is an SSE2
library with a thin AVX layer bolted on for exactly two types. Cranelift covers
that case today.

Doubles move every shape up one register class:

| type | bits | AVX2 | SSE only |
|---|---|---|---|
| `dvec2` | 128 | 1 YMM, half wasted | 1 XMM |
| `dvec3` | 192 | 1 YMM, one lane wasted | 1 XMM + scalar |
| `dvec4` | 256 | 1 YMM | 2 XMM |
| `dmat4` | 1024 | 4 YMM | 8 XMM |

The 2× on `dvec4` arithmetic is the obvious cost and the smaller one. The last
row is the argument: x86-64 has sixteen vector registers, so under SSE a single
`dmat4` occupies half the register file and a matrix-times-matrix — two operands
and an accumulator — has lost before it starts. Every one spills. That is not a
constant factor, it is the abstraction failing to be zero-cost, which for a math
library is the whole product.

The target is **AVX2 + FMA**, not AVX-512: four doubles per YMM, near-universal
since about 2014, and free of the downclocking and consumer-availability
problems of 512-bit parts. FMA is wanted for its own sake as much as for speed —
Kepler solvers and Newton–Raphson iteration round once instead of twice, and at
f64 world scale that accuracy is a feature.

### The premise, checked rather than assumed

Cranelift 0.134's IR type system names `F64X8`, `I32X8` and friends, and
`ir/types.rs` documents lane counts up to 256. This is a trap. In
`isa/x64/inst/regs.rs`:

```rust
RegClass::Vector => unreachable!(),
```

The x86-64 backend has no vector register class beyond `Float`, which is XMM.
The wide types exist in the IR and cannot be register-allocated on the target
that matters. The failure mode for anyone who tries is not a diagnostic.

The nuance worth recording, because it makes the gap narrower than it sounds:
`isa/x64/mod.rs:174` gates on `has_avx() && has_fma()`, so Cranelift *does* emit
AVX-encoded instructions and real FMA when the host has them. What is missing is
lane width, not the instruction set.

### What tipped it was not AVX

Three reasons found while checking the first one, all of which outrank it.

**SROA, not the inliner.** Cranelift 0.134 ships `src/inline.rs`, whose own
header describes it as "inlining as a library" — `InlineCommand::{KeepCall,
Inline}` plus an `Inline` trait, mechanics without heuristics. The mechanics are
the hard part and they are done; a policy of "inline what is marked, or what is
small" is an afternoon. So "Cranelift cannot inline" is false and should not be
cited. What Cranelift cannot do is *clean up afterwards*: its egraph mid-end
does GVN, LICM, constant folding and redundant-load elimination through alias
analysis, but it does not promote aggregates to registers. Inlining a `dvec3`
operator without scalar replacement yields the callee's body plus a stack slot
for its result, so a four-operator chain is four slots and eight memory
round-trips — roughly what the calls cost. mem2reg/SROA is the pass being
bought, and for a value-semantics math library the cleanup *is* the
optimization.

**No auto-vectorizer at all.** Not a weak one; none. Cranelift emits a vector
instruction only where one was written. Since the bulk numerical work here wants
SoA (below), the consequence is that every SoA loop is hand-vectorized forever.
This is the reason that compounds rather than the one that is largest today.

**No debug information, and the knob is a lie.** `object.rs:25` declares
`pub debug_info: bool` and `packages/backend/src/lib.rs:182` threads it through;
nothing reads it. No DWARF, no PDB, no line tables — so no source-level
debugger, no symbolized profile in perf or VTune or Superluminal, and no
symbolicated crash dump from a player. For a compiler under construction that is
acceptable. For one meant to ship a game it is not, and teaching Cranelift to
emit real DWARF is work that would be done from scratch, against LLVM's
DIBuilder being a worn path to both DWARF and CodeView.

### What the port costs, and what it does not

Cranelift is barely in this codebase, which is the reason this is a port rather
than a rewrite:

| file | lines | `cranelift` references |
|---|---|---|
| `translate.rs` | 2770 | 18 |
| `abi.rs` | 755 | 7 |
| `layout.rs` | 401 | 1 |
| `link.rs` | 380 | 0 |
| `object.rs` | 266 | 9 |

The instruction set in use is about fifty opcodes — `iadd`, `load`, `brif`,
`fcvt_to_sint_sat` — every one with a direct LLVM equivalent. `translate.rs` is
mechanical.

**`abi.rs` survives nearly intact, and that is the single most important fact
here.** LLVM does not classify C ABIs either; clang does it in the *frontend*
and hands LLVM types plus `byval`, `sret` and `inreg` attributes. The Win64 and
System V eightbyte classification — the code REWRITE-PLAN §13 calls the newest
and best-tested in the project, validated against GCC 15 on real hardware — is
untouched in substance. It stops emitting a `cranelift::Signature` and starts
emitting LLVM types and parameter attributes. `link.rs` is untouched outright.
`object.rs` is replaced. `layout.rs` needs one reference removed.

Getting `cranelift::ir::Type` out of `layout.rs` and `abi.rs` — one reference
and seven — is worth doing as a separate step before the port, because it is
what keeps the port a port, and it leaves the two-backend option (Cranelift for
debug builds, LLVM for release, rustc's own arrangement) available without
paying for it now.

### Textual IR and a subprocess, not `llvm-sys`

`llvm-sys` means every contributor and every CI runner needs a version-matched
LLVM that MSVC agrees with, and there is no `rustup component add llvm`. It also
means `goblin-backend.win32-x64-msvc.node` goes from 6.1 MB — small enough to
commit, and committed — to something between 60 and 120 MB, which is not.

The decisive argument is that this compiler **already** shells out: to
`cargo rustc` for the runtime (`packages/runtime/src/build.ts:69`), to the
system linker (`link.rs`), and to `cc`. "Requires an external toolchain at
compile time" is the status quo, not a new class of dependency, which is what
makes emitting IR text and invoking `llc` or `clang` cheap where it would be
expensive elsewhere. The cost is a process spawn per module and no in-memory
path. The benefit beyond distribution is that the output is diffable and can be
pasted into Godbolt — which matters most for exactly the vector codegen this is
all for.

`llvm-sys` stays available as a later optimization if spawn cost ever shows up
in a profile. It is not the starting point.

### The invariant that gets harder, recorded as a risk

CLAUDE.md's second rule is that the backend never reports a user error — it
panics, so that a test cannot mistake a compiler crash for a correct rejection.
Cranelift honours this by construction: bad IR hits the verifier or panics, and
either way it is loud.

**LLVM's failure mode for a whole class of mistakes is a silent miscompile.**
Wrong `byval` alignment, `sret` on the wrong parameter, a GEP off by one field —
the verifier checks structure, not intent, and the result is a program that
links and runs and is wrong. The C++ oracle and `tests/struct-abi.test.ts` are
the real defence and they are already built, which is the good news. The bad
news is that the feedback loop goes from a stack trace to a diverged allocation
trace, and that difference is not compressible by throwing more compute at it.
The System V `__m256` classification is the specific place to expect trouble:
Win64 passes 32-byte vectors by reference under the default convention (only
`__vectorcall` puts them in registers) and System V's rules for them are
AVX-conditional. Both must be *tested* against a C compiler rather than written
from the psABI — §"System V is tested, not asserted" applies unchanged, and with
more cases.

Relatedly, LLVM has a UB surface Cranelift does not: poison, `nsw`/`nuw`,
`noalias`, TBAA. The default is to emit none of them. That costs some
performance and is correct; the hazard is asserting one *accidentally* and
having it be true for two years.

### Decided alongside, and independent of the backend

Two things settled in the same discussion that hold whichever backend wins.

**A `dvecN` gets a packed type and a spelled aligned type, not one type with
hidden padding.** The tempting design — keep `dvec3` densely packed at 24 bytes
so array stride and the C boundary stay exact, and widen to 32 only in registers
— does not survive counting instructions. Getting 24 bytes into a YMM is either
a 32-byte load that reads past the end of the last array element (a fault, in
the case where mimalloc hands back page-aligned memory), a masked load whose
throughput is poor and whose masked *store* carries a store-forwarding stall, or
a three-instruction split. And the store can never be widened at all: the eight
bytes past element *i* are element *i+1*'s `x`. Taking the split, an isolated
packed `dvec3 + dvec3` is ten instructions under AVX2 against eight under SSE2 —
the padding scheme makes single operations *slower*, and only pays across a
chain of operators that stays in registers, which is the SROA dependency again.
Stride 24 also means alignment cycles 0, 24, 16, 8 mod 32, so every load is
unaligned and cache-line splits are constant.

So both layouts are written down and the user picks, which is GLM's answer
(`glm::vec3` versus `glm::aligned_vec3`) arrived at independently. The house
rule decides it: a memory shape the type does not state is a property
re-derived at every load, store and FFI boundary, and that is the exact failure
pattern the ownership rule exists to prevent.

**Bulk numerical work is SoA; AoS is for the C boundary and gameplay code.**
The motivation for packing was memory bandwidth, and for the loops where
bandwidth actually dominates — propagating ten thousand orbits, n-body
integration — packed AoS is the wrong answer anyway. Three separate `f64[]`
beat it outright: no padding, permanent alignment, four *objects* per YMM per
component, no shuffles. Splitting the two cases is what releases AoS from having
to carry the bandwidth argument, which was the thing forcing the 24-byte
compromise.

Worth noting for whoever revisits this: the vertex-buffer constraint that
motivated packing belongs to `vec3<f32>` at 12 bytes, not to `dvec3`. GPUs run
f64 attributes at 1/32 or 1/64 rate, so the pipeline is doubles on the CPU,
subtract the floating origin, downcast, upload.

### Floating-point contraction is a language question, not a backend one

Neither backend fuses `a * b + c` into an FMA without permission, because it
changes the result. So an explicit `fma` intrinsic or an opt-in contraction mode
has to be designed either way, and it should be settled before the port rather
than becoming a flag attached to whichever backend is underneath.

### Two baseline-ISA faults found while checking this

Both are live today, both are small, and neither depends on the outcome.

`make_isa` in `object.rs` branches on whether a target was named. The host path
uses `cranelift_native::builder()`, which detects and enables host features; the
explicit-triple path uses `isa::lookup(parsed)`, which yields a **baseline** ISA
with no AVX and no FMA. So `--target x86_64-pc-windows-msvc` and no `--target`
silently produce different instruction sets on the same machine.

`packages/runtime/src/build.ts:69` runs `cargo rustc --release --quiet` with no
`-C target-cpu`, so the runtime — which already goes through LLVM — is compiled
at baseline too.

### The case against, and why it did not win

Recorded because it is a good case and the decision should not look obvious in
hindsight.

The backend port is the *smaller* half of the work: MIR vector types, the
packed/aligned pair, `__m256` classification, contraction semantics,
target-feature plumbing and a CPU-dispatch story for machines without AVX2 are
all required under either backend and are most of the calendar time. And the
strongest argument for the port may never appear in a profile — the SROA case is
about fine-grained per-object expression chains, while a space simulation's f64
throughput lives in the bulk integration loop, which is SoA, where AoS register
shape is irrelevant. The cheap path was: fix the two ISA faults above, write the
bulk kernels SoA in Rust with `target_feature(enable = "avx2,fma")` at a
granularity coarse enough that the call boundary rounds to zero, build the game,
and profile before porting anything.

The user's answer, and it is the deciding one: the implementation labour here is
an agent's rather than a person's, so six months of human estimate is not the
quantity being spent. What is being spent is money and validation wall-clock,
and the wager is that porting now costs less than porting after several more
milestones have been built on top of Cranelift. Which is the ordering argument
at the head of this section, and the reason the swap precedes the vector work
rather than following it.

### The optimisation levels are LLVM's, and the runtime is built at yours

`optLevel` is `"O0"`, `"O1"`, `"O2"`, `"O3"`, `"Os"` or `"Oz"` — clang's own
vocabulary, because it is clang's own set. Naming them for what they are *for*
rather than what they *are* leaves two thirds of them nowhere to live: `-O1` and
`-O3` are both "speed", and they differ by more than the gap between "speed" and
"size" does. `"O2"` is the default, because `-O3` is not reliably faster — it
trades size and compile time for inlining and vectorisation that as often costs
as gains.

**The runtime crate is built at the same level.** Otherwise a program asking for
`Oz` gets its own code small and links a runtime at `opt-level = 3`, which is
the case where the mismatch contradicts the request rather than merely
surprising it. `--release` still supplies the *profile* — `lto` and
`panic = "abort"` are properties of how this crate is built at all, not of how
hard it is optimised — and only `opt-level` is overridden, through
`CARGO_PROFILE_RELEASE_OPT_LEVEL` rather than `-C opt-level` after the `--`.
Those flags reach the final crate only, so mimalloc, libc and libm would stay at
`3` while the runtime alone moved, which makes `Oz` a claim about one of four
things in the library.

**The part that has to be got right is the output directory.** cargo writes
every profile to `target/release` whatever the level, so two levels are one
path: a second build overwrites the first, and the first caller's cached path
keeps naming a file that is now somebody else's library. Nothing downstream can
notice — it links, it runs, and it is simply not the build that was asked for.
So each level gets `target/opt-<level>/`, and the in-process cache is keyed by
target *and* level. `build-options.test.ts` builds two levels and requires two
distinct files.

The cost is one cargo build per level per checkout, mimalloc included — what any
toolchain charges for a debug and a release build, cached on disk afterwards.

### Amendment: AVX2 is a baseline requirement *(2026-08-18)*

**The compiler targets `x86-64-v3` and does not run on anything older.** The
user's decision, with the precedent that Unreal Engine and others already
require it. It removes one item above and simplifies a second; the third is
untouched, and the third was the one flagged as risky.

**Gone: the dispatch story.** No function multiversioning, no IFUNC, no
`target_clones`, no runtime feature probe, no question about what a binary does
on a 2012 machine. That was listed above as required work under either backend
and it is now not work at all.

**Unchanged: Win64.** An ABI is a property of the platform, not of the CPU
underneath it. MSVC's default x64 convention passes *anything* larger than eight
bytes by reference — `__m128`, `__m256` and `__m512` alike — and only
`__vectorcall` puts a vector in a register. Guaranteeing AVX2 changes none of
it. The consequence is a design fact worth stating plainly rather than
discovering: **a `dvec4` crossing an `extern "C"` boundary on Windows travels
through memory, always.** The fast path is intra-module and the C boundary is a
serialization point. Which is workable, and makes the Win64 rule the simplest
one available — but it was already simple, for reasons that predate this
decision.

**Simplified: System V.** The psABI classifies a 32-byte vector conditionally on
AVX being enabled, which is why GCC warns that an AVX vector argument without
AVX changes the ABI rather than silently choosing. With AVX2 fixed as a
baseline the conditional collapses to one unconditional rule: SSE plus SSEUP, in
a YMM register. One rule rather than a branch is materially less to get wrong.

It is still *tested* rather than asserted, and the reason is not stubbornness.
The baseline is set for this compiler, not for the C libraries it links against,
and one built without `-mavx` classifies `__m256` differently. That exposure is
close to zero in practice — approximately no C library passes a `__m256` by
value across a public API — but "close to zero" is why the rule stays in the
differential suite instead of in a comment.

**The larger payoff is not about vectors at all.** An AVX2 baseline lets the
whole backend assume VEX encoding: three-operand and non-destructive, so every
scalar `f64` operation stops needing a `movapd` to preserve its operands. That
is a win on all the double arithmetic in the language, including code that never
names a vector type. FMA becomes unconditional, so contraction is a pure
language question with no target check behind it. And unaligned `vmovupd` is
near-free on AVX2-era parts when it does not cross a cache line, which weakens
half the alignment argument for the aligned type above — the cache-line-split
half stands, since a 24-byte stride still straddles lines constantly.

`x86-64-v3` is the spelling: AVX2, FMA, BMI1/2, LZCNT, MOVBE. The same value
reaches each tool under a different flag, and getting this wrong is an error
rather than a silent fallback — rustc takes `-C target-cpu=x86-64-v3`, clang
takes `-march=x86-64-v3`, and `llc` takes `-mcpu=x86-64-v3`. Passing `-mcpu=` to
clang on an x86 target is rejected outright ("unsupported option"), because on
x86 clang follows GCC in reserving `-mcpu` for other architectures.

Cranelift has no microarchitecture presets — its generated x64 settings expose
`has_avx`, `has_avx2`, `has_fma`, `has_bmi1`, `has_bmi2`, `has_lzcnt` and
`has_popcnt` individually — so fixing `make_isa` in the interim means enabling
them one at a time, and the single flag arrives with the port.

**The Win64 claim above is tested, not asserted.** A function declared
`define <4 x double> @vadd(<4 x double>, <4 x double>)`, compiled by clang 22.1.8
for `x86_64-pc-windows-msvc` at `-O2 -march=x86-64-v3`, is three instructions:

```asm
vmovapd (%rcx), %ymm0
vaddpd  (%rdx), %ymm0, %ymm0
retq
```

Both 32-byte arguments arrived as *addresses* in `rcx` and `rdx` — by reference,
exactly as the convention says — while the arithmetic itself is VEX-encoded on
YMM registers. Both halves of this section's argument, in one disassembly.

### The toolchain this needs, and what a stock Windows LLVM provides

Checked on the development machine, 2026-08-18: winget's `LLVM.LLVM` 22.1.8
installs to `C:\Program Files\LLVM` and ships the *toolchain* — `clang`,
`clang-cl`, `lld-link`, `llvm-ar`, `llvm-objdump` — but none of the developer
tools. No `llc`, `opt`, `llvm-as`, `llvm-dis`, `llvm-mc` or `FileCheck`.

That is sufficient, and it is worth writing down why so the missing `llc` does
not read as a blocker later. `clang -c module.ll -o module.obj` compiles IR text
to an object directly, which is the whole of the emit path chosen above, and
`clang -O2` runs the pass pipeline that `opt` would have. Neither absent tool is
on the critical path.

What the stock install *does* foreclose is the `llvm-sys` fallback. There is no
`llvm-config`, no `include/llvm-c`, and six `.lib` files where a development
build has well over a hundred. Taking that route later means building LLVM from
source rather than changing a dependency — so the note above that `llvm-sys`
stays "available as a later optimization" is true of the design and not of any
toolchain currently on disk.

---

## §18 — Closures *(settled 2026-08-19; `LocalFn` built, `HeapFn` and `RefCount<T>` not)*

**Answer: three function types, all written down, none inferred.** A bare
`(a: i32) => i32` stays what it already is — one code address, no environment,
capture is an error at the lambda. `LocalFn<F>` adds an environment that cannot
escape the call. `HeapFn<F>` adds one that can, and pays for it by taking
ownership of what it captures.

The shape came from Swift's escaping/non-escaping split, reversed: Swift marks
the *escaping* case and defaults to non-escaping. Here the default is neither —
it is the no-environment case that exists today, and both closure forms are
opted into by the type that receives them.

### Why the split is not inferred from context

The first sketch had one spelling, `() => i32`, meaning a bare function pointer
when it flowed into an `extern` declaration and a heap closure when it did not.
That is rejected for two reasons.

The smaller one is that it re-opens a question this compiler answers everywhere
else by writing it down. A type whose representation depends on where the value
flows is a property of the program that has to be re-derived at every site, and
REWRITE-PLAN's whole account of why v1 leaked is that exactly one site always
gets missed.

The larger one is the diagnostic. Under inference, `const cb = (x: i32) => x + n;`
is fine where it is written, and the error arrives later at the `extern` call
that could not accept an environment — pointing at a parameter, in a signature
the programmer may not own, about a capture several lines up. Under three named
types the error is at the lambda, on `n`, which is the thing that has to change.

### `LocalFn<F>` is a borrow, and the rule is escape rather than storage

Its representation is two words — a code address and a pointer to an
environment that lives in the caller's frame. Category `Borrow`, storage class
`Borrowed`: it owns nothing, copies trivially, and destroys nothing. Captures
are references into the frame, which is sound for precisely the reason the type
exists — the frame is alive for the whole of the call.

The restriction was first written as "cannot be stored in a variable at all".
That is the wrong rule in both directions. It forbids things that are safe:

```ts
function each(xs: i32[], f: LocalFn<(x: i32) => void>): void {
    const g = f;        // same lexical extent, nothing escapes
    inner(xs, g);       // inner also takes LocalFn, still bounded by this call
}
```

and, taken literally, it says nothing about the cases that actually break —
returning one, storing one in a struct field or an array, capturing one inside a
`HeapFn`. The rule is **escape**, and it is the rule `Reference<T>` already
lives under. `GF0234` ("a reference cannot borrow a temporary") is the local
half of it; a `LocalFn` needs the same treatment extended to the ways a value
leaves a frame.

The name says where the environment lives rather than what the type forbids,
which is a description of the consequence rather than the contract. Kept anyway:
it is the name the design was discussed under, and `Local` reads correctly at
every call site that matters.

### What was built, and the two rules that came out of building it

The value is a two-word struct — a code address and a `Pointer<unknown>` to an
environment — and **not** a `TyKind` of its own. The rule that distinguishes a
`LocalFn` from a pair of pointers is a frontend rule, checked where `LocalFn<F>`
is still spelled, so a MIR node would carry nothing the backend acts on and
would cost a wire-format fingerprint to add. `Reference<I>` travels as an
`(itab, data)` pair for the same reason.

The environment is a struct of `Reference<T>`, one per capture, built as a
temporary at the closure site. Category `Borrow` throughout: nothing in a
closure owns anything, and the drop pass places nothing on any of it.

Two rules were not in the design and are not optional:

- **A lambda may only be written as a call argument.** Its environment is a
  temporary of the enclosing full-expression, which a call is bounded by and a
  binding is not — `const g: LocalFn<F> = (x) => x + n;` leaves `g` holding the
  address of a temporary from a statement that has ended. This is `GF0234`'s
  rule arriving by another route: only a binding can outlive a temporary, so
  only a binding has to be refused. Binding a `LocalFn` *parameter* to a name
  stays legal, and is a different thing — that environment belongs to a caller
  whose frame is live for the whole call.
- **A capture cannot be moved out of** (`GF0238`). The enclosing frame still
  owns the value and still destroys it, and a closure can be called any number
  of times, so the first call would empty it and every later call would move out
  of nothing. `return name` inside a closure is therefore a copy, which is what
  it already is for a by-value parameter and for the same reason (§11.4).

**A closure inside a closure needs nothing added**, and this was refused for one
release on a reason that turned out to be wrong. The intuition was that the
inner environment would have to reach *through* the outer one, chaining an
indirection per level and naming a slot in a frame that is not the one it means.

It does not. The field operand at a closure site is a `Ref` of the captured
binding's place, and a capture's place ends in a `Deref` — so taking its address
hands back the address that *was* dereferenced, which is the original frame's
slot rather than the enclosing environment's. Each level collapses instead of
chaining. A capture three closures deep costs the same two loads as one, and
every level writes to the same storage.

The soundness argument is the borrow argument again, unchanged: the inner
closure cannot escape its call, its call happens inside the outer closure's
body, and the outer closure's frame is alive for the whole of that — so an
environment in the outer frame holding references into the outermost frame is
valid for exactly as long as anything can reach it.

**`this` is captured as an ordinary name**, and deliberately gets no mechanism
of its own. It is already a local of type `Reference<Self>` bound under that
name (REWRITE-PLAN §4.6), so the environment holds a reference to the local
holding the reference — one more indirection than strictly required, and one
fewer shape of capture to keep in agreement. A method call through a captured
receiver still dispatches virtually and `super.m()` inside a closure is still a
direct call to the base, because neither ever looked at anything but the
receiver's own value.

**A `function` expression may not use the enclosing `this`, and this is not a
gap.** JavaScript gives an arrow the enclosing `this` lexically and gives a
`function` expression one from the receiver at the call site. Goblin keeps the
first and cannot keep the second: a `LocalFn` is a code address and an
environment, there is nowhere in it to put a receiver, and no call sequence that
supplies one. So `this` in a `function` expression is not a *different*
receiver — it is one nothing can ever provide, and it is refused (`GF0002`)
rather than quietly given the enclosing one.

Quietly giving it the enclosing one was considered and rejected. It reads as the
friendlier answer, and it is the one that makes the compiler disagree with the
editor: tsc types `this` in a `function` expression by its own rule, so a
program would mean one thing in the IDE and another when built. The lever that
would silence tsc is `noImplicitThis: false`, which does not make `this` the
enclosing receiver — it makes it `any`, so `this.typo` typechecks and every
field access inside the closure stops being checked at all. Buying a spelling
nobody needs with the loss of checking on the object it names is the wrong
trade; an arrow is right there and already means it.

The rule is the compiler's rather than tsc's, and has to be: the `strict` check
in `checker/src/tsconfig.ts` accepts `strictNullChecks` and `noImplicitAny` in
place of `strict`, which does not imply `noImplicitThis`. A project can reach
the lowerer with tsc silent about it.

Two things about the *declared* form, `function (this: Box) { … }`, are worth
recording because both were found by testing rather than by reading. tsc accepts
it — it is a promise about what a caller will supply, and this is the caller
saying it cannot. And TypeScript models a declared `this` as `parameters[0]`
rather than as a field of its own, while tsc's *signature* excludes it, so the
arity check compared a signature without it against an AST with it and reported
a user error as a compiler gap.

Capture analysis asks tsc which declaration a name refers to, rather than
collecting the names declared inside the closure and treating the rest as
captures. The flat version is wrong in one shape and silently:

```ts
(x) => { total += x; { const total = 0; } }
```

`total` is captured *and* shadowed, in a nested block, so a flat name set drops
a real capture and the write above disappears.

Verified against the C++ oracle, which is the arbiter here because a
non-escaping closure is exactly `[&]` on a template parameter — `std::function`
is not the comparison, since it type-erases onto the heap. Four cases, and the
three that matter are the writes: assigning a `string` *through* a capture
releases the enclosing frame's old buffer on schedule; a captured `this` whose
object has an owning field neither copies the object nor allocates a second
buffer; and a nested closure reassigning a capture two levels up releases that
buffer once, from the frame that owns it. A capture that copied would still
balance, around the wrong object.

### What `LocalFn` buys, stated exactly

It removes the allocation. It does not remove the call.

`xs.map(x => x * 2)` through a `LocalFn` parameter is an indirect call through a
fat pointer, once per element, and it stays one until the callee is specialised
per closure type. That is §11.7 (monomorphisation) plus an inliner, and the
inliner arrives with §17 — Cranelift does no interprocedural inlining, LLVM
does. Three separate things, and this section is only the first.

Worth keeping the claims apart, because the second one is the one a space
simulation's inner loops actually need, and it is not what this section
delivers.

### `HeapFn<F>` captures by move, and that needs nothing new

The environment is on the heap so that it can outlive the frame. That single
fact settles capture mode: a reference into a frame that is gone is a dangling
pointer, and there is no region system here to check one — `GF0234` is a rule
about a single full-expression, not a lifetime.

So a `HeapFn` captures by value: trivial captures are copied into the
environment, owning captures are **moved** into it. The environment is an owning
aggregate, the closure is category `Owning`, and drop glue destroys the
environment. Copy and move are already separate IR nodes chosen by the frontend,
so none of this is new machinery.

The contention diagnostic is not new either. `GF0235` ("a moved-from value was
read") already fires, and is already deliberately not flow-sensitive — a move is
seen for the rest of the function — so both failing cases report themselves:

```ts
const cb1 = () => use(buf);   // buf moved into cb1's environment
const cb2 = () => use(buf);   // GF0235 — already moved
print(buf.length);            // GF0235 — already moved
```

**A `HeapFn` cannot capture a borrow.** Moving a `Reference<T>` or a
`Pointer<T>` into an environment moves the address, not what it addresses, so
the capture outlives its referent exactly as often as the closure outlives the
frame. This is a rule rather than a gap, and it is needed the day `HeapFn` lands
— before `RefCount<T>` is anywhere near.

### The design that was probed and rejected: boxing captured locals

The alternative to move-capture is what Swift, C# and every Scheme actually do:
a local captured by an escaping closure stops being a stack slot and becomes a
heap cell, and *everything* — the closure and the enclosing frame alike — holds
a reference to that cell. It is sound, it needs no lifetimes, and it reproduces
TypeScript's own semantics, where two closures over the same `let` see each
other's writes.

It was rejected on cost, and the cost is the kind this project refuses
specifically:

- **The pessimisation is invisible at the site that causes it.** Boxing is
  per-variable, not per-closure. One escaping closure over `n` boxes `n` for the
  whole enclosing function, including a hot loop that never mentions the
  closure.
- **It requires reference counting to exist, unconditionally.** Two closures
  over one variable, or a frame that outlives the closure, mean the cell has no
  single owner. There is no refcount anywhere in the value model today, and
  introducing one as an implementation detail of closures puts shared ownership
  into the language without anybody writing it down.

Move-capture inverts both: the common case costs nothing, and the case that
needs sharing says so.

### `RefCount<T>` is the opt-in, and it is its own feature

When a capture genuinely has two consumers, the answer is to write it:
`RefCount<T>`, wrapped by the programmer, with `GF0235`'s message extended to
name it as the fix.

This is the right shape because of how rarely it fires. Trivial captures are
copied and never contend; only an owning capture with more than one consumer
does. The marker's cost is proportional to how often it is needed.

It is deferred, and deliberately not treated as part of closures, because it is
`Rc<T>` and it forces four decisions that have nothing to do with closures:

- **Copy is a refcount bump**, which is a third copy behaviour alongside trivial
  and owning. Whether that is a new `Category` or an `Owning` type with special
  copy glue is the real question, and it touches the most existing code.
- **Cycles leak**, and there is no `Weak<T>` in the answer. What makes shipping
  without one tolerable here and not in C++ is the harness: the live-allocation
  check runs on every `run` test, so a cycle fails the suite rather than leaking
  quietly. `Weak<T>` waits until a test catches one.
- **Reading the `T` needs an explicit accessor**, because TypeScript cannot
  overload dereference, and what comes back is `Reference<T>`-shaped. That opens
  a hole `GF0234` does not cover — a reference outliving the last `RefCount` that
  kept the cell alive — and therefore a new rule and a new code.
- **Aliased mutation is unchecked.** Two closures sharing a
  `RefCount<Counter>` both mutate it, with no `RefCell` and no borrow checker to
  arbitrate. That is consistent with not being Rust, and it is recorded here so
  it is a decision rather than a discovery.

### The order this lands in

Three independent pieces, shipped apart, each useful without the next:

1. **`LocalFn<F>`** — borrow category, no ownership question at all. Covers
   every stdlib iterator, which is what this was started for. *Built
   2026-08-19.*
2. **`HeapFn<F>` with move-capture only** — reuses `GF0235` as it stands, adds
   no value-model machinery. Covers single-owner callbacks.
3. **`RefCount<T>`** — on its own merits, when something needs sharing.

One thing to avoid at step 2: do not put "wrap it in `RefCount<T>`" into the
diagnostic before `RefCount<T>` exists. A message naming a type that cannot be
written is worse than the plain move error.

---

## §19 — `alloc<T>({ … })`, the struct initialiser *(settled and built, 2026-08-20)*

A C create-info struct is mostly nesting and mostly zero.
`SDL_GPUGraphicsPipelineCreateInfo` reaches three levels down to
`depth_stencil_state.back_stencil_state.fail_op`, and a caller sets a handful of
leaves. The only spelling the language had for that was `alloc<T>()` followed by
a page of `p.a.b.c = …`, one statement per leaf, with the pointer named again on
every line.

`alloc<T>({ … })` is that page, written as one expression. It is **sugar and
nothing else**: `#allocInit` calls the same `#allocDefault` that was already
there, then emits one `Assign` per named leaf — the statement `p.a.b.c = v`
already produced. No MIR node was added, the wire format did not move, and
`crates/goblin-codegen` did not change.

### One level of `Partial` is useless here, and that is the whole design

The first attempt was `{ ...zeroed<T>(), field: v }`, which needs no new type
machinery at all. It does not work, and the reason is structural rather than a
detail: a spread makes the *outer* field set optional and leaves every nested
field required, so overriding one leaf demands its whole level.

```ts
const p: Pipeline = { ...zeroed<Pipeline>(), depth_stencil: { back: { fail_op: Keep } } };
//                                                            ^ TS2741: 'pass_op' is missing
```

Each level you reach into needs its own spread. `DeepPartial<T>` removes all of
them, which is the only reason it is worth the mapped type — the prelude had
none before this and the bar for the first one is high.

### The four bails are the type, and each closes a real hole

`type-fest`'s `PartialDeep` was the obvious thing to reach for and cannot be
used, for a reason that is not about its quality: it is written against
`Map`, `Set`, `ReadonlyMap`, `ReadonlySet`, `Array`, `Required`, `Parameters`,
`ReturnType`, `Date` and `RegExp`, and under `noLib: true` with `types: []` and
`typeRoots: []` **none of those names exist**. A user project's typecheck loads
nothing ambient except what the compiler writes out, so the dependency could
only ever be a vendored copy, and the parts worth vendoring are the parts that
handle types this language does not have.

What is worth taking from it is the shape of the answer: bail out of the
recursion on anything that must be supplied whole. Four bails do it here, and
each one was verified against the real prelude rather than reasoned about.

* **Primitives.** `i32` is `number & __GfWidth<"i32">`, and an intersection
  carrying an interface *does* satisfy `extends object` — so without this bail
  every scalar field takes the object branch. It happens to survive anyway,
  because a homomorphic mapped type over a primitive returns the primitive
  unchanged, but resting a language's initialiser syntax on that is not a plan.
* **Functions.** A C struct of callbacks holds `feed: () => void` as an ordinary
  field. `keyof` a function type is `never`, so mapping over one gives `{}` —
  which accepts anything at all, including `{}`. This is the bail that a naive
  definition silently loses.
* **Pointers and references.** `Pointer<T>` is `T & CorePointer<T>`. Recursing
  splices the *pointee's* fields into the initialiser, and
  `{ vertex_shader: { fail_op: Keep } }` would pass for an address.
  `FixedArray<T, N>` extends `CorePointer<T>` and is caught by the same bail,
  which is right: it is the bytes, and `fixedArray(…)` is how one is made.
* **Arrays.** `T[]` owns its buffer, and half a buffer is not a thing.

Written `[T] extends [X]` throughout, for the reason `Pointer<T>` is:
a bare conditional distributes over a union and `Reference<T> | null` is one.

The type is deliberately looser than the language — it cannot tell a struct
shape from a dispatched contract, which is the compiler's distinction and not
tsc's. What it admits and the language does not, the frontend refuses by name:
`GF0161` for a class, whose fields sit past a constructor that never ran, and
`GF0304` for a union, whose members share storage so that "the fields you named"
has no answer.

### No `| null`, and the reason is one line of the runtime

The proposal arrived as `alloc<T>(init: DeepPartial<T>): Pointer<T> | null`. It
went in without the `| null`, because `gf_alloc` aborts:

```rust
let raw = unsafe { raw_alloc(size.max(1), align.max(1)) };
if raw.is_null() {
    abort();
}
```

Under `strictNullChecks` the union would put a check at every call site that can
never fire, and it would contradict the `alloc<T>(): Pointer<T>` declared beside
it. Whether allocation failure should be observable at all is a real question
and a much larger one — it reaches `allocArray`, `new`, every string concat —
and it gets answered once, for all of them, not smuggled in on one overload.

### The overloads are ordered, and the order is load-bearing

`alloc(Dog)` and `alloc<T>({ … })` both take one argument. With the initialiser
overload declared first, `Dog` binds as an *initialiser* and `T` infers to the
constructor object: `alloc(Dog)` resolves to `Pointer<{ prototype: Dog }>`
rather than `Pointer<Dog>`, silently. Arity saves `alloc(Rect, 6, 7)` and
nothing saves the zero-argument case. The class overload is declared first, and
`heap.test.ts` pins it.

### `Assign`, not `Init`, and the oracle is why that is checkable

A named field holds a **live zero** by the time the initialiser writes it, so
the write is `Assign` and destroys what was there. For a zeroed `string` that is
`gf_string_free`'s null check — the same well-definedness `alloc<string>()`
followed by `free()` already rested on — so the correct trace has no `free` line
for it, and no second `alloc` from copying a temporary that moves.

Neither claim is observable from output, which is what `alloc_initialiser` in
the C++ oracle is for. It needed `oracle::alloc<T>()` and `oracle::free(p)` in
`trace.hpp`, announced explicitly rather than by overriding the global
`operator new` — which would also catch `Str`'s own buffers and trace every one
of them twice.

### Left for later

A union is refused rather than initialised. One member and the rest zero is
exactly what a union initialiser should mean, and `GF0304`'s own explanation
already hands the reader `zeroed<SDL_Event>()` plus an assignment as the
workaround. Relaxing the rule from "no literal" to "at most one member" is a
small change and a separate one, and it should be made where `GF0304` lives
rather than as a side effect of this.

---

## §20 — `std/io`, and what a standard library is here *(settled and built, 2026-08-22)*

The standard library arrives as **ambient modules**: `declare module "std/io"`
in the prelude, resolving to no file, with `STD_MODULES` in `lower/tables.ts`
mapping each declared name to the `extern "C"` symbol behind it. §15 established
that shape for functions. `std/io` is where it had to carry a *type* as well.

**A `File` is an opaque handle, and the API is C's.** `fileOpen` returns
`Pointer<File> | null`, `fileClose` is `fclose`, and nothing is released by a
scope. That is a deliberate departure from everything else in the language,
where ownership is written down and a binding's scope releases what it holds.
The alternatives are recorded below because each was live, and the reason each
lost is worth keeping.

**A file nobody closes is a *detected* leak, which is what pays for the
handle.** `gf_file_open` allocates through the same allocator every other
allocation goes through, so the live-allocation check counts it — and the
harness's automatic check, which no test opts into, fails the run. A bare
integer descriptor would have been cheaper by one allocation and would have
leaked in silence, which is the trade this project keeps refusing.

### The three designs, and why this one

* **A stdlib written in Goblin**, resolved from a real `.ts` shipped with the
  runtime. It works *today*: a class with a constructor, a static and a method,
  imported from a bare `std/io` specifier, compiles and runs with no compiler
  change at all. It would have given `File` a destructor, so a file would close
  at the end of its scope as a `string` releases its buffer. It remains the
  obvious answer the day a stdlib wants a *value* type, and the defect standing
  in its way is below.
* **An ambient `declare class` with statics and methods**, so that `File.open()`
  is the spelling. The largest of the three, and the only one that invents a
  concept: a class with no layout but with callable members lowered to externs,
  `this` marshalled as a first argument. Nothing in the compiler has a precedent
  for it.
* **Ambient functions over an opaque handle**, which is what is built. No new
  concepts, and the honest consequence is that there is no `File.open()`
  syntax — an ambient class gets no lowered members, so it is `fileOpen(path)`.

### An ambient class is one in a declaration file, not one with `declare`

`ambientClassNameOf` accepts either the modifier or a declaration file, and it
has to accept both: `declare` is illegal on a member of an already-ambient
block, so `class File` inside `declare module "std/io"` carries no such flag and
is no less ambient for it.

The rule that makes this the right test rather than a patch is that the set of
classes this build lays out and the set that erases to a handle must be exact
complements. `collectClasses` skips on two conditions; this accepts on the same
two. A class falling down the gap between them is refused as unsupported while
being perfectly well formed.

### A module outside the project root gets an absolute-path symbol tag

`#relative` falls back to the whole path when a file is not under the root, so
an internal function in a shipped stdlib would be `twice$<hash of C:/Users/…>` —
different on every machine, against the stated goal that the same sources
produce the same symbols in two checkouts. Nothing reaches it today, because
every std module is ambient and has no Goblin source. It is the first thing to
fix if one ever becomes real source.

### The standard streams are not `FILE *`, and that is not an optimisation

`stdout()` and `stderr()` route through the same unbuffered path `console.log`
uses rather than through a C stream. On Windows the CRT opens its descriptors in
text mode and turns every `\n` on the way out into `\r\n` — invisible in a
terminal, and it breaks every test that asserts on exact output. Reading is the
same arrangement in reverse.

The three are `static`, so nothing counts them and `fileClose(stdout())` is a
no-op rather than a way to take `console.log` down three calls later. A function
taking "a file" and closing it when it is done does not have to ask which kind
it was handed.

**End of input is an empty read, and there is no `feof`.** One rule rather than
two: a `feof` would answer for a `FILE *` and have nothing to say about
`stdin()`, which has no such flag to read.

### Seeking, and the 32-bit trap that is not visible from Goblin

`fseek` takes a `long`, and a `long` is **32 bits on Windows**. The obvious
spelling therefore caps every offset at 2 GB on one of the three platforms this
is built for, silently, with no diagnostic at any layer — the Goblin signature
says `isize`, the Rust signature says `i64`, and the truncation happens inside
the C prototype where nothing is looking. Each platform's 64-bit spelling is
used instead: `_fseeki64` on MSVC, `fseeko` elsewhere.

**`Seek`'s values are ours, not C's.** `Seek.Set` is 0 because this language
says so, and `whence_of` maps it to whatever `SEEK_SET` happens to be. A
constant declared in Goblin that has to agree with a C macro is a constant that
will eventually disagree with it, on the one platform nobody built for.

**`fileSize` restores the position, including when it fails.** It is asked by
seeking to the end and back, so a size that also moved the file would be a size
you could not ask for in the middle of reading — and the restore happens on the
error path too, because a failed question must not have an effect.

`Seek` is also the first ambient **enum**, and it folds to its constant at the
use site like any other. An ambient `const enum` does not work: `isolatedModules`
refuses it (`TS2748`).

---

## §21 — `std/math`, and why there are two of everything *(settled and built, 2026-08-22)*

`dsin` takes an `f64` and `fsin` an `f32`. There is no unprefixed `sin`, and
that is not a naming preference — it is what fixed widths cost when they are
taken seriously.

**A single `sin` would have to pick a width for every caller who did not.** Take
an `f64` and every `f32` call is either refused, leaving the programmer to write
the conversion the module was supposed to spare them, or promoted silently —
which is the thing REWRITE-PLAN §7's whole width design exists to prevent, back
again through the standard library's front door. Overloading on the argument
type is the answer a language with implicit conversions gives, and this is not
one: `f32` is not a smaller `f64` here, and `dsin(x)` on an `f32` costs a
widening that ought to be visible at the call.

So the prefix is the choice, written down where it is read. It is C's answer
(`sinf`), with the letter moved to the front so the family sorts together.

### The implementation is Rust's `libm`, and the first reason is a link error

**Nothing adds `-lm` to a Goblin link.** `system_libs` is the user's list, from
their build config. A runtime that called the platform's `sin` would therefore
fail to link on every Linux program that had not thought to ask for a library it
never mentioned — and the failure would be an unresolved external with no file
and no line, about a function the program did call. The alternative is for the
compiler to pass `-lm` on every Unix link forever, which is a permanent tax for
a module most programs do not import.

**The second reason is that the platforms disagree.** The three libms differ in
the last ulp on the transcendentals, and this project asserts on printed output
— so a shared implementation is the difference between one expected string and
three, on a suite whose CI already has a "passes on Windows, fails on Linux"
history. The `libm` crate is a MUSL port and gives the same bits everywhere.

The cost is the obvious one: it is not the platform's hand-tuned version. That
is the right trade for a language whose tests compare output, and it is
reversible — the surface is `gf_dsin`, so what is underneath can change without
a program noticing, exactly as §16 arranged for the allocator.

### Everything is total, and the constants are calls

No function here traps, raises, or returns an error. `dsqrt(-1)` is a NaN,
`dlog(0)` is negative infinity, `dfmod(x, 0)` is a NaN. This is C's behaviour
and the only one available: there is no exception mechanism to raise into and no
error type to return, and a checked variant would double a surface that is
already seventy-two functions.

`disnan` therefore has to exist and is not a convenience: a NaN is not equal to
itself, so `x === dnan()` is always false and there is no other way to ask.

**The constants are functions** — `dpi()`, not `dpi` — because the language has
no top-level `const` to bind one to, ambient or otherwise. They are calls into
the runtime, which is a real if tiny cost, and the alternative is an extern
*data* symbol: new lowering, a relocation, and a second kind of thing a std
module can export. Not worth it for five values per width.

`STD_MODULES` derives the math half of its table from a name list rather than
spelling out seventy-two pairs, because the rule — the symbol is `gf_` and the
name — is the thing that is actually true, and seventy-two hand-written pairs
are seventy-two chances for one to quietly say something else.

---

## §22 — `std/linalg`, and where SIMD enters *(settled 2026-08-23; being built)*

GLM's shape, in a language with no operator overloading and no generics that
survive to the backend: `dvec3`, `fmat4`, `dquat`, spelled `Ttype` where `T` is
the element — `d` `f` `i` `u` `l` `ul` `b`, with `l` for the C intuition of
`long` rather than for any exact type.

The whole section is about one boundary. **A linear-algebra type's *storage* is
an ordinary struct, and its *arithmetic* is a vector that exists only between a
load and a store.** Everything below follows from refusing to let those two be
the same thing.

### The types are builtins, because an interface cannot be both

`contractOf` rejects an interface that declares both a method and a data member
(`GF0002`): an interface is a *shape* laid out as a struct, or a *contract*
dispatched through an itable, and one that is both would have to be a layout and
a dispatch table at once. A `dvec3` is exactly that mixture — three `f64` fields
and forty methods — so it cannot be a declared interface, and the rule that
stops it is a good rule that should not be weakened for this.

So these are **recognised types**, like `string`, `T[]` and `FixedArray<T, N>`:
`erase()` matches them before the general paths and returns a `struct` built
from a table, not from tsc's property list. The mixing rule never runs, because
nothing ever asks tsc what the shape of a `dvec3` is.

What that buys is that the answer is *already an ordinary struct*. Layout, the C
boundary, `dvec3[]`, `sizeOf`, copies, `alloc<dvec3>()` — none of it learns a
new type. Only the methods need a new path, next to the array and `string`
branches that are already there for the same reason.

Recognition is keyed on **the declaring module**, not on the name. `dvec3` is
this `dvec3` when it came from `"std/linalg"`, for the reason `STD_MODULES` is
keyed by specifier: a flat table of names would match any `.d.ts` the project
happens to include and silently rebind a user's own type.

### The lowerer composes; the backend translates

MIR gains a small set of SIMD *primitives* — load, store, build-from-lanes,
extract, splat, elementwise binary and unary, shuffle, fused multiply-add — and
nothing else. `dot` is not a node. It is a multiply, a shuffle and two adds,
emitted **by the lowerer**, and it reads that way in a MIR dump and again in the
`.ll`.

This is REWRITE-PLAN's rule about ownership applied to arithmetic: the frontend
decides, the backend obeys and selects by lookup. A `SimdOp::Dot` that the
backend expanded would be a second place where the algorithm lives, and the
first time the two disagreed the symptom would be a wrong number rather than a
crash. It also means adding `slerp` is a function in the lowering table and no
backend change at all, which is the property that matters for a surface this
size.

The cost is verbose MIR. That is the correct direction for a compiler whose
`.ll` is kept beside every object precisely so it can be read.

### The vector type carries its true lane count, and that is load-bearing

A `dvec3` is `<3 x double>`, not `<4 x double>` with a lane ignored.

LLVM distinguishes a vector's *store size* from its *alloc size*: `<3 x double>`
occupies 24 bytes when loaded or stored, and rounds to 32 only when something
asks how much stack to reserve. So `store <3 x double>` into a 24-byte struct
writes 24 bytes, and the packed layout a vertex buffer needs survives contact
with the vector unit.

That claim was **measured, not assumed** — a 64-byte buffer filled with `0xFF`,
a `<3 x double>` stored at offset 0, the bytes at 24..27 read back. They are
still `0xFF`, at `-O0` and at `-O2`. It is the kind of fact that is silently
wrong in exactly one direction, so it is written down here with how it was
checked.

### `aligned_` means padded, not over-aligned

`aligned_dvec3` is four lanes and 32 bytes; `dvec3` is three and 24. The prefix
says the value has been padded out to the vector unit's width, and the
difference is real:

```asm
add3:   vmovsd 16(%rdx), %xmm0     ; dvec3   — 24 bytes, packed
        vmovupd (%rdx), %xmm1
        vaddpd (%r8), %xmm1, %xmm1
        vaddsd 16(%r8), %xmm0, %xmm0
        vmovsd %xmm0, 16(%rcx)
        vmovupd %xmm1, (%rcx)

add4:   vmovupd (%rdx), %ymm0      ; aligned_dvec3 — 32 bytes, padded
        vaddpd (%r8), %ymm0, %ymm0
        vmovupd %ymm0, (%rcx)
```

Six instructions against three, and the user picks. Packed for a vertex buffer,
padded for a loop.

It is **not** over-alignment, and the distinction is worth being exact about
because the name invites the other reading. `layout.rs` computes a struct's
alignment as its strictest field's, so `aligned_dvec3` is 8-aligned like any
other struct of `f64`. Every vector access is therefore emitted unaligned
(`align 8`), which on the v3 baseline costs nothing when the address happens to
be aligned anyway and is *correct* when it is not. Adding an `align` to
`StructDef` to get `vmovapd` would buy a rounding error's worth of throughput
and a new way for a heap allocation to be subtly wrong.

### There is no CPU detection, and no instruction-set switch either

`-march=x86-64-v3` is already passed to clang (`llvm/driver.rs`) and to the
runtime's rustc (`runtime/src/build.ts`), so AVX2 and FMA3 are a floor rather
than a question.

More to the point, **nothing in the lowerer chooses between SSE and AVX.** It
emits a lane count and an element width; `<4 x float>` is 128 bits and becomes
`vaddps`, `<4 x double>` is 256 and becomes `vaddpd ymm`. The two paths asked
for in the design conversation turned out to be one path with a multiplication
in it, which is the better answer and was not the expected one.

### No fast-math. FMA is asked for by name

Not a single `fast`, `reassoc` or `contract` flag is emitted. Floating-point
results are IEEE and deterministic, which is what a test suite that asserts on
printed output requires, and what a space simulation wants when a trajectory has
to reproduce.

Fusion is still available, because `llvm.fma.v4f64` selects `vfmadd213pd` on its
own with no flags at all — verified in the same probe. So a contraction happens
where the lowerer *says* it happens, and nowhere else. Loosening this later is a
per-operation decision rather than a module-wide one, which is the reason to
start closed.

There are no approximate variants. `normalize` on `f64` is a real `sqrt` and a
real division; `rsqrtps` and a Newton–Raphson step would be a different function
with a different answer, and it can be added under a name that says so if
benchmarks ever ask for it.

### Lane 3 is masked at the reduction, not maintained as an invariant

An unpadded `dvec3` in a 4-lane register has a fourth lane that means nothing.
The tempting rule is "it is always zero" — and `add`, `sub`, `min` and `max`
would all preserve that. **`div` does not.** Zero divided by zero is a NaN, and
a NaN in the ignored lane propagates into the next `dot` and poisons a result
that has nothing to do with it.

So the invariant is not maintained. Instead the operations that actually collapse
lanes — `dot`, `length`, `any`, `all` — mask the dead lane where they read it.
One extra operation in four places, rather than a blend after every arithmetic
op and a standing obligation that any new operation must remember.

### Integers and booleans get no vector unit

`ivec3.add` is three `add i32`. AVX2's integer support stops short of 64-bit
multiply and of division entirely, so `lvec` and `ulvec` would be part
vectorised and part not — a performance surface with a cliff in it that nothing
in the type says. Doing all of them scalar means one lowering rule, and the
integer vectors are for indices and counts rather than for hot arithmetic
anyway.

`b` exists only as `bvec2/3/4`: there is no `bmat` or `bquat` to want. Comparison
operations produce one, and `any()` / `all()` consume it. One byte per lane, like
every other `boolean`.

### Conventions, fixed by the target rather than by taste

Column-major storage, column vectors, `M * v` — GLM's, and therefore what every
shader and every piece of reference code assumes.

Clip space is **SDL3's GPU API on Vulkan**, which settles the two questions that
otherwise have no defensible default: depth is `[0, 1]` with near at 0, and `+Y`
is up in NDC as it is in world space. So `perspective` does *not* emit the Y flip
that a Vulkan-native projection matrix carries. Viewport coordinates run from
`[0, 0]` at lower-left to `[1, 1]` at upper-right.

None of that is a preference this compiler is entitled to. It is written down
because a projection matrix that disagrees with its consumer produces a black
screen and no diagnostic whatsoever.

### A matrix is columns of a vector type

`dmat3` is a struct of three `dvec3`. Not nine `f64`, and not a `FixedArray` of
them — the *column vector type*, whatever that type already is.

This is the decision that made matrices cheap, and every consequence of it is
one that would otherwise have been work:

- **Layout is free.** Nested aggregates are inline, so a `dmat3` is 72 bytes and
  a `dmat4` is 128, which is what a graphics API expects, and nothing new lays
  anything out.
- **A column is a field projection.** `m.c0` and `m[0]` are the projection the
  compiler already had; no stride, no index, no bounds question.
- **Five operations came for free.** `add`, `sub`, `scale`, `negate` and
  `equals` on a matrix are the vector operations of the same name, once per
  column. They carry the same `kind` in the table and reach the same arms of the
  lowerer. Only `mul`, `mulVec`, `transpose`, `determinant` and `inverse` are
  new.
- **`aligned_` composes.** An `aligned_dmat3` is three `aligned_dvec3`, so
  padding is a property of the column type and the matrix inherits it without
  knowing what it is.

**Column-major is what makes `M * v` the cheap one.** The result is a linear
combination of the matrix's *columns*, weighted by the vector's components — so
it is one multiply and `order - 1` fused multiply-adds over whole vectors, with
nothing transposed and no horizontal add anywhere. Row-major would need a dot
product per row: the same arithmetic with a lane reduction in the middle of it.
`A.mul(B)` is then the same routine run once per column of `B`.

`A.mul(B)` means `A * B`, so **`B` is applied first** and the receiver is the
outer transform. That is GLM's convention and it is the one thing here a test
asserts by building the same transform both ways round, because getting it
backwards yields a matrix rather than an error.

### `determinant` and `inverse` are cofactor expansion, deliberately

Memoised on the sub-determinant, generic over the order, and not fast. A 4x4
inverse is a few hundred instructions.

The alternative is the hand-written closed form per order — three unrelated
pages of arithmetic, each correct or not in a way no reviewer can check by
reading. This is arithmetic where being *checkably* right matters more than
being quick: a wrong inverse is a plausible matrix, and it is plausible all the
way to the screen. The memo table is what keeps the naive expansion from
recomputing the same 2x2 minor thirty times; sixteen 4x4 cofactors share nine of
them.

The suite checks it the only way worth checking: `M * M⁻¹` against the identity,
for a matrix with no special structure. Diagonal matrices invert correctly under
several wrong implementations.

A singular matrix divides by zero and produces infinities, like every other
total operation in this language (§21). There is no error to return.

### A quaternion is four lanes and one different operation

`dquat` shares four fifths of its arithmetic with `dvec4` and reaches the same
arms of the lowerer for it: `add`, `sub`, `scale`, `negate`, `dot`, `length`,
`lengthSq`, `normalize` and `equals` are the same operations on the same four
numbers. Only seven kinds divert, and the routing is written as a set of those
seven rather than as "quaternions go elsewhere", so the sharing is enforced
rather than described.

**It is a separate type because of `mul`.** An elementwise product of two
rotations is not a rotation, and a `dvec4` that carried a `slerp` would let any
four numbers claim to be one. That is the whole argument; everything else about
a quaternion would have been fine as a vector.

Two things it does that are easy to get wrong and produce a *rotation* rather
than an error, so both are asserted by applying them to a known vector:

- **`slerp` takes the short way round.** `q` and `-q` are the same rotation, so
  an interpolation that ignores the sign of the dot product travels the long way
  half the time — a three-hundred-degree spin where a sixty-degree one was
  meant, depending on how the endpoints happened to be built. The sign flip is a
  select on a splat, not a branch.
- **It is normalised-linear, not the `sin` form.** True slerp divides by
  `sin(theta)`, which goes to zero for nearly-parallel inputs and is the usual
  source of a NaN here. This form has no such pole; the cost is a
  non-uniform-velocity along the arc that nothing has ever noticed.

`rotateVec` is the two-cross-product identity rather than a matrix build: fewer
operations, and no dependency on the matrix types.

### Integers and booleans get no vector unit, and a smaller surface

Restating §22's rule with what it turned out to cost: AVX2 has no 64-bit
integer multiply and no integer division, so a vectorised `lvec` would be part
vectorised and part not — a cliff nothing in the type admits to. All of them are
scalar, which is one lowering rule.

The **surface is smaller, deliberately**. No `length`, `normalize`, `distance`
or `lerp` on an integer vector: each is a question about a square root or a
fractional part, and an integer answer to either is a different type wearing
this one's name. `dot` and `lengthSq` *are* there, because both are exact in
integers and both are what an integer vector is usually for. `negate` and `abs`
exist only where the element is signed.

`min` and `max` are the one place integers cost more than floats. There is no
integer `llvm.minnum`, so each is a compare and a select — which is why the MIR
grew `Rvalue::Select`. It is deliberately not the conditional operator: that
short-circuits, which makes it control flow, and this is the case where both
arms have already been computed and a branch per component would cost more than
the operation it skipped.

### A comparison produces a `bvec`, never a mask

`a.lessThan(b)` is a struct of one-byte booleans, and `any`/`all` reduce it.

**No masks anywhere in the MIR**, which is the same decision as §22's original
one about lane 3: a mask would be a second representation of a boolean, live
only inside vector expressions, and need a conversion at every boundary. So a
comparison is one scalar compare per component whatever the element is, and the
float and integer paths are one path.

The cost is that `dvec4.lessThan` is four `fcmp` rather than one `cmppd`. That
is a real cost and a visible place to optimise later; it buys a boolean vector
that is an ordinary value — storable in a struct, passable to a function,
printable — rather than a register-only thing.

**`equalTo` is not `equals`.** `equals` asks one question about the whole vector
and answers `boolean`; `equalTo` asks it per component and answers a `bvec`. GLM
calls the second one `equal`, one letter from the first — near enough to be a
typo that compiles and returns the wrong shape, so the name here is deliberately
further away.

### Indexing is a literal, and it is a field

`m[0]` is `m.c0` and `v[1]` is `v.y` — the spelling a shader uses, lowered to
the field projection it already was.

**A computed index is refused**, with a message that says to name the component.
Two reasons, and the second is the real one: the components are fields rather
than elements at a stride, and for a padded type they are not even evenly spaced
— an `aligned_dvec3`'s three components live in four lanes. A `v[i]` would need
either a bounds check this language does not have for struct fields or a stride
that is a lie for half the types in the module.

The declared index signature is therefore *wider* than what compiles. That is
deliberate: tsc accepting `v[i]` and the compiler refusing it with a caret and a
suggestion is a better failure than tsc rejecting it with a structural-typing
message about an index signature that does not exist.

### The module is `std/linalg`

Not `std/vector`, which was the first name and collided immediately: `T[]` is
already "the language's `std::vector`", says so in its own test file, and a
`std/vector` that contained no growable arrays would be a permanent small
confusion.

### Three spellings, and the mutating one chains

`dvec3.add(a, b)` returns a copy; `a.add(b)` returns a copy; `a.addMut(b)`
mutates in place. The static form exists for every operation taking at least one
vector, the mutating form only for operations returning the receiver's own type
— there is no `dotMut` to want.

`addMut` returns `Reference<dvec3>`, so mutations chain. This is deliberately
*not* enforced against aliasing or lifetime: a reference into a local is already
a thing this language lets you hold, with rules that live elsewhere, and a
value type of three doubles is not where that argument should be relitigated.

### The declaration surface is generated

Thirty-odd types times forty operations times up to three spellings is several
thousand lines of `global.d.ts`, and the same list has to appear again as the
lowering table. Written twice by hand, they drift, and the failure is `GF0001`
under a name the user can see in their editor's completion list.

So one table generates both, the way `mir.generated.ts` is generated from the
Rust MIR — for the reason given there, which is that a hand-maintained second
copy of a wire format is worse than no second copy.

---

## §23 — Recursive types *(settled and built, 2026-08-26)*

`struct Node { struct Node *next; }` is the first shape in every C data
structures book, and it used to end the compiler: the eraser walked the pointee
graph with no memory of where it had been and died of stack exhaustion, in a
`RangeError` naming tsc's internals rather than the declaration. The lowerer
would have done the same one layer down, having interned the struct's fields
before the struct.

### A machine type is a graph, not a tree

The type has no finite spelling as a tree, so `erase()` does not build one. An
aggregate is registered *before* its own fields are erased, and a cycle back to
it closes on that object — `MachineType` may therefore contain itself, always
below a `pointer`, a `reference` or an `array`.

The alternative was a truncated placeholder — a `struct` carrying its name and
no fields, resolved by name later. It was rejected because the truncation is
*visible*: `node.next.value` reads a field off the pointee's type, so every
consumer would have to know to re-resolve one, and the one that forgot would
reject a legal program rather than crash. Nothing has to know about the graph,
because everything that walks a type already stops at a struct's name — it is
nominal, which was decided long before this for other reasons (`sameType`,
`renderType`, `needsDrop`, and interning in the lowerer are the four).

The rule that keeps it true: **nothing may walk a type through a `pointee` into
its fields.** There is no reason to want to — a pointer is one machine word
whatever is behind it — and it is the only way to make the graph a hazard.

### The MIR interns a struct in two phases

`declareStruct` then `defineStruct`, like a class, because a recursive struct's
field types are interned *through* the struct they belong to. A class needed the
same thing for a different reason and got it first; the comment in `#structTy`
claiming the id was already reserved was aspirational, and this is what makes it
true.

The wrinkle a class does not have: a struct's **category** is a function of its
fields, so a `Struct` type interned in that window is `Trivial` whatever the
struct turns out to own. `defineStruct` recomputes the whole type table's
categories rather than only the struct's own, because a type interned in the
window can have read the stale answer — `Pointer<FixedArray<Node, 4>>` as a
field of `Node` is the shape that does it.

### Two cycles are refused, and they are refused differently

| Written | Answer |
|---|---|
| `self: Node` | `GF0307` — a value as large as itself and then larger |
| `kids: Node[]` | `GF0001` — a gap, not a rule |
| `next: Pointer<Node>` | a shape |

The distinction is *what was crossed* on the way round, which is why the eraser
counts indirections rather than setting a flag: a sibling field erased after a
pointer field must not inherit its answer.

`Node[]` inside `Node` deserves the second look. The layout is fine — a handle
is one machine word, which is why C++ allows `std::vector<T>` inside `T` and
refuses `T[4]` — and the erasure treats it as an ordinary indirection. What is
missing is out-of-line copy and drop glue: the backend writes both *inline*, so
the drop for a `Node[]` contains the drop for a `Node`, which contains the drop
for a `Node[]`. That is unbounded code generation rather than a stack overflow
in the frontend, and it is a missing feature, so it is `GF0001` and the message
says what to write instead. A `class` already works, because its destructor is a
function rather than something spliced in at each site.

### A class is asked the same question somewhere else

`erase()` cannot answer it for a class, and that is not an oversight: a class is
nominal, so erasure gives back its *name* and never looks at its fields — which
is precisely what stopped `Pointer<Node>` inside `Node` from recursing there in
the first place. So `class Node { self: Node }` never reached the eraser's check
and went on crashing the backend's layout pass, which is the same defect wearing
a different hat.

The flattened fields are known in the lowerer, so that is where the walk lives
(`#refuseInlineCycles`). It follows *inline* storage only — class fields, struct
fields, fixed-array elements — and stops at every handle, which is what makes it
terminate over a struct that reaches itself through a pointer. `GF0307` again,
because it is the same rule.

### C's header has C's rule

A `typedef` name is not in scope until its own declarator is finished, so
`typedef struct Node { Node *next; } Node;` does not compile. The generator
emits `typedef struct Node Node;` ahead of the definitions for exactly the
structs a cycle reaches, and writes those as a plain `struct Node { … };`. Every
other struct keeps the single-declaration form it had, which is what keeps the
diff to the headers this change is actually about.

---

## §25 — A generic crosses a Goblin boundary as source *(settled and built, 2026-08-28)*

GENERICS-PLAN §6, and it is worth reading that section against this one: of the
three things it said the boundary would need, **two were wrong**, and the
mechanism itself needed no code at all.

### What crosses, and how

A generic has no symbol, so it is not something a linker can hand over. Its
body travels with the library and is compiled into whoever uses it — C++'s
header-only template, Rust's rlib, and `std::vector<T>` cannot be used from C
for the same reason.

**That mechanism already existed.** DECISIONS §11.8 decided a Goblin module is
TypeScript source and tsc resolves the imports, so a generic imported from a
library is compiled in the consumer's own compilation like any other file.
There is no interface format, nothing to serialise, and nothing to keep in step
by hand — which was §11.8's whole argument, arriving again.

So a Goblin library has two published halves, and only one of them is a
linker's business:

| Half | Crosses as | Consumer |
|---|---|---|
| non-generic | a symbol, through the C ABI and the header | C or Goblin |
| generic | source, instantiated locally | Goblin only |

The two correctness properties that have to hold across that seam both do, and
are tested: **the layouts agree**, because a layout is a function of the field
types and nothing else; and **the heap agrees**, because a `static-lib`'s
objects go into the executable and the consumer supplies the runtime once.

### Instantiations are not folded, and should not be

§6 assumed the two sides' copies of `first<i32>` would have to fold into one,
and that this needed a symbol stable across compilations plus a vague linkage
the MIR does not have. Neither is true.

They **do not collide**. An instantiation is `Internal`, so the library's copy
is not a symbol the consumer could reach even if it wanted to. What happens is
duplication, and duplication is correct.

The argument that made folding look *required* was that a generic class would
otherwise get two vtables and a dynamic cast would answer no across the
boundary. Measured, it does not: a value has exactly **one** vtable — its
maker's — and travels with it, and the itab lookup is keyed by a *hash of the
interface's name* rather than by the address of a table. A library-made object
answers a consumer's `tryCast` for an interface the library never converted to.
That is the same arrangement that makes a C++ `dynamic_cast` work across a
shared object, and it means there is no identity to reconcile.

So folding would be a **size** optimisation, and it is one this compiler should
not take. Making it work needs a symbol both compilations agree on, which needs
a package identity — a name *and a version* — that the compiler has no notion
of. Without the version, two builds compiling different versions of the same
generic would fold under one symbol and one of them would silently win: C++'s
ODR violation, undetectable, and exactly the class of failure the whole design
is arranged to prevent. Rust folds safely only because it hashes the crate
version into the symbol.

Duplication costs bytes. Folding, done with the identity available here, costs
correctness. The trade is not close.

### What it did turn up

Testing the boundary found four real defects, none of them the ones §6
predicted:

- **A generic's name did not carry its type arguments.** A library exporting
  `sumI32(p: Pair<i32>)` and `sumU8(p: Pair<u8>)` published a header with two
  `typedef struct Pair`, different bodies, and both signatures naming whichever
  came first — invalid C that nothing reported. A generic aggregate now names
  itself `Pair<i32>`, as a generic class already did, and the header spells
  those `Pair_i32_` and `Pair_u8_`.
- **Two genuinely different types could still cross under one C name** —
  `GF0308` now, because C has no way to say "the other `Pair`" and renaming one
  is the only fix.
- **`alloc(Box, n)` could not name a generic class's instantiation.** It
  resolved the class from the identifier's text, where the instantiation is in
  the call's own type.
- **Asking what class an expression is did not make one.** A
  `Pointer<Box<i32>>` reified out of an erased pointer could be the first
  mention of `Box<i32>` anywhere, and the method-call path found no class.

### Still open

Nothing guards a consumer that links archive *vN* and imports source *vN+1*.
The layouts would disagree and nothing would say so. Detecting it needs the
archive to carry a stamp the consumer reads at compile time, which is a
publishing format this compiler does not have and §11.8 deliberately did not
build. It is a packaging question rather than a compiler one for as long as the
consumer imports the library's own source — which is what a path or a
`node_modules` entry gives — because then there is only ever one version.

---

## §24 — `Reference<T>` is an address *(settled and built, 2026-08-28)*

The question that started this was whether `Reference<T>` is C++ baggage:
`const StructA&` carried over out of habit, where `Pointer<T>` would do. The
answer is no, but the reason is not the one the C++ habit suggests.

### What the C ABI says about references: nothing

C has no references. Neither, at the ABI level, does C++ — both the Itanium and
the MSVC ABI specify `T&` as identical to `T*`: one register, one address, no
header. A reference is a frontend fiction in C++ too.

This compiler already agreed. `layout.rs` puts `TyKind::Reference` in the same
arm as `Pointer`, `FnPtr`, `Str` and `Array` — `Repr::Register(Scalar::Ptr)` —
and the emitted IR is unambiguous:

```llvm
define internal double @byValueBig(ptr %arg0)      ; Big (24 bytes) by value
define internal i32    @byValueSmall(ptr %arg0)    ; Small (8 bytes) by value
define internal double @byPointerBig(ptr %arg0)    ; Pointer<Big>
define internal i32    @Holder$get(ptr %arg0)      ; this, a Reference
```

All four are `ptr`. At the internal ABI every aggregate travels by address
already, so by-value versus by-reference is not an ABI distinction here any more
than it is on Win64, where LLVM-PORT.md's own table shows a 24-byte struct by
value becoming `ptr dead_on_return`.

**So the entire content of `Reference<T>` is: who makes the copy.** By value the
caller copies, and the callee owns that copy and drops it. By reference there is
no copy and nothing to drop. For a `Point` that is a `memcpy` against nothing;
for a struct with a `string` field it is a heap clone and free against nothing.

### Why it stays anyway

**There is no address-of operator.** `alloc<T>()` is the only source of a
`Pointer<T>`, so without `Reference<T>` a stack value cannot be passed by
address at all — the alternative is heap-allocating to avoid a copy, which is
not a trade anybody should be asked to make. That is decisive on its own.

It also carries the rule the whole design rests on. `f(p: Point)` says "I take a
copy" and `f(p: Reference<Point>)` says "I borrow", at the signature, where the
reader is. That is ownership written down.

### What was wrong with it, and is now fixed

`Reference<S>` for a plain struct was `GF0001`, which is exactly the
`const StructA&` case. It works now, and so does writing through one — a
reference has no `const` half, and `this` has always been one.

`Reference<T>` over a **type parameter** did not work at the *tsc* level, one
level above anything this compiler could reach. The prelude spelled it as a
conditional type, tsc will not resolve a conditional over an unresolved `T`, and
member access against the two retained branches finds nothing. It is a plain
intersection now:

```ts
type Reference<T> = T & ReferenceCore<T>;
```

`Pointer<T>` **keeps** its conditional, and the asymmetry is the point:
`Pointer<i32>` must not be `i32 & CorePointer<i32>`, because an intersection
containing `i32` is an `i32` to tsc and pointer arithmetic would type-check. A
reference has no arithmetic, so it has nothing to protect against.

That one line unblocked calling a method on a constrained `T`, which was
GENERICS-PLAN stage 5's blocker — but it was not the whole of it. Two more
places asked tsc directly and got tsc's un-substituted answer:

- `classNameAt` found no class for a `Reference<T>`, so the method-call path
  decided it was not a method, and `x.speak()` lowered to nothing and returned
  zero. It consults the erasure first now, which is the only answer with the
  substitution in it.
- `contractAt` read `T`'s **constraint**, so `T extends Speaker` looked exactly
  like a `Speaker` and dispatched dynamically against an itable that was never
  built. Also zero. Under monomorphisation a constrained `T` is never
  dynamically dispatched: the instantiation bound it to a concrete type and the
  call is direct.

Both produced a wrong answer rather than an error, which is the worse failure,
and neither was visible from the prelude change alone.

### Two rules that came out of finishing it

**A reference is only worth having to something a copy costs something.** A
scalar, a `boolean`, a `Pointer<T>`, a function pointer and a `CString` are one
register copied by moving it, so a reference to one is an extra load bought with
nothing — `GF0002`, naming `Pointer<T>` as the out-parameter spelling, which is
what C uses for the same job. A `Reference<string>` is the opposite case and is
`GF0001`: copying a `string` clones its buffer, so borrowing one is worth doing
and simply is not lowered.

**A reference crosses the C boundary as `T *`, so `T` is what gets checked.**
An owning struct sailed across behind one — `Reference<Held>` accepted where a
plain `Held` was refused — and the reference is not what made the difference.
`Pointer<T>` deliberately does *not* get this treatment: it is the escape hatch,
an address and nothing more, whose job is to carry what this compiler will not
vouch for.

### Left open: one spelling, two representations

`Reference<Circle>` is one word. `Reference<Shape>` for a contract is two — the
`(itab, data)` pair. Same spelling, different size. Rust splits these as `&T`
and `&dyn Trait`, and makes you write the `dyn`.

Whether to split them here is **not decided**. The case for splitting is that
the size of a parameter should be visible in its type and that dispatch should
be visible at the signature. The case against is that it is a rename across the
test suite, the prelude and §11.2 for a wart nobody has been bitten by. Recorded
rather than resolved, so that it is a choice next time somebody looks rather
than something nobody noticed.

---

## §11.7 — Generics: monomorphisation *(settled 2026-08-28; functions built)*

**Answer: monomorphisation, in the frontend, before any MIR is built.** One
copy per set of type arguments a generic is *used* with; the copies share
nothing but a source declaration; by the time the MIR exists there are no type
parameters in the program.

[`GENERICS-PLAN.md`](GENERICS-PLAN.md) is the argument and the order of work,
and it is not repeated here. The short form of why the alternative was not
available: uniform representation needs out-of-line copy and drop glue, which
`packages/checker/src/types.ts:329` already names as a missing feature when it
refuses a `T[]` inside `T`. Uniform representation would have to build that
first and then witness tables on top of it. Monomorphisation needs neither, and
leaves the drop pass, the layout rules and the C boundary exactly as they were.

The 2026-08-11 note below — that §11.7 "did not need answering yet" — was
right at the time and stayed right for two and a half months. What changed is
nothing about the compiler: user-written generic code started to matter.

### Three things worth carrying forward

**tsc checks a generic at its declaration, not at its instantiation.** So
Goblin's generics are Rust-shaped rather than C++-shaped, and this compiler
does not enforce that — tsc does, before it is called, with a `TS####` that
underlines in the editor. It also means a body cannot be re-checked per
instantiation, and does not want to be.

**But instantiation can still fail**, because erasure is a Goblin rule tsc
knows nothing about. So every diagnostic raised while lowering an instantiation
carries a note saying which call asked for it — C++'s "required from here".
That is not a nicety: without it the error points inside a generic the reader
may never have opened.

**A generic has no symbol**, so it is not something a linker can hand over. A
Goblin library's generics travel as *source* and are instantiated in whoever
uses them, the way a C++ template travels in a header — Goblin to Goblin only,
exactly as `std::vector<T>` cannot cross into C. GENERICS-PLAN §6 is that
design, including the two things it is not free in: an instantiation needs a
symbol both compilations agree on, and a vague linkage the MIR does not have.

### A generic method has no slot, and cannot have one

A vtable slot holds one function; a generic method is as many functions as it
has sets of type arguments, and there is no answer to which one goes in. C++
forbids `virtual` on a member template for exactly this reason, and the
consequence here is the same: a generic method is resolved **statically**, so
it neither overrides nor is overridden, and it is inherited by name the way a
`static` is rather than through a slot.

It is otherwise an ordinary instantiation — keyed by the *class* as well as the
method, because `Box<i32>.paired<u8>` and `Box<f64>.paired<u8>` are different
functions, and lowered under the class's substitution and the method's
**together**, because the body may mention both.

### A class's substitution belongs to the class

Not to whoever is asking. A member's types have to be erased under it wherever
the question comes from, and the question does not always come from inside:
`b.held` in some other function asks what a `Box<i32>`'s getter returns, and
answering under *that* body's substitution erased `T` as unbound.

Methods escaped this because a method's signature is recorded once, at
declaration. An **accessor** is re-erased at each use, which is what made the
difference visible — and the same omission was why `implements Container<T>`
did not work: the heritage clause was erased with no substitution at all.

### Still open under it

Three things, all narrow and all stated where a reader will meet them:

- a generic used as a **base class** — `baseOf` resolves a base by its bare
  name, and an instantiation needs resolving by its erased type arguments;
- a **`static` on a generic class**, because the class name stands for every
  instantiation and TypeScript has no syntax for choosing between them. It
  never needed one — a `static` may not use `T` — which is both why it is
  unimplemented and how to work around it;
- a **conditional type** whose condition mentions a type parameter. That one is
  a limit rather than a gap: the substitution replaces `T` at the leaf with a
  *machine* type, and re-evaluating a conditional needs TypeScript's own types
  put back and the whole thing instantiated, which tsc exports no way to do.

Calling a method on a constrained `T` was open here too and is not any more —
§24 above is what it took, and it was three fixes rather than the one the plan
expected.

`Pointer<T>` over a type parameter is still a conditional type and still does
not survive one, so `p.deref()` inside a generic remains a `TS2322`. Unlike
`Reference`, that conditional is load-bearing (§24), so it wants a different
answer rather than the same one.

---

## §26 — `std/collection`, and a std module that is source *(settled and built, 2026-08-29)*

`HashMap`, `HashSet`, `BinaryHeap` and `RingBuffer`, written in Goblin, shipped
with the runtime and compiled into whoever imports them.

§20 listed "a stdlib written in Goblin" as one of three designs for `std/io`,
noted that it "works *today*", and set it aside because a `File` is a handle and
a handle needs no value semantics. It also said which day would change that:
**the day a std module wants a value type.** A container is that type, and the
reason it could not have been built then is that a container is generic and
generics arrived at §11.7.

### Why not the other two shapes

An **ambient module** cannot carry one. `declare module "std/collection"` gets a
class with no layout, no destructor and no lowered members — `collectClasses`
skips it and `ambientClassNameOf` turns it into an opaque handle. That is
exactly right for a `FILE *` and exactly wrong for a `HashMap<K, V>`, which is a
value whose scope releases every key and value in it.

A **recognised type**, the way `std/linalg`'s `dvec3` is, would mean the
compiler knowing what a hash table is. §22 took that route for linear algebra
because the *arithmetic* has to become SIMD and no source-level spelling
survives to the backend. Nothing about a hash table needs the compiler's help;
it needs generics, which exist.

So the surface is a `paths` entry in the tsconfig base and a directory of `.ts`
beside it. Nothing in the compiler resolves it — **tsc does**, which is what
makes the editor and the compiler agree, the same property `GF0003` exists to
protect. One entry per module rather than `"std/*"`, because a wildcard would
send `std/alloc` at a file that does not exist and lean on tsc falling back to
the ambient declaration, which is a resolution order nobody should have to know.

### The symbol tag §20 predicted, arriving

§20's "first thing to fix if one ever becomes real source" was real: `#relative`
falls back to the whole path for a file outside the project root, so an internal
symbol in a std module would be tagged with a hash of the *absolute* path —
the checkout on one machine, a `node_modules` entry on another, and a cache
directory under the user's home when the packaged CLI extracts it. Three
different symbols for one function.

It is tagged `std/collection.ts` now, which is the specifier a program would
have written. `stdLibrary()` joins `globalDeclarations()` and `runtimeCrate()`
as a shipped path the compiler has to know.

### A key answers two questions, and a class answers them itself

A container needs one spelling for "hash this" and "are these equal" that works
for `i32`, for `string` **and** for a user's struct. There was none: `===`
compares the first two and is `GF0002` on the third, on the stated grounds that
the compiler should not guess which fields matter, and there is no operator
overloading for a class to say otherwise.

`hashOf<T>(v)` and `equalsOf<T>(a, b)` are that spelling. They resolve from the
type at the instantiation:

| `T` | Answer |
|---|---|
| scalar, `boolean`, enum, pointer, `CString` | the bits, mixed |
| `string` | its bytes |
| struct, `FixedArray` | field by field, recursively |
| anything declaring `hash()` / `equals()` | those |
| `Reference<T>` | the referent's, never the address |
| everything else | `GF0405` / `GF0406` |

**The method hook is the whole of the extension mechanism**, and it is where a
class lands — a class has a vtable and slices when copied, so there is no
structural answer that is right for one. It is resolved by *name* at the
instantiation rather than through a contract, which is the same place and the
same way C++ resolves a `std::hash<T>` specialisation, and it costs no vtable
slot. Specialisation proper is not available here and should not be
(GENERICS-PLAN §7: one body per declaration, always).

**A struct is walked, never memcmp'd.** That is not a softening of `GF0002` —
it is `GF0002`'s own advice ("compare the fields you care about") applied by the
compiler, and it is why the padding that made comparing the bytes wrong is never
read.

**A float is not a key** (`GF0407`). `0.0 === -0.0` with different bits, and
`NaN !== NaN`: equal keys would hash to different buckets and a `NaN` key could
never be found again. Rust refuses `Hash` for `f64` for this reason; C++ ships
`std::hash<double>` and inherits both bugs. `equalsOf` *does* accept a float,
because comparing two is well defined — it is only the pairing that is not.

The hash is **deterministic and unseeded**: same value, same number, every run
and every platform. That is what a simulation which has to replay wants and the
opposite of what a public server wants, and it is stated rather than left to be
discovered, because iteration order is a function of it and this suite asserts
on iteration order.

### The table is dense entries plus an index, and that was forced

The textbook open-addressed table stores keys and values in the slots, which
means every *empty* slot holds a valid `K` and `V` — `zeroed<K>()`. `zeroed`
refuses a class, so keys and values would have been restricted to non-class
types across the whole module. Storing entries densely and hashing into a
separate table of indices means no `K` exists until one is inserted.

Two things fall out and both are worth having: iteration costs the number of
entries rather than the capacity, and the entries are in insertion order.
Removal is a swap of the last entry into the hole, so that order holds only
until the first `remove` — documented as such rather than promised, because the
alternative is tombstoned entries holding keys and values nobody can reach.

`HashSet<K>` is a `HashMap<K, boolean>`. One padded byte per entry against a
second copy of the probing, and the probing is the part that has to be right.

### `T[]` grew `capacity` and `reserve`

Not part of the module and the reason it exists: a growth policy should be
something a program can *write*. `push` doubles, which is the right default and
allocates a second buffer beside the first at every step — a 400 MB array of
bodies transiently wants 1.2 GB. `reserve` goes through mimalloc's `realloc`,
so growing in fixed steps can extend the block in place.

It needed **no MIR node**, where `push` needed `ArrayPushSlot`. The difference
is what each has to be told: `push` has to be told where to *put* something,
which is a slot only the backend can compute, and this only has to be told how
big an element is — `SizeOf` and `AlignOf` already answer that for any type. So
it is an ordinary runtime call taking a `Ref` of the handle.

It never shrinks. A shrink is a reallocation that invalidates every pointer into
the array, asked for by a number smaller than the one already there.

`push` was deliberately **not** switched to `realloc`. Its allocation trace is
compared against `std::vector`'s in the oracle, and a vector cannot realloc —
it has to run move constructors — so `push` allocating, copying and freeing is
the behaviour under test rather than an inefficiency.

### Three defects it turned up, none of them in the containers

Building this found three pre-existing bugs, all reachable from ordinary
programs and none of them needing a container to hit:

- **A conditionally-moved local was destroyed twice.** Drop elaboration raises a
  local's drop flag where it is written and lowers it at `StorageLive` /
  `StorageDead`, and never at a **move**. So `xs[0] = move(e)` under an `if`
  moved the value into the array *and* dropped it. Only conditional moves were
  affected — an unconditional one leaves the local uninitialised on every path
  and gets no flag at all — which is why it survived a suite with plenty of
  moves in it. `readsOf` was also missing every rvalue kind past `Aggregate`,
  which is the same bug waiting for a `Select` over an owning type.
- **A `LocalFn` parameter worked only on a free function.** The width pass walks
  a call's arguments, and a lambda has no width of its own; a free function's
  width path never walks its arguments, and `xs.forEach` answered before its
  loop, so those two worked and a method, a generic method, a static and a
  contract's method all reported `GF0239` about the lambda. The feature worked
  in exactly the shape it had a test for.
- **A method named `drop` collided with the generated destructor**, producing
  two definitions of `Class$drop` and a `GF9003` — the compiler calling itself
  broken about a program whose only fault was a common word. The destructor is
  `Class$~drop` now: `~` is not a character a TypeScript identifier can hold,
  which is the trick `linalg.dvec3` and `Pair<i32>` already use. Taking the name
  away from the user would have been the smaller change and the wrong one.

### What it costs, and the gap underneath it

**Taking a value out of a container copies it.** `move(xs[i])` is `GF0001` —
moving out of anything but a local — so `valueAt` copies, `BinaryHeap`'s sift
copies rather than swaps, and `RingBuffer.pop` copies before zeroing the slot.
For a scalar or a POD struct, which is what a simulation's maps and queues hold,
that is a `memcpy` and costs nothing. For a `string` it is an allocation.

`HashMap.remove` is the one place that avoids it, because `pop` *does* move: the
last entry comes out by move and goes back in with `move` on a local.

Closing the gap properly means moving out of an array element, which needs the
element left empty-but-destructible — which is what a move already leaves behind
here ("a moved-from value is empty rather than invalid"), so the obstacle is the
*tracking* rather than the semantics. Recorded rather than done.

### Still open

`std/collection` is one file. A second module under `std/` needs a second
`paths` entry, and nothing checks that the entry, the shipped `files` list and
the CLI's embedded copy agree — the failure would be tsc reporting that a
specifier does not exist, in the packaged compiler only. `packages/cli/build.ts`
enumerates the directory rather than listing it, which closes the worst half.

---

## §27 — `take`, and why it is not `move(xs[i])` *(settled and built, 2026-08-30)*

§26 left "moving out of an array element" as the gap under `std/collection`:
taking a value out of a container copies it, because `move(xs[i])` is refused.
The capability was worth having. The **spelling** was not, and the reason is
worth writing down because the obvious answer is wrong in a way that is quiet.

### `move` promises something an element cannot keep

What `move` gives you is not "the bytes are transferred" — that is the cheap
half. It is that **the source cannot be read afterwards**, and `GF0235` says so
at the site that tries. That promise is kept by tracking the *binding*, which is
a name the compiler can follow.

`xs[i]` is not a name. With a computed `i` there is no analysis that can say
which slot is hollow, and there never will be. So `move(xs[i])` would compile to
a transfer with **no** guarantee attached: `move(xs[0])` followed by
`console.log(xs[0])` would print an empty string, silently, with nothing to
report. DECISIONS §24 already recorded the project's view of that shape — "both
produced a wrong answer rather than an error, which is the worse failure".

Rust reaches the same conclusion and refuses `cannot move out of index`,
offering `mem::take` and `mem::replace` instead. C++ allows `std::move(v[i])`
and leaves a "valid but unspecified" value, which is a footgun with a long
bibliography.

### So the operation keeps a different promise, and keeps it dynamically

`take(p)` hands back the value and **puts the default in its place**. Reading
the slot afterwards is not undefined and not unguarded — it is *specified*: an
empty `string`, a zeroed struct, an empty array. There is no moved-from state to
track because nothing is moved-from; the place holds a real value, and the
container's destructor destroys it harmlessly.

| | source afterwards | kept by |
|---|---|---|
| `move(x)` | unreadable (`GF0235`) | static tracking — a binding only |
| `take(p)` | the default, readable | the write-back — any place |

Two operations rather than one word with two meanings. `move` out of an element
or a field is now `GF0002` naming `take`, where it used to be `GF0001` implying
a gap.

### The write-back is the entire feature

A MIR `Move` transfers bytes and nothing else. The backend nulls a **one-word
handle** as insurance — so `move` out of a `string` element would have been
accidentally safe — but an aggregate's "value" is its address and there is no
word to null, so a struct's bytes stay exactly where they were. For a local that
is safe because drop elaboration removes the drop; for an element of an array
that is still going to be destroyed in full, it is a double free.

`Init(place, Default)` after the read is what makes the slot destroyable again.
`Init` rather than `Assign`, because there is nothing left in the place to
destroy. Drop elaboration needed **no change**: the `Move` carries a projection
so `applyOperand` leaves the array initialised, and the `Init` carries one so
nothing is marked. That the pass needed nothing is the strongest evidence the
shape is right.

`pop` is the existing operation that moves out of an element, and it is safe for
a different reason — it *shortens* the array, so the hollowed slot is outside it.

### What it refuses, and why each one

- **A class.** What would be left is an object whose constructor never ran, which
  is exactly what `zeroed<T>()` refuses to produce. Keeping that rule true in
  both places is worth more than the copies it costs — and it is why
  `BinaryHeap`'s sift still copies rather than being rewritten with `take`:
  trading `BinaryHeap<C>` away for a `memcpy` on the element types least likely
  to be in a heap is the wrong way round.
- **A by-value parameter**, `GF0236`, for `move`'s reason exactly: the caller
  releases the argument, so emptying the callee's separate handle frees one
  buffer twice.
- **A temporary.** There is nowhere to put the default back into, and the value
  is already the statement's own.

A **trivial** type is allowed and is exactly a read — nothing owns anything, so
there is nothing to take and nothing to put back. That matters inside a generic,
where `T` may be either and the call site should not have to know which.

### Two defects it turned up

**A null array handle was not an empty array.** Zeroed bytes are a `T[]` the
language can already hand you — `zeroed<S>()` over a struct with an array field,
the storage between `Default` and a constructor's field initialiser — and they
are null rather than the shared static empty array. `gf_array_len`,
`gf_array_capacity` and `gf_array_free` each null-checked *on their own*, which
made null look supported: it reported length zero, iterated zero times and freed
cleanly. `push` and `reserve` did not, and computed a header sixteen bytes below
null. So `zeroed<S>(); s.xs.push(1)` was an access violation, reachable with no
`take` anywhere near it. `array_bounds` is the one rule now, and it also avoids
forming `null - 16` at all, which is undefined in Rust whether or not it is
dereferenced.

**A program's own name did not win over the prelude's.** The globals are matched
by *text* — `if (name === MOVE)` — which is unremarkable for `nativeCast` and
stops being so the moment one of them is an ordinary English word. A program
with `function take(s: string)` had every call to it intercepted, and the
complaint was about a place to put a default back into: a sentence about a
feature the author had never used. `shadowsPrelude` asks tsc which declaration
the name resolves to, which is exact rather than heuristic — a user file is a
module, so its `function take` shadows the global rather than colliding with it.
This was latent for every intrinsic and is fixed for all of them, which is the
same argument `STD_MODULES` makes for being keyed by specifier before name,
arriving for the globals.

### Still open

`take` on a class stays refused, and if that is ever relaxed it should relax
together with `zeroed<C>()` — they are one rule, not two.

`BinaryHeap`'s sift still copies. A `swap` written with three `take`s costs no
allocation at all, and the only thing standing in the way is the class rule
above.

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

### `export` versus the public ABI *(revised at milestone 10)*

REWRITE-PLAN §3 asks whether `export` means "visible to other Goblin modules" or
"visible to the dynamic linker", and warns that v1 conflates them.

**Milestone 9 answered "the linker" and that was wrong** — or rather, it was the
only answer available while a build was one file, and it stopped being right the
moment a second one existed. `export` is TypeScript's word for *importable*, and
a Goblin program is one compilation, so an exported function that another module
calls is an ordinary internal call. Making it a C boundary would forbid it a
`string` parameter for no reason at all.

The rule now:

| | |
|---|---|
| `export` on any declaration | **importable** by another module in this build. Internal linkage, qualified symbol, no ABI restriction. |
| `export` in the **entry module** | the build's **public ABI**. `Abi::C`, `Linkage::Export`, bare symbol, in the generated header, named in a DLL's `.def` — and limited to plain data. |

One surface per build, which is what a library is. Found by a test that tried to
call a `string`-returning helper across a module boundary and was told it could
not, which was the compiler being wrong rather than the program.

### `CString`: the borrowed half of the string pair *(2026-08-12)*

The user's call, after weighing the alternative of **removing the string header
entirely** so that a `string` would just be a `char *`. That was tempting — it
would have made `.length` a `strlen`, let C `free()` Goblin strings, and deleted
a whole category of boundary friction.

It was rejected for one reason above the others: the header's `owned` flag is
what makes `const a = "hello"` and `const b = x + y` the **same type**. A
literal is static data with `owned = 0`, so releasing it is a no-op; a heap
string has `owned = 1`. Take the flag away and a destructor cannot answer "do I
free this?" — free everything and a literal kills the program, free nothing and
every string leaks and the live-allocation counter stops meaning anything.
Deciding it statically is `&str` versus `String`, which is the *other* design.

So: keep the header, and add the borrowed type instead.

| | `string` | `CString` |
|---|---|---|
| Representation | header behind a nul-terminated pointer | a raw `const char *` |
| `length` | a **load** | a **`strlen` scan** |
| Ownership | tracked; the scope releases it | **not tracked**, ever |
| In a C header | `GoblinString` (a typedef, as a warning) | `const char*` |

Two things this buys, and they are the argument for two types over one:

- **A C signature can say which it means.** A returned `string` is *always* the
  caller's to release — returning an owning value is a move, and there is no way
  for a function to hand one back and keep it. A returned `CString` is the case
  where the signature has stopped talking and a doc comment has to start, which
  is what a C API does anyway.
- **The cost of `length` lives in the type.** Under the header-removal design
  every `.length` in the language would silently have become O(n), and
  `for (i = 0; i < s.length; i++)` O(n²). Here you can see which you have.

### `cstring(s)`, and what `move` means to it

Borrowing is free — a Goblin `string` is already nul-terminated, so this is the
same pointer with a different type. What changes is who is responsible:

```ts
const c: CString = cstring(name);         // borrowed: valid while `name` is
const d: CString = cstring(move(name));   // `name` is dead; the bytes are yours
```

Borrowing a **temporary** is `GF0234` — it dies at the end of the statement and
the borrow could not outlive it by a line. With `move` that check does not fire,
and **should not**: the move makes the source dead, so no destructor runs and
there is nothing to dangle past.

The consequence is a leak in most programs and exactly right in one — handing a
buffer to a C library that will free it. **This language is unsafe on purpose**,
and `move` is how the intent gets written down rather than assumed. The
diagnostic for the temporary case names `move` for that reason: the alternative
should not have to be guessed at.

Releasing such a string is `gf_string_free`, never `free`, because the
allocation starts at the header. The generated C header declares it beside
`gf_string_from_cstr` and `gf_string_clone`.

### A `string` crosses; ownership becomes documentation

The user's call, and the right one: in C a string is a `char *` and who frees it
is something the docs say — SDL is the obvious example, with `SDL_free` and
"this is managed by SDL, do not free" written next to the functions that need
it. Forbidding a `string` at the boundary would make every Goblin library that
deals in text unusable from C for no gain.

The runtime was built for this. A `string` is a pointer to nul-terminated bytes,
so C reads one with `printf` and `strlen` unchanged — `runtime/native/src/lib.rs`
says so in its own header comment, and that was the intent from milestone 5.

**But the boundary is not symmetric, and the assumption that it is was wrong.**
The length header sits *behind* the pointer:

```text
  [ len: u64 ][ owned: u64 ][ bytes … ][ 0 ]
                            ^ the `string` value points here
```

So a plain C literal is **not** a Goblin string. Passing `"hello"` to a
`string` parameter reads a length out of whatever precedes the literal in
`.rdata` — the first test of this printed `0` for its length and `"!"` for
`shout("hello")`, silently, with no crash. And `free` on one is wrong for the
same reason: the allocation starts at the header.

Three things follow, and the header emitter does all three:

- The C spelling is **`typedef const char* GoblinString`**, not `const char *`.
  The compiler cannot stop a C caller passing a literal, so the name is the only
  warning available, and `const char *` would have invited exactly the mistake.
- The header declares `gf_string_from_cstr` (which copies), `gf_string_clone`
  and `gf_string_free` — because "do not use `free`" and "do not pass a literal"
  are advice with no alternative attached unless the alternative is right there.
- A `string` **buried in a struct** stays rejected. A bare one puts the
  ownership question in the signature where a doc comment can answer it; a field
  inside a struct a C caller builds and copies by value has nothing to see and
  nothing to document.

### `GF0301`: what still cannot cross the public boundary

A `T[]` owns a heap buffer whose elements are laid out for this compiler, and
nothing outside the build knows that shape. A **class** carries a vtable pointer
and an **interface reference** a
pair of pointers into this build's own tables — addresses that mean nothing to C
*or to a second Goblin build*, because type descriptors have exactly one owner
per compilation (§11.2).

None of this was checked before: `require_plain_data` ran only for aggregates,
so a one-word `string` handle sailed through as `Slot::Plain`, and it had no
`Class` arm at all. Found by asking what happens when a Goblin executable links
a Goblin shared library — which does work, for plain data.

The check lives in the **frontend**, where there is a node to point at. The
backend's copy stays as defence in depth and deliberately still only inspects
aggregates: the runtime's own `extern "C"` functions take and return `string`
legitimately, because they are the code that knows the ownership rules, and the
backend cannot tell those from a user's export. The frontend can.

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

> **Answered 2026-08-28** — see §11.7 above. The guess held: monomorphisation,
> in the frontend, and the MIR did not change.

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

---

## §28 — C dependencies are built with clang on MSVC *(settled and built, 2026-08-30)*

§15 vendors mimalloc's C source and lets `cc` build it, at whatever level the
program asked for. That produced an allocator which faulted at `O1`, `Os` and
`Oz`, and the answer at the time was to pin `libmimalloc-sys` to `-O2` on the
reading that **mimalloc is broken at `/O1`**.

That reading was wrong, and it is worth recording how it was wrong, because it
was a plausible conclusion from a real experiment. The original measurement —
pin the package to 2 and it works, pin it to 1 and it breaks, with the rest of
the crate at the other level — correctly proved that *this dependency's C build*
was the variable. It did not prove which property of that build, and "the
optimisation level" was the one thing visibly being changed.

### What was actually varying

Holding mimalloc's source and every flag fixed and moving one thing at a time:

| moved | result |
|---|---|
| C against C++ (`build.cpp(true)` on MSVC) | no difference — both fault |
| mimalloc 3.3.2 against 3.5.0 | no difference — both fault, in different functions |
| MSVC 14.38.33130 against 14.43.34808 at `/O1` | **14.38 clean, 14.43 faults** |
| either toolset at `/O2` | clean |
| clang-cl at every level | clean |

So it is a code-generation defect in one MSVC version, not a property of `/O1`
and not anything about mimalloc. Linux never reproduced it at any level, which
the pin had left recorded as an open question rather than an answer.

The failure is unambiguous corruption rather than anything subtle. In a working
build four allocations of four different sizes come back in four pages; in the
broken one they come back at `…30000008`, `…30000040`, `…30000200` and
`…30000000` — overlapping each other, on top of the arena's own metadata — and
the access violation arrives a few allocations later inside mimalloc's own
bitmap search, which is the first code to read a structure that has been
overwritten.

Two details made this expensive to find, and both are worth knowing. `vcvars64.bat`
falls back to an *older* toolset when it cannot find `vswhere.exe`, so a
hand-built repro can silently use a different compiler than `cc` does and
exonerate it. And nothing in `libmimalloc-sys` declares `rerun-if-changed` for
its C sources, so editing them does not rebuild.

### The fix is the compiler, not the level

`packages/runtime/src/build.ts` names `clang-cl` as `CC`/`CXX` for MSVC targets,
and the pin is gone: `optLevel` now reaches the allocator honestly, which is
what it always claimed to do.

clang is the right thing to reach for rather than a lateral move. It is already
required on every machine that builds anything here — the backend emits text IR
and hands it to clang (§17), and `packages/forge/src/toolchain.ts` checks for it
before the type-check — and `clang-cl` is that same binary under the name `cc`
looks for, so this adds no dependency. The alternative of staying on `cl` and
keeping a version-conditional pin means encoding a defect in one vendor's
compiler into the build, and re-testing it at every toolset bump.

Three details of how it is wired, each of which could reasonably have gone the
other way:

- **Keyed on the target triple, not on `process.platform`.** The question is not
  "is this Windows" — MinGW is `windows` too and wants the GNU driver. Setting
  `CC_<triple>` lets `cc` decide whether the override applies by asking the
  question it was going to ask anyway.
- **`clang-cl`, not `clang --driver-mode=cl`.** `cc` picks the command-line
  dialect from the *name* of the program it was handed, so the second spelling
  is given `-o` and `-c` in gcc's spelling and fails with a page of "unknown
  argument".
- **`-EHsc` is added.** mimalloc's C++ path has a `try` in `alloc.c`; clang
  refuses one with exceptions disabled. `cl` accepts it, with warning C4530 and
  unspecified behaviour if it ever throws — so that library had been built
  without `/EHsc` for as long as it has been vendored, which nothing noticed.

An override already in the environment is left alone. `CC_<triple>` is the
documented way to name a C compiler, and a build that was told which one to use
should not be argued with.

### What still has no test

That a *future* C dependency is covered. The wiring is per-target rather than
per-package, so it applies to whatever `cc` builds — but `tests/allocator-boundary.test.ts`
exercises the allocator, and the allocator is the only C there is today.

---

## §29 — `readonly T[]`, and what `readonly` is here *(settled and built, 2026-09-04)*

**Answer: `readonly T[]` is a declaration in the prelude, not a compiler
feature.** `ReadonlyArray<T>` with `length`, `capacity`, a `readonly` index
signature and `forEach`, and none of `push`, `pop` or `reserve`. Erasure never
looks at the modifier, so the machine type is the identical
`{kind: "array", element}` and nothing in the backend knows the type exists.

### What was actually wrong

`readonly i32[]` type-checked already, and meant nothing. `xs[0] = 99` through
one compiled clean, and so did assigning it straight back to an `i32[]`.

The cause is `noLib: true`. The prelude is the entire global surface (§20), so
there was no `ReadonlyArray` for tsc to resolve — and tsc's fallback for a
missing one is `globalArrayType` itself. `readonly i32[]` *was* `i32[]`, spelled
differently, with no diagnostic anywhere to say so.

That is worse than not having the feature. Nobody writes `readonly` by accident;
they write it because they mean it, and then rely on it.

### Why the recognition path needed no work

`checker.isArrayType` answers true for `ReadonlyArray` as well as `Array` —
tsc's own predicate tests the target against both globals — and every array path
in this compiler goes through it: `erase`, `arrayElementAt`, the
`Reference<T[]>` arm of `referenceTo`, the generic argument match. So `length`,
indexing, `forEach`, `capacity`, drop elaboration, monomorphisation and the C
boundary all continued to work on the day the interface was declared, and the
copy still costs exactly what an `Array<T>` copy costs.

Assignability is structural and needs no rule: an `i32[]` satisfies
`ReadonlyArray<i32>`, and a `readonly i32[]` fails the other direction because
the mutators are not there — which is how TypeScript's own lib does it, and
`TS4104` is the error.

### The one hole, and `GF0240`

Every way of writing an element is spelled as a write and tsc refuses it on its
own — `xs[0] = v` is `TS2542`, `xs.push(v)` is `TS2339` — with a single
exception:

```ts
function drain(xs: readonly string[]): string { return take(xs[0]); }
```

`take` reads a slot **and puts the type's default back into it** (§27), which is
what lets a value leave without a copy. Its signature is `take<T>(value: T): T`,
so what tsc sees is a read, and no arrangement of the declaration can change
that. Measured before the fix: the underlying array really was emptied, through
a view, from a function that could not otherwise touch it.

`GF0240` is that check, in `#take`, and it reads the **index signature's own
modifier** rather than the name of the type — `Reference<readonly T[]>` is an
intersection and the array half is the half that carries it.

Note which case this protects. For an `i32[]` a stolen slot is invisible; for a
`string[]` it is a buffer that changed hands. Without the check the annotation
would have gone on holding for the element types where it does not matter and
quietly stopped holding for the ones where it does.

### What `readonly` is, and what it is not

**A check at the write, not a property of the value.** It holds this code to
what it wrote; it does not stop the same buffer being changed through another
name that still has the mutators. That is TypeScript's `readonly` everywhere,
and it is `const T &` in C++ — which is the model this language follows, so it
is the right amount of guarantee rather than a shortfall.

**Not a borrow.** A `readonly T[]` parameter is taken by value and costs the
copy. The entire content of by-value versus by-reference is `Reference<T>` (§24)
and nothing else was going to be allowed to imply it. `Reference<readonly T[]>`
says borrowed *and* read-only, and is the signature a loop over somebody else's
array wants.

**Shallow.** `readonly Body[]` refuses `xs[0] = b` and says nothing about
`xs[0].mass = 1`. Deep would require `Readonly<T>` to survive erasure as the
class it was made from, and it does not: a mapped type is an anonymous object
type, `classOf` finds no class, and it would erase structurally to a nameless
aggregate with the same fields — losing the vtable, the itable and the generated
destructor. That is the same obstacle a general `const` reference runs into, and
it is not solved here.

### Left open

**A `readonly` field is takeable.** `take(h.s)` where `s` is declared
`readonly x: string` empties it, by the same mechanism and for the same reason:
`take` is a write that tsc reads as a read. It is not array-specific, it
predates this change, and it is not fixed. Recorded here because the fix is the
same shape — ask whether the place `take` is about to write is one this code may
write — and doing both at once was out of scope rather than out of reach.

**A general read-only reference does not exist.** `Reference<T>` has no const
half (§24), and the mapped-type spelling breaks erasure as above. If it is ever
wanted, the shape that survives is a brand that erases identically plus a
frontend check — the backend must not learn about it, because both are one
`ptr`.
