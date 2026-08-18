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
            "A `bin` target needs an exported function named `main`, returning " +
            "`i32` — it is called by the platform C runtime and its result becomes " +
            "the process exit code. It takes either nothing or one `string[]`. The " +
            "C runtime really does hand over an argc/argv pair, and the emitted " +
            "`main` really does take one; the runtime copies it into an array " +
            "before your first statement, so there is no version of this signature " +
            "that names the two halves separately.",
    },
    GF0005: {
        title: "the runtime cannot be linked the way this build asked for",
        explanation:
            "`runtime: \"shared\"` links one runtime that several Goblin artefacts " +
            "in a process share, instead of putting a copy inside each. It needs " +
            "the runtime crate to have produced a shared library, which its " +
            "manifest asks for with `crate-type = [\"staticlib\", \"cdylib\"]`.\n\n" +
            "A target whose toolchain cannot produce a `cdylib` — a bare-metal or " +
            "static-only triple — can still be built `runtime: \"static\"`, which is " +
            "the default and needs nothing beyond the archive. The shared runtime " +
            "buys exactly one thing: two Goblin artefacts in one process sharing a " +
            "heap, a live-allocation counter and one copy of `gf_string_free`. If " +
            "you are not doing that, you do not need it.",
    },

    // -- Widths and arithmetic ----------------------------------------------
    GF0160: {
        title: "implicit narrowing",
        explanation:
            "A value cannot silently become a narrower type, because the truncation " +
            "is invisible at the point it costs you. Write `cast<u8>(x)` where " +
            "you mean it.\n\n" +
            "tsc usually catches this on its own, because the twelve widths are " +
            "mutually unassignable. It cannot catch it on the result of arithmetic: " +
            "the width brand is optional, so `a * b` is a plain `number` as far as " +
            "the type system is concerned, and plain `number` is assignable to every " +
            "width. Closing that hole is what this pass is for.",
    },
    GF0163: {
        title: "`cast` cannot convert between these types",
        explanation:
            "`cast` converts between the twelve fixed widths and from `boolean` " +
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
            "reinterpreted, so `0xff` is a valid `i8` meaning `-1`.\n\n" +
            "A literal written with a fraction or an exponent does not fit an " +
            "integer width at all, whatever its value: `1e3` is exactly a thousand " +
            "and is still refused, because accepting it would be the silent " +
            "float-to-integer conversion every other part of the language makes you " +
            "write. `cast<i32>(1.5)` is that written form, and truncates.",
    },
    GF0165: {
        title: "unary minus on an unsigned type",
        explanation:
            "Negating an unsigned value has no meaningful result. Allowing it also " +
            "walks `-1` straight past the range check as a `u8`, which is how the " +
            "wrong constant gets into a program without anybody noticing.",
    },

    GF0166: {
        title: "an enum's underlying type is not an integer width",
        explanation:
            "TypeScript has no syntax for a C enum's underlying type, so it is " +
            "declared by merging a namespace into the enum:\n\n" +
            "    enum SDL_EventType { Quit = 0x100 }\n" +
            "    declare namespace SDL_EventType { type Underlying = u32 }\n\n" +
            "`Underlying` has to name one of the integer widths — `i8` through " +
            "`u64`, `isize`, `usize`. An enum is a set of integer constants, so a " +
            "floating-point width has no meaning for one: members are written as " +
            "exact values and compared for equality, which is the operation binary " +
            "floating point is worst at.\n\n" +
            "Omitting the declaration is not an error. Without one the enum is " +
            "`i32`, which is what a C enum is unless the ABI says otherwise.\n\n" +
            "The width is also what every member is range-checked against, so " +
            "declaring `u8` and writing `0x100` is refused here rather than " +
            "silently truncated at the point of use.",
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
            "**Assigning to the binding clears this.** A moved-from value is empty " +
            "rather than invalid — the same state C++ leaves one in — so putting a " +
            "value back makes it readable again, which is what lets a `let` be moved " +
            "out of inside a loop and refilled before the next pass.\n\n" +
            "The check is not flow-sensitive: a move is seen for the rest of the " +
            "function, so a move under an `if` that does not refill the binding is " +
            "reported after the `if` even where the branch might not have run. That " +
            "is the conservative direction, and the cost of being wrong the other way " +
            "is bounded anyway — a move nulls its source, so an unreported read finds " +
            "an empty value rather than a dangling one.",
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
            "should only read, take a `Reference<T>` instead.\n\n" +
            "`return parameter` is the same operation without the word, and it is a " +
            "**copy** rather than an error: returning a local is normally an implicit " +
            "move because the local is about to go out of scope, and a parameter is " +
            "the one local that rule does not hold for. Only the written `move` is " +
            "refused, because only it is asking for something that cannot be done.",
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

    GF0237: {
        title: "this type has no null",
        explanation:
            "`null` reaches the backend as a machine word of zero, so it is a value " +
            "only for the types where a zero word means \"nothing here\": " +
            "`Pointer<T>`, `CString`, and a function pointer. All three are " +
            "*borrowed* — nobody here owns what they point at — so a null one is " +
            "something the type already survives, and C hands them back all day.\n\n" +
            "A `string` and a `T[]` are one word too, and are deliberately not in " +
            "that set: they **own** a heap buffer, so a null one would reach the drop " +
            "pass at the end of its scope and be released like any other. An empty " +
            "string or an empty array is the value that means \"nothing\" for those.\n\n" +
            "A `Reference<T>` is left out for a different reason. It is bound once " +
            "and read through without asking, which is the whole content of the type; " +
            "`tryCast` is what produces a nullable one, and its result is checked " +
            "before it is used.\n\n" +
            "Nullability itself is entirely tsc's. `Pointer<T> | null` erases to the " +
            "same machine type as `Pointer<T>`, so the null costs no representation " +
            "and the check that comes before the use is a comparison against zero.",
    },

    // -- Layout and the C boundary -------------------------------------------
    GF0301: {
        title: "this type cannot cross the C boundary",
        explanation:
            "An exported function is called by something outside this build — C, " +
            "another language, or another Goblin build — so its parameters and its " +
            "return have to be things both sides can agree about. A byte copy has to " +
            "*be* the whole copy.\n\n" +
            "A `string` or a `T[]` owns a heap buffer, and nothing at the boundary " +
            "says who frees it. A class carries a vtable pointer, and an interface " +
            "reference a pair of pointers into this build's own tables — addresses " +
            "that mean nothing to anyone else, including a second Goblin build, " +
            "because type descriptors have exactly one owner per compilation.\n\n" +
            "Pass plain data instead: the fixed widths, `boolean`, a struct of those, " +
            "or a `Pointer<T>` and a length. An internal function has no such limit — " +
            "it is only `export` that makes this a boundary.",
    },

    GF0302: {
        title: "this type's layout is not known here",
        explanation:
            "`declare class FILE { private _opaque: never }` is an opaque handle — " +
            "C's incomplete type. `declare` says the implementation lives somewhere " +
            "else, and for a class that means the *layout* does too: this build has " +
            "never seen the fields and cannot know the size or the alignment.\n\n" +
            "A `Pointer<FILE>` is still a perfectly good value. It can be passed, " +
            "returned, stored, compared and checked against null, and `.address` " +
            "works — that is the whole job of a handle, and none of it needs to know " +
            "what is behind the pointer.\n\n" +
            "What is refused is everything that does: `p[i]` and `p.offset(n)` need a " +
            "stride, `p.free()` and `p.freeArray()` need the size and alignment the " +
            "allocator was given, `p.deref()` needs a shape to read through, and " +
            "`alloc`, `allocArray`, `sizeOf` and `alignOf` need the layout by name. " +
            "The library that defines the type is the one that can do those; call the " +
            "function it gives you for it — `fclose`, not `free`.",
    },

    GF0303: {
        title: "a union's members must be plain data",
        explanation:
            "`interface E extends Union` lays every member at offset 0, sharing one " +
            "piece of storage. That is what a C union is, and it is why a member " +
            "cannot own anything.\n\n" +
            "Destroying a value means running the destructor of what it holds. A " +
            "union holds all of its members in the same bytes, and nothing in those " +
            "bytes says which one was last written — so there is no way to know " +
            "whether to release a `string`, free a `T[]`, or do nothing at all. C++ " +
            "answers this by making such a union's destructor deleted and handing the " +
            "problem back to you; here the member is refused instead, at the " +
            "declaration, where there is something to point at.\n\n" +
            "Hold the owning value beside the union rather than inside it, or hold a " +
            "`Pointer<T>` to it — a pointer is plain data, and who frees it is then a " +
            "question the code asks out loud.",
    },

    GF0304: {
        title: "a union cannot be built from an object literal",
        explanation:
            "An object literal supplies every property, and a union has room for " +
            "exactly one. Writing `{ type: 1, key: … }` asks for two members to be " +
            "live in bytes that can only hold one, and there is no sensible reading " +
            "of which wins.\n\n" +
            "A union is zero-initialised and then filled. `zeroed<SDL_Event>()` gives " +
            "all-zero bytes, which is a valid starting state for every member:\n\n" +
            "    let event = zeroed<SDL_Event>();\n" +
            "    event.type = SDL_EventType.Quit;\n\n" +
            "A C function that fills one needs a *pointer* to it, and there is no way " +
            "to take the address of a local. `alloc` is how that one goes, and the " +
            "pointer reaches the members directly:\n\n" +
            "    const event = alloc<SDL_Event>();\n" +
            "    while (SDL_PollEvent(event)) { … }\n" +
            "    event.free();\n\n" +
            "Assign to a single member if you need to build one yourself: " +
            "`e.type = SDL_EventType.Quit` writes the member you name and leaves the " +
            "rest of the storage alone, which is exactly what C does.",
    },

    GF0305: {
        title: "an erased pointer has nothing behind it",
        explanation:
            "`Pointer<unknown>` is C's `void *`: an address whose type has been " +
            "deliberately thrown away. It is the language's only type-erased pointer " +
            "and the only escape hatch in the ambient surface, and it exists because " +
            "C's own signatures need one — `memcpy`, a callback's userdata, a " +
            "property bag.\n\n" +
            "A pointer to a concrete type may become one implicitly, exactly as `T *` " +
            "converts to `void *` in C. What it cannot do is anything that needs to " +
            "know what is there: `p[i]` and `p.offset(n)` need a stride, `p.free()` " +
            "and `p.freeArray()` need a destructor to run and — for a run — a count " +
            "of how many times to run it, and `p.deref()` needs a shape to read " +
            "through.\n\n" +
            "`free` is the one whose reason is worth stating outright, because it is " +
            "not the storage. `gf_free` takes a pointer and nothing else: mimalloc is " +
            "asked what a block was, so the bytes really would go back correctly. " +
            "What cannot happen is the destructor. An erased pointer has no type to " +
            "run one from, so a `string` field would go unreleased and a class would " +
            "never reach its own `delete` — a silent leak rather than a corrupt heap, " +
            "and refused all the same. C++ makes `delete (void *)p` undefined for " +
            "exactly this reason.\n\n" +
            "Attach the type back before doing any of it — `p.reify<Rect>()` — or " +
            "free it through whatever allocated it. `.address` still works, and so " +
            "does passing it along, which is the whole job of an erased pointer.",
    },

    GF0306: {
        title: "a pointer cannot be reinterpreted without erasing it first",
        explanation:
            "`reify<U>()` attaches a pointee type to an erased pointer. tsc lets it " +
            "be written on any pointer, because it is declared on `CorePointer<T>` " +
            "and there is no way to say \"only when `T` is erased\" in the " +
            "declaration — so the compiler is what says it.\n\n" +
            "There is deliberately no unchecked cast between two concrete pointee " +
            "types. `p.reify<Other>()` on a `Pointer<Rect>` is C++'s " +
            "`reinterpret_cast`, and the rule is that it has to be *visible*: write " +
            "`p.erase().reify<Other>()`, and the erasure is there in the source at " +
            "the site that depends on it rather than hidden in a one-token method " +
            "call that looks like a conversion.",
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
    GF9006: {
        title: "an exported signature has no C spelling",
        explanation:
            "A library target emits a C header for everything it exports, and one of " +
            "those signatures mentions a type C cannot name — something that owns a " +
            "buffer, or carries a vtable.\n\n" +
            "The ABI classifier refuses those at the boundary, so reaching this means " +
            "the classifier and the header generator disagree about what may cross. " +
            "That is a compiler bug rather than a problem with the program.",
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
