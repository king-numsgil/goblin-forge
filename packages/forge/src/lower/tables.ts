/**
 * The tables lowering reads: prelude symbol names, runtime entry points, and
 * the operator maps.
 *
 * Split out because they are *data*, and data that a reader wants to scan
 * rather than step through. Nothing here calls anything; if a table starts
 * wanting a helper, it has stopped being a table.
 */

import type { BinOp, IntTy, UnwindAction } from "@goblin-forge/backend";
import { erase, type Operator, type ScalarName } from "@goblin-forge/checker";
import ts from "typescript";

export const NO_UNWIND: UnwindAction = {kind: "Unreachable"};

/** The intrinsic that spells a width conversion. */
export const NATIVE_CAST = "cast";
/** The intrinsic that spells "hand this value's ownership somewhere else". */
export const MOVE = "move";
/** The intrinsic that builds a `FixedArray<T, N>`. */
export const FIXED_ARRAY = "fixedArray";
/** `tryCast<T>(value)` — a checked downcast, `null` when the answer is no. */
export const TRY_CAST = "tryCast";
/** `cstring(s)` — borrow a `string`'s bytes as a raw `const char *`. */
export const CSTRING = "cstring";
/** `cstringFree(c)` — release one that came from a Goblin `string`. */
export const CSTRING_FREE = "cstringFree";
/** `alloc(C, …)` — construct a `C` on the heap. C++'s `new C(…)`. */
export const ALLOC = "alloc";
/** `allocArray<T>(n)` — a run of `n` default-initialised `T`. C++'s `new T[n]`. */
export const ALLOC_ARRAY = "allocArray";
/** `sizeOf<T>()` and `alignOf<T>()` — the layout, as constants. */
export const NATIVE_SIZE_OF = "sizeOf";
export const NATIVE_ALIGN_OF = "alignOf";
export const NATIVE_ZEROED = "zeroed";
/** `stringFromCString(p)` — copy a `const char *` into a managed `string`. */
export const STRING_FROM_CSTRING = "stringFromCString";
/** `stringFromBytes(p, n)` — the same copy, with the length already known. */
export const STRING_FROM_BYTES = "stringFromBytes";

/** `p.address` — the pointer's bits, as a `usize`. */
export const POINTER_ADDRESS = "address";

/**
 * The prelude's ambient modules, and the `extern "C"` symbol behind each name.
 *
 * Everything the prelude declares *globally* is a name this file recognises and
 * lowers itself. These eight are the exception: mimalloc's own entry points,
 * already in every binary because the runtime allocates through them, published
 * under their C names so a library that lets its allocator be replaced can be
 * handed the program's own heap.
 *
 * Keyed by **module specifier first**, because that is what an ambient module
 * buys over a global: `mi_malloc` is only this `mi_malloc` when it came from
 * `"std/alloc"`. A flat table of names would match a declaration of the same
 * name in any `.d.ts` the project happens to include, and quietly redirect a
 * user's own `extern` to the runtime's trampoline.
 *
 * An **allowlist**, rather than "any declaration in the module that no
 * intrinsic claims", because what matters is how the rule fails. A new name
 * added to the prelude and not yet lowered should be `GF0001` with a caret
 * under it; under a general fallback it would instead be an unresolved external
 * from the linker, with no file and no line — the shape of error
 * REWRITE-PLAN §8 exists to stop.
 *
 * The value is the symbol actually called, and it is deliberately not the name
 * written. `mi_malloc` is the spelling because it has to type-check against a
 * signature C wrote; `gf_mi_malloc` is a thin trampoline in the runtime,
 * because a cdylib exports the Rust symbols it defines and does *not*
 * re-export C symbols reaching it from a native static library — a difference
 * that has three per-platform workarounds, one of which is a hard link error
 * on Mach-O. A Rust symbol needs no workaround on any of them.
 */
export const STD_MODULES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
    [
        "std/alloc",
        new Map([
            ["mi_malloc", "gf_mi_malloc"],
            ["mi_calloc", "gf_mi_calloc"],
            ["mi_realloc", "gf_mi_realloc"],
            ["mi_free", "gf_mi_free"],
            ["mi_zalloc", "gf_mi_zalloc"],
            ["mi_malloc_aligned", "gf_mi_malloc_aligned"],
            ["mi_realloc_aligned", "gf_mi_realloc_aligned"],
            ["mi_usable_size", "gf_mi_usable_size"],
        ]),
    ],
]);

/**
 * The methods `CorePointer<T>` declares.
 *
 * Recognised as a *set* rather than one name at a time, and resolved before the
 * class path in both passes, because `Pointer<C>` is `C & CorePointer<C>`: a
 * name in here reached through a pointer would otherwise be looked for on the
 * pointee. `RESERVED_ON_POINTER` in `classes.ts` is the other half of that
 * bargain — a class may not declare any of them, so this always winning is
 * never a silent shadow.
 */
export const POINTER_METHODS: ReadonlySet<string> = new Set([
    "free",
    "freeArray",
    "deref",
    "offset",
    "erase",
    "reify",
]);

/**
 * Runtime entry points the lowerer names directly.
 *
 * These are declared as ordinary `extern "C"` imports and called with ordinary
 * `Call` terminators, because that is what they are — there is no privileged
 * channel into the runtime. It also means they show up in a MIR dump, which is
 * where you want to see that `console.log` of an `i32` became a conversion and
 * a print rather than something magic.
 */
export const RUNTIME = {
    /**
     * Called once at the top of a `bin`'s `main`, before its first statement.
     *
     * A call rather than a platform constructor, because a constructor in a
     * static library is only linked when something else in its object already is
     * — so a program that allocated nothing would silently not have one, which is
     * exactly the program whose leak report has to be trustworthy.
     */
    init: "gf_runtime_init",
    print: "gf_print",
    eprint: "gf_eprint",
    fromI64: "gf_string_from_i64",
    fromU64: "gf_string_from_u64",
    fromF64: "gf_string_from_f64",
    fromBool: "gf_string_from_bool",
    stringFree: "gf_string_free",
    /**
     * `gf_array_pop(a)` — forget the last element, after it has been taken.
     *
     * The one array operation with no node of its own: shortening needs neither
     * a stride nor an alignment, so the frontend can name it directly.
     */
    arrayPop: "gf_array_pop",
    /**
     * `gf_alloc(size, align)` and `gf_free(p)` — raw storage.
     *
     * The runtime hands out and takes back bytes; constructing and destroying
     * what goes in them is the backend's, which is why the size and alignment
     * are arguments rather than something a type parameter would supply.
     *
     * The asymmetry is the allocator's. mimalloc is *asked* what a block was, so
     * only the way in needs a layout — and the way out has no number a call site
     * could compute differently from the one that allocated it.
     */
    alloc: "gf_alloc",
    free: "gf_free",
    /**
     * `new T[n]` and `delete[]`, with the count in a cookie behind the pointer.
     *
     * The count has to survive the allocation because `freeArray` is given only a
     * pointer and needs something it does not carry: how many destructors to run.
     * C++ writes the cookie only when the destructor is non-trivial, since
     * `operator delete[]` can ask the allocator how big the block was — and this
     * one could ask too, but a byte count is not an element count, so the cookie
     * is written unconditionally and `gf_alloc_array_count` reads it back.
     */
    allocArray: "gf_alloc_array",
    allocArrayCount: "gf_alloc_array_count",
    freeArray: "gf_free_array",
    /**
     * `gf_string_from_cstr(p)` — `strlen`, allocate, copy, NUL-terminate.
     *
     * The one direction that has to copy. A `CString` has no header, so it cannot
     * be adopted as a `string`; the length would have nowhere to live.
     */
    fromCString: "gf_string_from_cstr",
    /**
     * `gf_string_from_bytes(p, n)` — allocate, copy `n` bytes, NUL-terminate.
     *
     * The same copy without the scan, for the case where the length is already
     * known — which at a C boundary is most of them, because the length arrived
     * in the same call as the pointer.
     */
    fromBytes: "gf_string_from_bytes",
    /**
     * `gf_args(argc, argv)` — the platform's arguments, as an owned `string[]`.
     *
     * In the runtime because the elements do not come from the program: each is
     * a C string of the platform's that has to be copied before anything here can
     * own it. What comes back is an ordinary array handle.
     */
    args: "gf_args",
} as const;

/** `console` methods, and which stream each writes to. */
export const CONSOLE_METHODS: Partial<Record<string, "out" | "err">> = {
    log: "out",
    info: "out",
    debug: "out",
    warn: "err",
    error: "err",
};

export const INT_TY: Record<Exclude<ScalarName, "f32" | "f64">, IntTy> = {
    i8: "I8",
    i16: "I16",
    i32: "I32",
    i64: "I64",
    u8: "U8",
    u16: "U16",
    u32: "U32",
    u64: "U64",
    isize: "Isize",
    usize: "Usize",
};

/** How an operator is written, keyed by the token tsc produces. */
export const OPERATOR_TOKENS: Partial<Record<ts.SyntaxKind, Operator>> = {
    [ts.SyntaxKind.PlusToken]: "+",
    [ts.SyntaxKind.MinusToken]: "-",
    [ts.SyntaxKind.AsteriskToken]: "*",
    [ts.SyntaxKind.SlashToken]: "/",
    [ts.SyntaxKind.PercentToken]: "%",
    [ts.SyntaxKind.AmpersandToken]: "&",
    [ts.SyntaxKind.BarToken]: "|",
    [ts.SyntaxKind.CaretToken]: "^",
    [ts.SyntaxKind.LessThanLessThanToken]: "<<",
    [ts.SyntaxKind.GreaterThanGreaterThanToken]: ">>",
    [ts.SyntaxKind.LessThanToken]: "<",
    [ts.SyntaxKind.LessThanEqualsToken]: "<=",
    [ts.SyntaxKind.GreaterThanToken]: ">",
    [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===",
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
};

/**
 * `a += b` and the rest, as the operator they apply.
 *
 * Only the operators that produce a *value* of the operand type appear here: a
 * comparison has no compound form to spell, and `&&=` / `||=` / `??=` are
 * conditional assignments rather than operators — they write only sometimes,
 * which is control flow and not this table's shape.
 */
export const COMPOUND_TOKENS: Partial<Record<ts.SyntaxKind, Operator>> = {
    [ts.SyntaxKind.PlusEqualsToken]: "+",
    [ts.SyntaxKind.MinusEqualsToken]: "-",
    [ts.SyntaxKind.AsteriskEqualsToken]: "*",
    [ts.SyntaxKind.SlashEqualsToken]: "/",
    [ts.SyntaxKind.PercentEqualsToken]: "%",
    [ts.SyntaxKind.AmpersandEqualsToken]: "&",
    [ts.SyntaxKind.BarEqualsToken]: "|",
    [ts.SyntaxKind.CaretEqualsToken]: "^",
    [ts.SyntaxKind.LessThanLessThanEqualsToken]: "<<",
    [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ">>",
};

/** How an operator is spelled in the MIR. */
export const MIR_OPS: Record<Operator, BinOp> = {
    "+": "Add",
    "-": "Sub",
    "*": "Mul",
    "/": "Div",
    "%": "Rem",
    "&": "BitAnd",
    "|": "BitOr",
    "^": "BitXor",
    "<<": "Shl",
    ">>": "Shr",
    "<": "Lt",
    "<=": "Le",
    ">": "Gt",
    ">=": "Ge",
    "===": "Eq",
    "!==": "Ne",
};
