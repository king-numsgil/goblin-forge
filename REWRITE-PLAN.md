# goblin-native, take two

A plan for rebuilding this compiler as a single process with the value semantics
designed in rather than discovered.

This document exists because the current version works and is still the wrong
shape. Everything below is either a decision to carry forward, a decision to
reverse, or a trap that cost real debugging time and should not cost it twice.

**Two goals drive the rewrite**, and everything else is downstream of them:

1. **One process.** The frontend and the backend stop being two binaries with a
   protocol between them. `tsc` stays the type checker — that part was right —
   but it talks to Cranelift across a function call, not a pipe. See §2.
2. **C++ semantics designed in, not reasoned about afterwards.** Ownership,
   storage class, copy, move and destruction are written down before the IR is,
   and the IR is made incapable of expressing a program that violates them. See
   §4 for the model, §5.1 for how drops get placed, and §9.1 for how it stays
   true — differential testing against real C++, which turns "C++-like" from an
   intention into a checked property.

Everything else in here — the build API, `static-lib` targets, bundling — is
worth doing and none of it should be allowed to gate those two.

---

## 1. What is actually wrong with v1

Three things, in order of how much they hurt.

**Two processes.** The frontend runs `tsc` under Bun; the backend is a Rust
binary; they talk line-delimited JSON over stdio. The stated reason — that `tsc`
has already resolved every type, so re-parsing in Rust would mean a second
frontend that disagrees with the first — is *correct and worth keeping*. The
process boundary is not. It buys nothing the boundary between a JS module and a
native addon does not, and it costs a subprocess, a serialisation format, and a
wire contract "defined twice and kept in step by hand" (the README's own words).
That hand-syncing is a standing bug source: `protocol.ts` and
`crates/goblin-ir/src/lib.rs` have to agree on every field name, every enum
spelling, and every `#[serde(rename)]`.

**Ownership was inferred, not represented.** The IR has no notion of who owns a
value. The lowerer works it out from context with a family of helpers —
`takeOwnership`, `cloneOf`, `hoistIfOwned`, `ownsAllocation`, `borrowedReceiver`,
`stored`, `placed` — each of which is right in the contexts it was written for
and wrong in one that arrives later. Every memory-corruption bug found in the
audit was an instance of this:

- a `switch` on a string released its subject in two places, because "release
  everything down to this scope" was inclusive in one direction and the scope
  sat on the wrong side of the block;
- copying an array of objects shallow-copied the element pointers, because
  `arrayClone` is a `memcpy` and nothing in the IR said the elements owned
  anything;
- a `Reference<T>` bound to a temporary leaked, because reference bindings skip
  ownership tracking and nothing asked whether the initialiser had an owner.

None of these are hard bugs. They are all the same bug: ownership is a property
of the program that was never written down, so it had to be re-derived at every
site, and one site always gets missed.

**Ownership was also *retrofitted*.** The most telling artifact is a `Storage`
parameter — `"owned" | "inline"` — added to `releaseValue` late, threaded through
six call sites by hand. That is a type-level distinction being passed as a
string argument. In the new design it is part of the IR.

Two smaller things worth naming:

- **Expressions that need statements.** Copying an array element-by-element
  needs a loop, and a loop is a statement, and `cloneOf` returns an expression.
  v1 grew an `Expr::Seq { setup, value }` node to paper over it. That node is a
  symptom of a tree-shaped IR being asked to do control flow.
- **The value/storage size confusion.** `Type::size` meant "what a register
  holds" in some places and "how much space this occupies" in others. It took a
  heap overflow and a wrong `nativeSizeOf` to notice. The new IR should not have
  one function that answers two questions.

### What v1 got right, and must survive

Do not relitigate these:

- **`tsc` is the type checker, and its verdict is final.** No second frontend.
- **`unique symbol` brands for fixed widths.** All twelve widths share one key
  and differ in the string literal behind it. This is load-bearing: a different
  key per width would leave every brand optional-and-absent from the others,
  which makes them mutually assignable. Verified against real tsc, not assumed.
- **Erasure to a concrete, sized IR.** Rust never sees a `ts.Type`.
- **`Reference<T>` as a written type rather than an inferred borrow.** Making
  the borrow something you write deleted three diagnostics and two invented
  concepts when it landed.
- **Cranelift.** Compile speed is the whole argument; a single-pass backend that
  emits decent code immediately beats one that emits excellent code eventually.
- **The leak counter in the test harness.** Every run-test reads a live
  allocation count either side of the body. It is free, it is automatic, and it
  caught more real bugs than every deliberate assertion combined.
- **Reading the archive's real symbol table before linking.** A manifest typo is
  a compile error with a suggestion, not a link failure four steps later.

---

## 2. Target architecture

```
  your build script (Node/Bun)
        │  import { compile } from "goblin-native"
        ▼
  ┌─────────────────────────────────────────────┐
  │ goblin-native  (JS/TS package)              │
  │   • loads tsconfig, builds ts.Program       │
  │   • runs tsc; its diagnostics are final     │
  │   • lowers the checked AST to Goblin MIR    │
  │   • encodes MIR to a byte buffer            │
  └──────────────────┬──────────────────────────┘
                     │  one napi call, one Buffer
                     ▼
  ┌─────────────────────────────────────────────┐
  │ goblin-backend.node  (napi-rs addon)        │
  │   • decodes MIR                             │
  │   • layout, ABI classification              │
  │   • Cranelift → object file                 │
  │   • archive/symbol validation, linking      │
  └─────────────────────────────────────────────┘
```

One process. One `ts.Program` held across calls in a JS-side compiler object.
No stdio protocol, no subprocess management, no `serve` loop, no request ids.

### The napi boundary

**Define the MIR once, in Rust.** Derive `serde` on it, and generate the
TypeScript types from the Rust definitions (`ts-rs` or `specta`) so the frontend
is type-checked against the same source of truth the backend decodes. This
directly removes the "kept in step by hand" hazard that v1 documents as a known
weakness.

**Pass it as one `Buffer`, encoded with `postcard` or `bincode`.** Do *not* try
to model the MIR as `#[napi(object)]` structs: napi-rs handles plain structs and
C-like enums well, but a deeply nested tagged-union IR is exactly what it
handles badly, and you would end up hand-writing conversions — the same drift
problem in a new costume. One opaque buffer, one decode, one place where the
encoding lives.

Keep the napi surface small — roughly:

```rust
#[napi]
pub struct Backend { /* ObjectModule, target, caches */ }

#[napi]
impl Backend {
    #[napi(constructor)]
    pub fn new(options: BackendOptions) -> Result<Self>;

    /// Decode MIR, emit an object file, report what it defines and needs.
    #[napi]
    pub fn compile_module(&mut self, mir: Buffer) -> Result<ModuleArtifact>;

    /// Read an archive's real symbol table.
    #[napi]
    pub fn archive_symbols(&self, path: String) -> Result<Vec<String>>;

    /// Object files + archives → bin / static-lib / shared-lib.
    #[napi]
    pub fn link(&self, request: LinkRequest) -> Result<LinkReport>;
}
```

`BackendOptions`, `ModuleArtifact`, `LinkRequest`, `LinkReport` are flat enough
to be `#[napi(object)]`. Only the MIR is a buffer.

**Errors.** A napi `Result::Err` becomes a thrown JS exception, which is the
wrong shape for a compiler. Return diagnostics *in the result value*; reserve
throwing for "the addon itself broke". See §9.

### De-risk before anything else

One thing here actually needs proving, and it is not the bundling.

**Confirm the buffer boundary carries a real module.** Encode a representative
MIR fragment with `postcard`, hand it across as a `Buffer`, decode it in Rust,
and measure. This is the seam the whole architecture rests on, and the failure
mode is not "it doesn't work" but "it works and marshalling dominates the
compile". If it does, the answer is to emit per function rather than one blob
per module — cheap to do early, annoying to retrofit.

**Bundling into one executable is a nice-to-have, not a foundation.** It depends
on `bun build --compile` embedding a `.node` addon, which is somebody else's
tool and may or may not cooperate. Try it when convenient. If it does not work,
ship the `.node` beside the executable and resolve it at load time — that is an
ordinary npm package with a native dependency, which is a solved and unremarkable
shape. Nothing else in this plan changes either way, so do not let it gate
anything.

---

## 3. The build API

The sketch is good. Fleshed out:

```ts
import { compile } from "goblin-native";

const result = await compile({
  entry: "./src/main.ts",
  tsconfig: "./tsconfig.gn.json",

  type: "bin",                    // "bin" | "static-lib" | "shared-lib"
  output: "./bin/app",            // extension added per platform and type

  nativeLibs: ["./vendor/metis.lib"],
  manifests: ["./native.manifest.json"],

  target: "x86_64-pc-windows-msvc",   // default: host
  optLevel: "speed",                  // "none" | "speed" | "size"
  checked: false,                     // runtime liveness checks
  debugInfo: true,

  outDir: "./build",              // objects, .gbi, emitted .d.ts
  emit: { ir: false, header: true, declarations: true },

  incremental: true,
});

if (!result.ok) {
  for (const d of result.diagnostics) console.error(format(d));
  process.exit(1);
}
```

Rules for this API:

- **`compile` resolves, it does not throw**, unless something outside the
  program's control failed (missing toolchain, unreadable file). A program that
  does not compile is a *result*, not an exception.
- **Diagnostics are structured**: `{ severity, code, message, file, line,
  column, source: "tsc" | "goblin", notes?: Note[] }`. Ship a `format()` that
  renders them with a source excerpt, and let callers render their own.
- **Paths in, paths out.** Every path in the result is absolute. Every path in
  the options is resolved against the build script's directory, not the cwd.
- **The tsconfig is the user's**, and `goblin-native` supplies a base to extend
  (`noLib`, `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  target). Validate that the extended config still has the settings the language
  depends on, and produce a diagnostic naming the setting if not — v1 silently
  assumes them.
- **`watch`** belongs here eventually. Design the compiler object to be
  re-entrant with a retained `ts.Program` from the start, even if watch mode
  ships later; retrofitting incrementality into a one-shot pipeline is
  expensive.

### `static-lib` and `shared-lib` change the language

This is not a packaging detail. Two v1 design decisions are **closed-world** and
break the moment a second module or a library boundary exists:

- **Vtable slots are numbered per name across a module.** Two unrelated classes
  declaring `draw` share a slot, which is what lets an interface dispatch
  without side tables. Across a library boundary the numbering is not shared,
  and there is no mechanism to make it so.
- **`instanceof` is a comparison against the set of vtables known at compile
  time.** With a closed module that set is complete. With a library it is not.

Decide both **before** writing the backend, not after:

- For interface dispatch, the options are (a) keep per-name slots but make the
  name→slot map part of the published module interface and merge on import, (b)
  itables/fat pointers at the point of conversion to an interface, (c) hash the
  method name into a stable slot with collision handling. (b) is what most
  languages land on and is the least clever; (a) is the cheapest if all
  participating modules are compiled by this compiler.
- For `instanceof`, the closed-world trick has to go. Give every class a static
  type descriptor with a pointer to its base descriptor, and walk it. It is a
  few loads and it works across any boundary.

Also decide symbol visibility: a `shared-lib` needs an explicit export list, an
import library on Windows, and a decision about whether `export` in the source
means "visible to other Goblin modules" or "visible to the dynamic linker".
v1 conflates these because it only builds executables.

---

## 4. The semantic model, written down first

This is the section the rewrite exists for. **Write this before the IR, and make
the IR incapable of expressing anything that violates it.**

### 4.1 Every type has a category

| Category | Examples | Copy | Destroy | Passed as |
|---|---|---|---|---|
| **Trivial** | `i32`, `bool`, `f64`, `Pointer<T>`, a struct of trivial fields | `memcpy` | nothing | by value in registers |
| **Owning** | `string`, `T[]`, any struct with an owning field | user-visible copy op | user-visible destroy op | see §4.5 |
| **Polymorphic** | a class instance | slicing copy (static type's fields + static type's vtable) | virtual, through slot 0 | see §4.5 |
| **Borrow** | `Reference<T>` | trivial (it is an address) | nothing | one pointer |

The category is computed once, from the type, and cached. Every ownership
decision downstream is a lookup, never a re-derivation from expression shape.
`ownsAllocation(expr)` — v1's "is this a fresh allocation?" heuristic based on
the *node kind* — must not exist.

### 4.2 Every value has a storage class

| Storage | Meaning | Who destroys it |
|---|---|---|
| **Owned** | an allocation of its own | the binding, at scope exit |
| **Inline** | occupies bytes inside a parent object or array | the parent, as part of destroying itself |
| **Borrowed** | an address into somebody else's storage | nobody |
| **Temporary** | unnamed, produced by an expression | the enclosing full-expression |

This is the `Storage` string that got retrofitted into `releaseValue`. In the new
IR it is a property of a *place*, known statically, never passed as an argument.

The consequences that v1 had to learn the hard way fall out for free:

- An inline class field is destroyed by a **direct** call to its drop chain, not
  a virtual one — a slot sized for a `Base` cannot be holding a `Derived`,
  because putting one there would have sliced it.
- An inline field is never handed back to the allocator; its parent's storage
  is.
- A borrowed value is never destroyed, which is the entire content of
  `Reference<T>`.

### 4.3 The four operations

Every type supports exactly four operations, and the IR names them explicitly:

- `default_init(place)` — zero or trivial-construct.
- `copy_init(dst, src)` — the copy constructor. Trivial types `memcpy`; owning
  types clone what they own; classes slice.
- `move_init(dst, src)` — the move constructor. Transfers ownership; leaves the
  source in a state that is safe to destroy but must not be read. **v1 has no
  move**, which is why `const b = a` always copies and the README lists that as
  a known cost.
- `destroy(place)` — the destructor, respecting storage class and polymorphism.

Every one of these is a *statement* in the IR. Nothing is implied.

### 4.4 Temporaries and full-expressions

Adopt C++'s rule verbatim, because it is well understood and it is what people
will expect:

- A temporary is destroyed at the end of the **full-expression** that created
  it, in reverse order of creation.
- **No lifetime extension.** C++ extends a temporary bound to a `const&`; v1
  chose to reject that instead (`GN0234`) and the user confirmed that choice.
  Keep the rejection — it keeps ownership out of the compiler's inference, which
  is the point of `Reference<T>` existing.
- Copy elision is an *explicit* decision, not an accident. `return local` is a
  move. A `new C(...)` written directly into a field or element is constructed
  in place. Both should be named in the IR (`Init` vs `Assign`), not detected by
  the backend pattern-matching on node kinds — which is what v1 does today.

### 4.5 Parameters and returns

State the rule once and make both the internal convention and the C ABI obey it:

> **The machine value is passed by value.** For a `string` or `T[]` that value
> is a one-word handle, so the callee shares the buffer and the caller keeps
> owning it. For a struct the value is the struct, so a copy is made.

Then pick the destruction convention and write it down: **the caller destroys
by-value arguments** (Itanium-style), which is what v1 does and what makes the
callee's parameter an ordinary borrow of a copy. The alternative (callee
destroys, MSVC-style) is also fine, but only if chosen deliberately — mixing
them is a leak or a double free at every call.

Returns:
- Trivial and one-word: in registers.
- Owning/aggregate: the callee constructs into storage the caller designates.
  This is the same mechanism as the C ABI's hidden return pointer, which is why
  it should be one mechanism and not two.

### 4.6 `this`

`this` is a **borrow**, always: `Reference<Self>`. v1 types it as a plain object
parameter and gets away with it only because internal calls pass addresses.
The moment the C struct ABI exists, a by-value `this` would mean methods
mutating a copy. Type it as a reference from the start.

### 4.7 Divergences from TypeScript, stated up front

These are deliberate and permanent. Put them in the README's first page, not
buried in a subsection:

- **Objects are values.** `const b = a; b.x = 5` leaves `a` untouched. tsc
  cannot warn about this and neither can the compiler. It is the largest
  semantic difference the language has.
- **Copying a class slices.** Polymorphism travels through `Reference<T>` and
  `Pointer<T>`, never through values.
- **The prototype is fixed.** Assigning a method on an instance is an error even
  though tsc accepts it.
- **No truthiness.** `if (n)` on a number is an error.
- **Fixed-width arithmetic with lossless-only implicit promotion.**

---

## 5. The IR

**Use an MIR shape: a CFG of basic blocks, with places and rvalues.** Not a
statement tree with expressions hanging off it. The single biggest structural
lesson from v1 is that a tree-shaped IR forces ownership decisions into
expression contexts where they cannot be expressed, and every workaround
(`Expr::Seq`, hoisted temporaries carrying setup statements, `bindResult`) is
the tree failing to be a graph.

```rust
enum Place {
    Local(LocalId),
    Field { base: Box<Place>, index: FieldId },
    Index { base: Box<Place>, index: Operand },
    Deref(Box<Place>),          // through Pointer<T> or Reference<T>
}

enum Operand {
    Copy(Place),                // requires the type's copy op
    Move(Place),                // transfers ownership; source becomes dead
    Const(Const),
}

enum Rvalue {
    Use(Operand),
    Binary(BinOp, Operand, Operand),
    Unary(UnOp, Operand),
    Cast { operand: Operand, from: Ty, to: Ty },
    Ref(Place),                 // &place, for Reference<T>
    Aggregate { ty: TyId, fields: Vec<Operand> },
    Call { .. },                // in the terminator, not here
}

enum Statement {
    Assign(Place, Rvalue),      // destroys the old value first
    Init(Place, Rvalue),        // no old value; used for construction
    Drop(Place),                // destroy, respecting storage class
    StorageLive(LocalId),
    StorageDead(LocalId),
}

enum Terminator {
    Goto(BlockId),
    Branch { cond: Operand, then: BlockId, else_: BlockId },
    Switch { discr: Operand, targets: Vec<(Const, BlockId)>, default: BlockId },
    Call { func: FuncRef, args: Vec<Operand>, destination: Option<(Place, BlockId)> },
    Return,
    Unreachable,
}
```

Notes that matter:

- **`Place` answers the lvalue/rvalue question explicitly.** v1's
  `Expr::Field` returns a loaded value for scalars and an interior address for
  aggregates, decided inside the backend. Here, a `Place` is always an address;
  `Operand::Copy` is what loads.
- **`Copy` vs `Move` are in the IR.** The frontend decides; the backend obeys.
  No `takeOwnership` heuristic.
- **`Drop` is a statement, placed by a pass**, not spliced into statement lists
  by the lowerer. Which brings us to:

### 5.1 Drop elaboration

Run a real pass:

1. Lower to a CFG with `StorageLive`/`StorageDead` and no drops.
2. Compute, per block, the set of live owned locals.
3. Insert `Drop` on every edge where a local goes out of scope — including
   `break`, `continue`, early `return`, and the fallthrough out of a `switch`.
4. Where a local may or may not be initialised on a path, use a **drop flag**
   (a hidden `bool` local) rather than refusing the program.

The `switch` double-free in v1 is structurally impossible in this design: there
is no "release everything down to depth N" arithmetic to get inclusive-vs-
exclusive wrong, because drops are placed on CFG edges from liveness.

### 5.2 One size question, one answer

Do not repeat `Type::size` meaning two things. Have:

```rust
struct Layout { size: u32, align: u32, fields: Vec<u32> }  // storage
enum  Repr    { Register(ClifType), Aggregate(Layout) }    // how it travels
```

`Layout` answers "how many bytes does this occupy". `Repr` answers "what does a
register hold". A struct has a `Layout` and an `Aggregate` repr; `i32` has a
one-field `Layout` and a `Register` repr. Nothing has one function that answers
both, and `nativeSizeOf` obviously uses `Layout`.

**Nested aggregates are inline.** This is not negotiable if C interop is a goal,
and v1 had to be retrofitted for it. Bake it in: a field of struct type occupies
its layout, an array element occupies its stride, and the bytes match what a C
compiler produces for the same declaration.

---

## 6. Layout, ABI, and the C boundary

Carry v1's `goblin-codegen::abi` across almost unchanged — it is the newest code
and the best-tested — but move it earlier in the design.

### Rules to keep

- Fields in declaration order, naturally aligned, never reordered. Nested
  structs inline. A class carries a vtable pointer at offset 0 and lays base
  fields first, so upcasting is free.
- **Every function has a declared ABI**, `Internal` or `C`. `Internal` is
  whatever is fastest (pass aggregates by address). `C` is classified per
  platform. An `import` and any exported function are `C`. Both halves of a call
  read the same recorded shape, so an internal call to an exported function
  agrees with itself.
- **Win64**: struct of 1/2/4/8 bytes in one integer register; anything else by
  address, pointing at a copy the caller made. Returns: same sizes in `rax`,
  else a hidden pointer.
- **System V**: eightbyte classification, INTEGER or SSE, up to two registers to
  16 bytes; larger on the stack. `struct { float x, y; }` goes to **one SSE
  register** and `struct { int; float; }` to one integer register — getting that
  backwards is silent corruption, not a crash.
- **Sub-register-width integers carry `zeroext`/`signext`.** Cranelift defaults
  to neither. rustc and clang both attach them, and a callee compiled that way
  may use the whole register without masking.
- **Cranelift returns the `sret` pointer itself** from the parameter's
  `StructReturn` purpose. Do not also declare it as a return value; Cranelift
  panics if you do.
- **A struct crossing the boundary must be plain data.** No strings, arrays, or
  classes. A byte copy has to be the *whole* copy, or the two sides disagree
  about who frees what, and a class would additionally hand C a pointer into
  your read-only data.

### Rules to add

- **Test System V for real.** v1's is written from the psABI and has never been
  run. Put a Linux job in CI on day one; the classification is the part of a
  compiler where "looks right" is worth nothing.
- **Emit a C header** for `static-lib` and `shared-lib` targets. If you are
  claiming C ABI compatibility, the header is how anyone consumes it, and
  generating it from the same signature data that drives classification keeps
  them honest about each other.
- **Differential-test the layout**, do not assert it. v1's struct-ABI suite asks
  the C compiler for `size_of` and `offset_of` and compares. Keep that pattern
  and extend it to alignment, bitfield-free padding, and every struct shape the
  classification branches on.

---

## 7. The type system

Keep the branding, and keep the reasoning behind it — the tricks are subtle
enough that they will be "simplified" by someone who does not know why.

```ts
declare const WidthBrand: unique symbol;
type i32 = number & { readonly [WidthBrand]?: "i32" };
```

- **One key, twelve literals.** A distinct key per width would leave every brand
  optional and *absent* from the others, and optional-and-absent is assignable —
  the widths would silently unify.
- **Optional brand**, so arithmetic works and `const x: i32 = 42` reads
  naturally. The cost is that `number` is assignable to every width, which is
  the hole the compiler's own width pass exists to close.
- **A symbol key** so no source file can spell it and claim a width it does not
  have.
- `Pointer<T> = T extends GnPrimitive ? CorePointer<T> : T & CorePointer<T>` —
  the intersection is what makes `p.width` and `p.area()` work with no `->`.
  The brand is **covariant** and therefore unsound in exactly the way `Shape**`
  is unsound in C++. That is a deliberate trade; write it down next to the
  declaration.
- `Reference<T>` uses an *optional* brand so a value converts to a reference
  implicitly. That also means a reference converts back to a value, which is the
  copy — and it is the right place for the copy to happen, because it is where
  the programmer wrote it.

### Things the width pass owns, because tsc cannot

Put all of these in one table-driven place rather than scattered through
lowering:

| Rule | v1 code | Notes |
|---|---|---|
| Lossless-only implicit promotion | `GN0161` | `T`→`U` iff every `T` is exactly representable in `U` |
| No implicit narrowing | `GN0160` | `nativeCast` is the written form |
| Literal must fit its width | `GN0164` | hex/octal/binary may fill the unsigned range and reinterpret |
| No unary minus on unsigned | `GN0165` | otherwise `-1` walks past the range check as a `u8` |
| Integer-only ops reject floats | `GN0162` | `%`, `&`, `|`, `^`, `<<`, `>>` |
| Shifts take the value's type | — | the count is converted; **not** promoted to a common type |
| `isize`/`usize` promote only to themselves | — | their width belongs to the target |

**Keep a proper scoped type environment.** v1's map of inferred local widths is
flat — a local declared inside a branch stays visible afterwards — and it gets
away with it only because tsc rejects any program that could observe it. That is
a bet, not a design. Use a scope stack.

---

## 8. Diagnostics

Two sources of "no", and which one speaks matters, because one of them
underlines in the IDE:

- `TS####` — real tsc. Prefer it whenever the rule can be expressed in the type
  system, because the user sees it while typing.
- `GN####` — the language subset and the machine model.

Hard rules:

1. **The backend never reports a user error.** Every `bail!` reachable from
   valid-per-tsc source is a missing frontend check. v1 violated this: `someF64
   % 2` reached Cranelift and produced `error: compiling function 'main': Rem is
   not defined on f64` — no code, no file, no line. Enforce it: in debug builds,
   make backend errors panic, so a test that triggers one fails loudly instead
   of looking like a clean rejection.
2. **Every diagnostic names the construct and suggests the alternative.** v1's
   messages are genuinely good; keep the standard. "a reference cannot borrow a
   temporary: nothing owns X here, so it would never be released. Bind it to a
   value first, then take a reference to that."
3. **Codes are stable and documented.** Keep a registry file mapping code →
   short title → long explanation, and generate the docs page from it.
4. **Diagnostics carry structured notes**, so "here is where the value was
   moved" can point at a second location. Ownership errors are unreadable
   without this.

---

## 9. Testing

The v1 harness is the best part of the project. Carry it forward and close the
holes the audit found.

**Keep:**
- Real source → real compiler → run the binary → check stdout exactly.
- **The automatic leak check on every run-test.** Non-negotiable. It found four
  bugs nobody was looking for.
- Assert diagnostic codes, spanning both `GN` and `TS`, so a check moving from
  one to the other shows up as a failure.

**Add — and this is the one that serves the semantics goal directly:**

### 9.1 Differential testing against C++

If the semantics are meant to be C++'s, then C++ is the oracle. Write each
semantics case **twice** — once in Goblin, once in C++ — with both programs
printing a trace of every construction, copy, move and destruction, and require
the two traces to be identical.

```cpp
// oracle/slicing.cpp                     // cases/slicing.gn.ts
struct Base { Base(const Base&); ... };   class Base { ... }
Derived d("d");                           const d = new Derived("d");
Base sliced = d;                          const sliced: Base = d;
```

```
ctor Derived(d)
copy Base(d)            <- the slice
dtor ~Base(d)           <- sliced, first
dtor ~Derived(d)
dtor ~Base(d)
```

This is worth more than any number of hand-written expectations, because the
question "what *should* this print?" stops being a judgement call. Where the
traces are meant to differ — there is no move in v1, temporaries are not
lifetime-extended, `Reference<T>` is not `const&` — the difference is written
down in the test as an explicit expected divergence, which turns every
intentional departure from C++ into a documented, checked one rather than a
thing someone remembers.

Cover at minimum: scope exit order, slicing, virtual destruction through a base
reference, temporaries at end-of-full-expression, by-value parameters, return
value construction, copy-on-binding, containers of owning elements, and
destruction order for nested aggregates. Every one of those is a place v1 got
something subtly wrong at least once.

**Also add:**
- **`expectRejected` must require a diagnostic code.** v1's matches only
  `error[CODE]`, so a backend panic and a clean rejection are indistinguishable
  to the assertion — a compiler crash reads as a passing test.
- **Assert stderr**, not just stdout. v1 checks it in exactly one test.
- **A struct-ABI differential suite from day one**, against a real `extern "C"`
  library, checking layout agreement, by-value copy semantics, register
  assignment around structs, and return ownership. In v1 this suite did not
  exist and the by-value path was silently broken the whole time.
- **Run the same programs under `--checked` and release** and require identical
  output.
- **CI on Linux**, or the System V ABI is decoration.
- **Snapshot the MIR** for a handful of programs. Drop placement is the thing
  most likely to regress invisibly, and a golden MIR file makes a change to it
  visible in review.
- **Clean the scratch directory.** v1's accumulated over a thousand throwaway
  projects, which makes inspecting a real failure miserable.

---

## 10. Traps

Each of these cost real time. They are listed with the shape of the failure, not
just the fix, because the shape is what recurs.

**Scope arithmetic for early exits.** `break` from a `switch` must release the
scopes opened *inside* the breakable block, not the scope holding the switch
subject — that one lives outside and is released by the block's own exit. Getting
the bound inclusive instead of exclusive is a double free that only fires when
the subject owns something. *Prevention: place drops from CFG liveness, never
from a depth counter.*

**Shallow copies of containers whose elements own things.** `memcpy` is the
right copy for an array of `i32` and a double free for an array of anything with
a destructor. *Prevention: the copy operation comes from the element type's
category, and there is no default.*

**Uninitialised scratch storage.** Constructing into a stack slot runs the
constructor, and a constructor releases whatever the field used to hold. On
uninitialised stack that is a garbage pointer. *Prevention: zero any scratch you
construct into, or construct only into storage you allocated zeroed.*

**Stride computed from the wrong size.** An array of structs allocated with the
pointer size and indexed with the layout size overlaps its own elements. It
prints plausible values for a while. *Prevention: §5.2 — one size question, one
answer.*

**A constant-true loop condition.** Emitting a conditional branch to an exit
block that is then never filled is a Cranelift verifier error, not a warning.
Emit an unconditional jump when the condition is a constant, so the exit block is
never referenced and is simply dropped. *This is a `while (true) { ... return; }`
away from any user hitting it.*

**Relabelling a pointer as its pointee.** v1 retypes a receiver to the object
type so field offsets resolve. Do that to a `Pointer<T>` and the destructor pass
sees an owned object and frees storage the pointer was only borrowing.
*Prevention: `Place::Deref` is explicit; nothing is retyped.*

**Negative literals.** `-128` is a valid `i8`; `128` is not. Range-check the
literal *after* folding the sign into it, or the lower bound of every signed
width becomes unwritable.

**`nativeSizeOf` on an aggregate.** If it answers with the register size, it is
wrong *and* it makes `nativeNew<T>()` under-allocate, which is a heap overflow
behind an intrinsic the docs advertise as working.

**Cranelift's `StructReturn`.** It inserts the return itself. Declaring the sret
pointer as both a parameter purpose and a return value panics inside the ABI
layer with a message that does not obviously say so.

**Tests that assert the bug.** v1 had an assertion that `b | 256` produces `255`
for a `u8`, filed under "unsigned operators differ from signed". It passed only
because the literal truncated to zero. Fixing the truncation broke the test —
which is backwards, and is the reason to prefer expectations that could only be
produced by the correct behaviour.

---

## 11. Decisions to make before writing code

Do not start the backend until these are answered, because each one changes the
IR:

1. **Move semantics.** Is there a `move`? Is it inferred from last-use (needs
   liveness), written by the user, or only produced by `return local`? v1 has
   none and pays an allocation for every `const b = a`.
2. **Interface dispatch across a library boundary.** Per-name slots, itables, or
   hashed slots. §3.
3. **`instanceof` across a library boundary.** Type descriptors with a base
   chain, almost certainly. §3.
4. **Who destroys a by-value argument**, caller or callee. §4.5.
5. **Exception model.** There isn't one, and that is fine — but it must be a
   stated decision, because it determines whether drops need unwind edges in the
   CFG. If the answer is ever "yes, later", put the unwind edges in now; adding
   them afterwards is a rewrite of the drop pass.
6. **Mutable containers.** `push`, index assignment, growth. This is the largest
   missing feature and it interacts with iterator invalidation and with the
   inline-element layout. Decide whether v2 has it before designing arrays.
7. **Generics.** Monomorphisation or nothing. The intrinsics are generic in the
   source and special-cased by the compiler, which is not the same thing and
   should not be mistaken for a foundation.
8. **Multi-module linking**, and whether `.gbi` survives. If the frontend and
   backend are one process, a lot of what `.gbi` was for is now just holding
   state in memory across `compile_module` calls.

---

## 12. Build order

Each milestone ends with something runnable and tested, and none of them is
"and now we make ownership work".

1. **Spike the boundary.** napi addon, MIR `Buffer` round-trip, generated TS
   types, measured. One process, no stdio. Answer §2's de-risk question.
2. **Skeleton.** `compile()` API, tsconfig loading, diagnostics plumbing, and a
   program that compiles `export function main(): i32 { return 42; }` to a
   binary that exits 42. No objects, no strings.
3. **The type system and the width pass.** All twelve widths, promotion, literal
   ranges, casts, the operator table. Port `types.test.ts` — it is the honest
   record of what the rules are.
4. **MIR and drop elaboration, on trivial types only.** CFG, places, operands,
   `StorageLive`/`Dead`, drop flags. No owning types yet, so drops are no-ops —
   but the pass exists and is tested with golden MIR.
5. **Owning types.** `string` first, since it is one word and exercises copy,
   move, destroy and temporaries without layout questions. **The C++ oracle
   suite (§9.1) starts here and grows with every milestone after it** — that is
   what keeps "C++-like" a checked property rather than an intention.
6. **Layout and aggregates.** Structs, inline nesting, arrays with inline
   elements. The differential layout suite against a C compiler lands here.
7. **The C ABI.** Both conventions, with the Linux CI job. The struct-ABI
   differential suite lands here.
8. **Classes.** Vtables, virtual destructors, slicing, inheritance. Interface
   dispatch per the decision from §11.2.
9. **`static-lib` / `shared-lib`**, header emission, symbol visibility.
10. **Multi-module**, if `.gbi` survives §11.8.

---

## 13. What to copy verbatim

There is a lot here that is good and should be lifted rather than rewritten:

- `runtime/global.d.ts` — the whole ambient surface, brands included.
- `runtime/native/src/lib.rs` — the sds-style string and array layout, the
  formatting, the console, the live-allocation counter.
- `crates/goblin-codegen/src/abi.rs` — the classification, near enough as-is.
- `crates/goblin-codegen/src/ffi.rs` — manifest handling, archive symbol-table
  validation, `native-static-libs` parsing. This code has no design problems.
- `crates/goblin-codegen/src/link.rs` — linker discovery and argument assembly.
- `tests/harness.ts` — with the §9 additions.
- `tests/struct-abi.test.ts` and `tests/native/` — the differential ABI suite.
- Most of the README's prose. It explains *why* better than most compilers
  document *what*, and that is the part worth keeping.
