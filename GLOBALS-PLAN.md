# Module-level constants

The staged plan for `const` at module scope, and for the `static` field that is
the same storage under another name. Decided 2026-09-06; DECISIONS §33's "still
open" is what it answers, and §34 will be the record once it lands.

The motivating program is a lookup table:

```ts
const EPHEMERIS: FixedArray<f64, 256> = fixedArrayOf(/* … */);

export function main(): i32 {
    return cast<i32>(EPHEMERIS[3]);
}
```

Today that is four `GF0001`s. As a function local it is 2 KB of stack stores on
every call; the point of this work is that it becomes an address in `.rodata`.

## What was decided, and what each answer rules out

**The rule is C++'s: anything that can be fully resolved at compile time.** No
initialiser runs at startup, ever. That single choice is what makes the rest
small — there is no init function, no cross-module initialisation order, and no
atexit teardown.

| Decision | Answer | What it rules out |
|---|---|---|
| How a global is named in the MIR | `Const::Global { global, ty }` — the **address**, as a constant, reached with `Projection::Deref` | A root variant on `Place`. Both emit identical `.rodata` and identical LLVM; this one changes no existing structure, and "a global is never dropped" then needs teaching to nobody — `storage_class` already answers Borrowed through a `Deref` |
| What an initialiser is on the wire | **Depth-first leaves** the backend places: `Zero`, `Scalar`, `SizeOf`, `AlignOf` | Bytes computed by the frontend. `Global.init: Option<Vec<u8>>` meant "already laid out", and the frontend has no layout — `requireKnownLayout` only asks *whether* one is known. A TypeScript layout engine would be a second opinion about padding, `linalg` alignment and enum widths, forever |
| Which types | Trivial only: scalars, enums, POD structs, `FixedArray` of those | `string` and `T[]`, which stay `GF0001` and are the next widening. They are emittable — a `string` is a 16-byte header whose literals are static and unowned, and there is already a shared static empty array — but they need the "a global is never destroyed" rule stated in drop elaboration rather than falling out of triviality |
| Mutability | `const` only | A top-level `let`, which stays `GF0001`. `Global.mutable` stays unread until something asks |
| Across modules | `export const` is a real data symbol, and an importer reads it through an extern | Nothing — this is in scope, and `summary.rs` already reports exported globals as defined symbols |
| The symbol | Module-qualified: `__gf_g$<tag>$NAME`, tag from the **project-relative** path | A plain unmangled name. So two modules may export the same name, and the constant is *not* reachable from C without a second alias. It also means a global in a file outside the project root cannot be exported, because the tag would differ between the machine that built the archive and the machine that consumes it — that is a diagnostic, not a silent unresolved external |
| What folds | Literals, enum members, unary minus, arithmetic over constants, `sizeOf`/`alignOf` as a whole initialiser, and reading another global **of this module** | Folding an *imported* global, which an extern data symbol cannot give a value for. And `sizeOf<T>() * 2`, because the size is a node the backend resolves rather than a number the frontend holds — liftable later by giving the tree arithmetic nodes |
| `static` fields | Included, on a non-generic class | A `static` on a generic class, which stays refused: the name stands for every instantiation and TypeScript has no syntax for choosing |

**There is no `Aggregate` node, and there cannot be one.** The obvious shape —
`Aggregate(Vec<GlobalInit>)`, a tree mirroring the type — is a cyclic
`postcard_schema` and does not compile: this crate's header states the rule, that
the type graph is acyclic so the generated bindings stay finite, and `Place` is
flat for the same reason. So the leaves are a flat depth-first list and **the type
is the structure**: a struct of two fields is two leaves, a struct holding a
three-element array is three. Nothing restates the shape, because two descriptions
of one shape are two things that can disagree — the same argument that put layout
in the backend in the first place. A `Zero` consumes the whole subtree at its
position, so a zeroed 4096-element table is one leaf rather than 4096.

**Reading another global is a compile-time dependency graph, not an
initialisation order.** `const B: i32 = A + 1` folds to `3` in the frontend and
`B`'s initialiser never mentions `A`. So what a cycle needs is detection, not
sequencing — and a cycle is the one new rule here that has no existing code.

The frontend therefore remembers two things per global: the `GlobalInit` tree it
will emit, and — when the value is a number the frontend actually holds — that
value, for a later fold to use. A global whose tree is `SizeOf` has no such
number, so it may be read whole and not used in arithmetic. That falls out rather
than being a rule.

## Stages

Each ends at a state where the four commands in `CLAUDE.md` are green.

- [x] **Stage 0** — the MIR and the wire format *(done 2026-09-06)*
- [ ] **Stage 1** — codegen: data emission, and the address constant
- [ ] **Stage 2** — the frontend: declaring and reading a module-private `const`
- [ ] **Stage 3** — reading another global, and cycles
- [ ] **Stage 4** — `export` and `import`
- [ ] **Stage 5** — `static` fields

### Stage 0 — the MIR and the wire format

`GlobalId` and `ExternGlobalId` in `ids.rs`; an `ExternGlobal` table beside
`ExternFunc`; `GlobalRef { Local(GlobalId), Extern(ExternGlobalId) }`, which is
`FuncRef` for data and exists for the same reason. `Global.init` becomes a
`GlobalInit`, so the `Option` goes — `Zero` is what `None` meant.
`Const::Global { global, ty }` is the new operand.

Then `bun run build:backend`, which regenerates the TypeScript bindings *and*
their encoder, and a new fingerprint. Three things already guard the halves and
all three should be watched rather than trusted: the fingerprint baked into the
generated TypeScript, the Rust test asserting the checked-in bindings match what
the generator would produce, and the encode-in-TS / decode-in-Rust / re-encode /
compare-bytes test.

**Checkpoint:** `cargo test --workspace` and `bun test` green, the round-trip
covering the new nodes, and nothing anywhere emitting a global yet.

*Done.* The fingerprint went `fb0eb16471f939bb` → `bc0fe6c1155f7dcb`, and the
regenerated diff was relocations plus the intended shape changes and nothing
else. Three things beyond the plan turned out to be needed:

- **The MIR printer had never rendered a global**, which is invisible while
  nothing emits one and would have made stage 2's output unreadable. It now
  prints the tables, and a `Const::Global` as `&NAME` — the `&` deliberately,
  because the address *is* the mechanism and a dump that hid it would hide the
  thing worth checking.
- **The fixture carries one global per initialiser shape**, both `GlobalRef`
  variants, and an exported one. A node no fixture uses is a node the
  byte-equality test does not cover, which is most of what that test is for.
- **`summary.defines` now lists the exported global**, which `summary.rs` has
  collected since before anything emitted one. `summary.requires` still omits an
  *imported* global, and that is wrong — it is undefined at link time exactly as
  an extern function is. Stage 4 owns it, and the assertion in
  `roundtrip.test.ts` says so, so stage 4 cannot land without changing that line.

`Const::Global` in the backend is an `internal_error!` until stage 1, which is
the right shape for it: nothing can reach it from source yet, so reaching it is
the compiler being wrong rather than a program being wrong.

### Stage 1 — codegen: data emission, and the address constant

`crates/goblin-codegen` has never emitted a data object for a global; the only
reader of `Module::globals` in the tree is `summary.rs`, which lists exported
ones as linker-visible symbols.

A **typed** LLVM initialiser rather than a byte array, because the codegen
already renders an LLVM type for every `TyId` and a typed one gets padding and
alignment from the type instead of needing them restated: `@g = internal
constant %struct.P { i32 1, i32 2 }`. `Zero` is `zeroinitializer`; `SizeOf` and
`AlignOf` are resolved from the layout engine at emission and become integer
literals. `Const::Global` is the symbol's address, which under opaque pointers is
the symbol itself.

An `ExternGlobal` is a declaration — `@sym = external constant T` — and nothing
else.

**Checkpoint:** `crates/goblin-codegen/tests/llvm_data.rs` grows a case per
initialiser shape over a hand-built module, asserting the rendered object and
that an indexed read GEPs the global rather than a stack copy.

### Stage 2 — the frontend: declaring and reading a module-private `const`

`#declare` in `lower/module.ts` accepts a top-level `VariableStatement` for the
first time. The refusals matter as much as the acceptance, and each one names
what it is rather than saying the statement is unsupported: `let`/`var`, more
than one declarator, no type annotation, a destructuring pattern, a type that is
not trivial, and an initialiser that does not fold.

The folder is new and belongs in its own file. It answers with a `GlobalInit`
plus, where it has one, a number — see above for why those are two answers and
not one.

Reading one is two small additions rather than a path of its own: the identifier
case in `width.ts` learns the type, and in `body.ts` the address is materialised
into a temporary and everything after it is an ordinary projection. Indexing and
field access should need nothing, which is the property this mechanism was
chosen for — and "should" is why there is a test for each.

**Checkpoint:** the program at the top of this file runs and returns the right
element, and its `.ll` holds one `internal constant` and no stack copy of the
table.

### Stage 3 — reading another global, and cycles

`const B: i32 = A + 1`. A dependency graph over the module's globals, resolved
before any of them is emitted, with a new diagnostic code for a cycle —
`const X = Y; const Y = X`. Declaration order must not matter, because it does
not matter for a function.

### Stage 4 — `export` and `import`

`Linkage::Export` and the module-qualified symbol; an importing module records an
`ExternGlobal` and reads through `GlobalRef::Extern`. Three things to get right:
folding *through* an import is refused, because an extern symbol has no value at
compile time; a global in a file outside the project root cannot be exported at
all, for the tag reason in the table above; and `summary.rs` must report an
imported global in `requires`, which it does not today — the assertion in
`packages/backend/test/roundtrip.test.ts` is written to fail until it does.

### Stage 5 — `static` fields

`classes.ts`'s `isStatic` branch over property declarations, which is where
`NOTES.md` has said "needs module-level storage the backend has never emitted"
since the beginning. A static is a global whose name is qualified by the class as
well as the module. A static on a generic class stays refused.

## Codes

Assigned as each stage lands, not up front — a code that nothing raises fails
`tests/diagnostics.test.ts`, which is the point of that test.

The gaps stay `GF0001`: a top-level `let`, a `string` or `T[]` global, an
initialiser that does not fold. The two *rules* want codes of their own, both in
the `GF00xx` build range: a cycle among initialisers, and exporting a global from
a file outside the project root.
