# Generics: what is tested, and what was found testing it

Working notes. GENERICS-PLAN is the design and DECISIONS §11.7, §24 and §25 are
the settled answers; this is the audit trail for *coverage* — what has been
pushed on, what broke when it was, and what is still only assumed to work.

It exists because "generics work" was claimed three times before it was true.
Each time the gap was found by testing a *combination* rather than a feature:
a generic class implementing a generic contract, an accessor on a generic
class, a generic aggregate at the C boundary. None of those is exotic.

## Status

- `tests/generics.test.ts` — the language feature.
- `tests/library-generics.test.ts` — across a Goblin library boundary.
- `tests/libraries.test.ts` — a **C** consumer against a header carrying two
  instantiations, which is what proves the header naming.
- `tests/structs.test.ts` — struct identity (`layoutKey`), which generics rest
  on.

## Known limits, each with a test that pins the message

| Limit | Kind | Where |
|---|---|---|
| a generic **base class** — `class D extends Box<i32>` | gap | `classes.ts`, `baseOf` |
| a **`static` on a generic class** — `Box.zero()` | gap | `lower/width.ts`, identifier path |
| a **conditional type** over a type parameter | limit, not a gap | `checker/src/types.ts`, `erase` |
| `Pointer<T>` **used** inside a generic — `p.deref()` | tsc, not us | prelude's conditional `Pointer` |
| `Reference<string>` | gap | `eraseReferent` |
| a consumer linking archive *vN* against source *vN+1* | packaging | DECISIONS §25 |

## Round 4 — the obsessive pass

- [x] `tryCast` distinguishing `Box<i32>` from `Box<f64>` **and from another
      class** — the negative half matters more, since the positive test passes
      just as well if every cast succeeds
- [x] two generic classes of the same name in two files — still `GF0002`, the
      rule that has always covered this
- [x] a generic aggregate declared identically in two files — one struct, and a
      value crosses between them
- [x] generics over `linalg` (`dvec3`, by value and in a generic class)
- [x] generics over an enum
- [x] generics over a union (`extends Union`)
- [x] generics over `FixedArray<T, N>`
- [x] `zeroed<T>()`, `sizeOf<T>()`, `alignOf<T>()` inside a generic
- [x] `move` inside a generic body — correctly refused, `GF0236`
- [x] a generic class with a plain base class
- [x] a generic class's destructor, stack and heap, two instantiations
- [x] a generic taking a `LocalFn`
- [x] a generic returning `T[]`; `Pointer<T>` in a signature
- [x] the flaky `closures.test.ts` case — see below
- [ ] the instantiation depth limit at its boundary (below the cap, not just
      above it)
- [ ] a generic instantiated in a `shared-lib`, where two artefacts and one
      runtime is the delicate part
- [ ] a generic whose type argument makes an *erasure* fail, with the
      instantiation note — covered once, in `library-generics`, not in the
      language suite

**Everything in the first group passed on the first try** except the two cases
that were my test's fault (a missing `std/linalg` import; a `?:` with no width)
and the two that were correct refusals. That is worth recording as evidence
rather than as reassurance: the earlier rounds found bugs because they crossed
*features*, and this round mostly crossed a feature with a type family, which
the substitution-at-the-leaf design handles uniformly by construction.

## The flake *(diagnosed and fixed)*

`closures.test.ts > a non-capturing lambda is accepted, with no environment`
failed once in a full run, at **6453 ms**, and passed alone and in three
consecutive runs of its own file.

It was not the compiler. 200 runs of that binary and 15 compile-and-run cycles
produced nothing odd in seven seconds. **Bun's default per-test budget is 5000
ms**, and 6453 > 5000: the message was "this test timed out after 5000ms",
which says nothing about the program under test.

Fixed in `tests/preload.ts`, with `setDefaultTimeout(30_000)`. Not in
`bunfig.toml`, whose `[test]` table takes `preload` and ignores `timeout` on
Bun 1.4.0 — verified, not assumed — and not on the command line, so that
running `bun test` bare gets the same budget as running it through
`package.json`.

The reason it mattered enough to chase: a timeout that fires on contention is
indistinguishable from a real failure, and the harness's most valuable check is
the *missing* live-allocation report — whose meaning is "the program did not
finish". A spurious version of that sentence teaches a reader to shrug at the
one thing they should not.
