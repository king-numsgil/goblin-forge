/**
 * The `GF####` registry.
 *
 * REWRITE-PLAN §8.3: codes are stable and documented, and the docs page is
 * generated from this file rather than written beside it. A code that exists
 * only as a string literal at the site that raises it drifts out of the
 * documentation within a month.
 *
 * Numbering, loosely inherited from v1 so that anyone who knows the old codes
 * is not surprised:
 *
 *   `GF00xx`  the build itself — configuration, entry point, unsupported syntax
 *   `GF01xx`  widths and arithmetic
 *   `GF02xx`  ownership, references, pointers, the value model
 *   `GF03xx`  layout and the C boundary
 *   `GF90xx`  the compiler is broken, not your program
 *
 * A code is never reused for a different rule. If a rule goes away its code
 * goes with it.
 */

export interface CodeEntry {
  /** A few words, for a summary line or an index. */
  readonly title: string;
  /**
   * Why the rule exists, in the terms the programmer is thinking in. This is
   * what gets rendered into the docs, so it is prose rather than a restatement
   * of the title.
   */
  readonly explanation: string;
}

/**
 * Every diagnostic this compiler can raise about a user program, plus the few
 * it raises about itself.
 *
 * The messages themselves live at the site that raises them, because a good
 * message names the specific construct. This table is the stable identity and
 * the long-form explanation.
 */
export const CODES = {
  // -- The build itself ----------------------------------------------------
  GF0001: {
    title: "construct not supported yet",
    explanation:
      "This is valid TypeScript and it is meant to be valid Goblin, but the " +
      "compiler cannot lower it yet. It is a gap in the implementation rather " +
      "than a rule about the language, and it is reported here rather than " +
      "left to fail somewhere in the backend, because a backend error has no " +
      "file and no line.",
  },
  GF0002: {
    title: "construct not part of the language",
    explanation:
      "TypeScript allows this and Goblin does not. The language is a subset " +
      "with value semantics and a machine model underneath it, so constructs " +
      "that depend on a JavaScript runtime — dynamic property assignment, " +
      "truthiness, prototype mutation — have no meaning here.",
  },
  GF0003: {
    title: "tsconfig is missing a setting the language depends on",
    explanation:
      "Goblin supplies a base tsconfig for your project to extend. A few of " +
      "its settings are not stylistic: without `noLib` the whole JavaScript " +
      "standard library reappears, and without empty `types`/`typeRoots` tsc " +
      "loads every `@types` package it can find and puts the DOM back. " +
      "Extending the base and then overriding one of these produces a program " +
      "that type-checks against a language this compiler does not implement.",
  },
  GF0004: {
    title: "entry point is missing or has the wrong shape",
    explanation:
      "A `bin` target needs an exported function named `main`. It is called " +
      "by the platform C runtime, so its signature has to look like C's: it " +
      "returns `i32`, and it takes either no arguments or the conventional " +
      "argc/argv pair.",
  },

  // -- Widths and arithmetic ----------------------------------------------
  GF0160: {
    title: "implicit narrowing",
    explanation:
      "A value cannot silently become a narrower type, because the truncation " +
      "is invisible at the point it costs you. Write `nativeCast<u8>(x)` where " +
      "you mean it.\n\n" +
      "tsc usually catches this on its own, because the twelve widths are " +
      "mutually unassignable. It cannot catch it on the result of arithmetic: " +
      "the width brand is optional, so `a * b` is a plain `number` as far as " +
      "the type system is concerned, and plain `number` is assignable to every " +
      "width. Closing that hole is what this pass is for.",
  },
  GF0163: {
    title: "`nativeCast` cannot convert between these types",
    explanation:
      "`nativeCast` converts between the twelve fixed widths and from `boolean` " +
      "to a width. It is not a reinterpretation and not an escape hatch: " +
      "converting a pointer, a string, or an aggregate is a different operation " +
      "with different rules, and each has its own spelling.",
  },
  GF0161: {
    title: "no common type for these operands",
    explanation:
      "Operands promote to whichever type holds both of them exactly. " +
      "`i32` and `u32` have no such type — neither holds the other — and " +
      "neither do `i64` and `f64`, because `f64` is exact only to 2^53. C " +
      "converts both silently; here you write which one you meant.",
  },
  GF0162: {
    title: "integer-only operator applied to a float",
    explanation:
      "`%`, `&`, `|`, `^`, `<<` and `>>` are defined on integers. There is no " +
      "float remainder and no bit pattern to shift.",
  },
  GF0164: {
    title: "literal does not fit its width",
    explanation:
      "The literal is out of range for the type it is being given. The range " +
      "is checked after any leading minus sign has been folded into the " +
      "literal, so `-128` is a valid `i8` even though `128` is not. Hex, " +
      "octal and binary literals may fill the unsigned range and are " +
      "reinterpreted, so `0xff` is a valid `i8` meaning `-1`.",
  },
  GF0165: {
    title: "unary minus on an unsigned type",
    explanation:
      "Negating an unsigned value has no meaningful result. Allowing it also " +
      "walks `-1` straight past the range check as a `u8`, which is how the " +
      "wrong constant gets into a program without anybody noticing.",
  },

  // -- Ownership and the value model --------------------------------------
  GF0227: {
    title: "a pointer used where a value is expected",
    explanation:
      "As far as tsc is concerned a `Pointer<T>` is assignable to a `T`, " +
      "because the pointer type is an intersection that includes `T`. " +
      "Accepting that would silently copy a heap object onto the stack. Write " +
      "the dereference — `p.deref()` — where you mean the value.",
  },
  GF0235: {
    title: "a moved-from value was read",
    explanation:
      "`move` hands ownership somewhere else and leaves the source empty. " +
      "Reading it afterwards would read something that is no longer there.\n\n" +
      "The check is lexical: a move is seen for the rest of the block it is in " +
      "and every block inside that. A move under an `if`, read after the `if`, " +
      "is not caught — and to make that gap harmless rather than dangerous, a " +
      "move nulls its source, so the value read back is empty rather than " +
      "dangling.",
  },
  GF0236: {
    title: "a by-value parameter cannot be moved out of",
    explanation:
      "The caller releases a by-value argument when the call ends, so moving " +
      "out of one inside the callee would free the same buffer twice.\n\n" +
      "C++ allows the same-looking line, and the difference is worth knowing. " +
      "There the parameter object *is* the thing the caller destroys, so " +
      "`std::move` empties the very object whose destructor will run. Here an " +
      "owning value travels as a one-word handle in a register, so the callee " +
      "holds a different local: emptying it does nothing to the caller's copy.\n\n" +
      "Assigning the parameter somewhere is already a copy, which is usually " +
      "what was meant. If the caller should keep ownership and the callee " +
      "should only read, take a `Reference<T>` instead.",
  },
  GF0234: {
    title: "a reference cannot borrow a temporary",
    explanation:
      "Nothing owns the value being borrowed, so it would be destroyed at the " +
      "end of the enclosing full-expression and the reference would outlive " +
      "it. C++ extends the lifetime of a temporary bound to a `const&`; " +
      "Goblin rejects it instead, because lifetime extension puts ownership " +
      "back into the compiler's inference and keeping it out is the reason " +
      "`Reference<T>` is something you write. Bind the value to a name first, " +
      "then take a reference to that.",
  },

  // -- The compiler is broken ----------------------------------------------
  GF9001: {
    title: "the backend could not decode the MIR",
    explanation:
      "The frontend produced a buffer the backend could not read. This is a " +
      "compiler bug; please report it with the program that triggered it.",
  },
  GF9002: {
    title: "the native addon and the frontend disagree on the wire format",
    explanation:
      "The prebuilt `.node` addon was built from a different MIR definition " +
      "than the JavaScript beside it. Rebuild with `bun run build:backend`.",
  },
  GF9003: {
    title: "the backend could not generate code",
    explanation:
      "Code generation reached a case the frontend should have rejected or " +
      "should never have emitted. This is a compiler bug; please report it with " +
      "the program that triggered it.\n\n" +
      "In a build with `strictInternalErrors` on — which every test uses — this " +
      "panics instead, so that a compiler crash cannot be mistaken for the " +
      "compiler correctly rejecting a program.",
  },
  GF9004: {
    title: "the backend was asked for an output kind it does not know",
    explanation:
      "`type` must be `\"bin\"`, `\"static-lib\"` or `\"shared-lib\"`. Reaching " +
      "this means the build API and the backend disagree about the set, which " +
      "is a compiler bug.",
  },
  GF9005: {
    title: "linking failed",
    explanation:
      "Unlike the other `GF9###` codes this is not necessarily a compiler bug: " +
      "a missing toolchain, an unreadable archive, or a symbol no library " +
      "defines will all land here. The message carries the exact linker command, " +
      "so the failure can be reproduced by hand.",
  },
} as const satisfies Record<string, CodeEntry>;

/** Every code this compiler knows about. */
export type Code = keyof typeof CODES;

export function explain(code: Code): CodeEntry {
  return CODES[code];
}

/** Codes in numeric order, for the generated documentation page. */
export function allCodes(): [Code, CodeEntry][] {
  return (Object.entries(CODES) as [Code, CodeEntry][]).sort(([a], [b]) =>
    a.localeCompare(b),
  );
}
