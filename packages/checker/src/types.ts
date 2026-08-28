/**
 * Type erasure: `ts.Type` to a concrete, sized machine type.
 *
 * This is the only place that knows how the ambient prelude encodes machine
 * types, and it is the last place a `ts.Type` is seen. Everything downstream —
 * lowering, MIR, Cranelift — works with sized types and never asks tsc anything
 * again.
 *
 * The reading is done off the *brands*, not off the alias names. A type that
 * arrived through an alias chain or a generic instantiation is still recognised,
 * and — more to the point — the brand keys are `unique symbol`s, so no source
 * file can spell one and claim a width it does not have.
 */

import ts from "typescript";

import {
    columnTypeOf,
    LINALG_MODULE,
    LINALG_TYPES,
    type LinalgType,
    linalgStructName,
} from "./linalg.ts";

/** The twelve fixed widths. */
export const SCALARS = [
    "i8",
    "i16",
    "i32",
    "i64",
    "u8",
    "u16",
    "u32",
    "u64",
    "f32",
    "f64",
    "isize",
    "usize",
] as const;

export type ScalarName = (typeof SCALARS)[number];

const SCALAR_SET: ReadonlySet<string> = new Set<string>(SCALARS);

/**
 * A machine type, erased.
 *
 * Deliberately *not* the MIR's `TyKind`: that one is generated from Rust and
 * carries ids into a module-level table, which is a thing the lowerer builds.
 * This is the shape tsc's answer takes on the way there.
 */
export type MachineType =
    | { readonly kind: "void" }
    | { readonly kind: "bool" }
    | { readonly kind: "scalar"; readonly name: ScalarName }
    | { readonly kind: "string" }
    | {
          /**
           * `CString`: a raw `const char *`. The borrowed half of the string pair,
           * and the type the compiler deliberately does not track.
           */
          readonly kind: "cstring";
      }
    | { readonly kind: "array"; readonly element: MachineType }
    | {
          /** `FixedArray<T, N>`: `N` elements, inline, no allocation. */
          readonly kind: "fixedArray";
          readonly element: MachineType;
          readonly length: number;
      }
    | {
          /**
           * `(a: i32) => i32` — a code address, and nothing else.
           *
           * One machine word, owning nothing, and **always classified by the C
           * rules**. That is not a simplification to be lifted later: a function
           * pointer's whole purpose is that both sides of a call agree about the
           * signature without sharing a declaration, and C's classification is the
           * only one anything outside this build knows. A function whose address
           * is taken is emitted C-classified for the same reason.
           *
           * There is no environment here. A capturing closure is a different type
           * with a different representation, and it is not implemented.
           */
          readonly kind: "fnptr";
          readonly params: readonly MachineType[];
          readonly returns: MachineType;
      }
    | {
          /**
           * `LocalFn<F>` — a code address *and* an environment, two words, where
           * the environment lives in the frame that built the closure.
           *
           * Category `Borrow` (DECISIONS §18): it owns nothing, copies with a
           * `memcpy`, and destroys nothing, because everything it captures is
           * still owned by the frame it was captured from. That is sound for
           * exactly one reason — the value may not outlive the call it was
           * passed to — and enforcing that is the frontend's whole job here.
           *
           * The escaping form is a different type with a different
           * representation, and it is not implemented.
           */
          readonly kind: "localfn";
          readonly params: readonly MachineType[];
          readonly returns: MachineType;
      }
    | { readonly kind: "pointer"; readonly pointee: MachineType }
    | { readonly kind: "reference"; readonly referent: MachineType }
    | {
          /**
           * A named aggregate. Fields are laid out in declaration order, naturally
           * aligned, never reordered, and nested aggregates are **inline** — the
           * bytes match what a C compiler produces for the same declaration.
           */
          readonly kind: "struct";
          readonly name: string;
          readonly fields: readonly StructField[];
          /**
           * A C `union` — written `interface E extends Union`.
           *
           * A flag rather than a `kind` of its own, because a union is a struct
           * everywhere but the offsets: the same fields, the same projections, the
           * same nominal identity. Only the layout engine and the two rules that
           * differ (plain-data members, no object literal) read it.
           */
          readonly union?: boolean;
      }
    | {
          /**
           * `Reference<I>` for a *contract* — an interface carrying at least one
           * method signature. The two-word `(itab, data)` pair.
           *
           * A contract has no value form, so there is no separate `MachineType` for
           * one: `I` on its own is rejected, and this is what `Reference<I>` erases
           * to. An interface of pure data members is a `struct` and never reaches
           * here (DECISIONS §11.2).
           */
          readonly kind: "interface";
          readonly name: string;
          readonly methods: readonly InterfaceMethod[];
      }
    | {
          /**
           * A class instance.
           *
           * Only the name is carried. Unlike a struct, a class has an *identity*
           * beyond its shape — two classes with the same fields are different
           * types, they have different vtables, and one is not assignable to the
           * other. The lowerer holds the fields, the base and the vtable in its own
           * registry, keyed by this name.
           *
           * For a generic class the name carries the type arguments —
           * `Box<i32>` — because `Box<i32>` and `Box<f64>` are different
           * classes with different layouts and different vtables.
           */
          readonly kind: "class";
          readonly name: string;
          /**
           * The erased type arguments, for a generic class's instantiation.
           *
           * Absent for an ordinary class. Present so the lowerer can build the
           * instantiation's `ClassInfo` on demand: the name says *which*
           * instantiation, and this says what to substitute.
           */
          readonly args?: readonly MachineType[];
      }
    | {
          /**
           * A type declared elsewhere, whose layout this build does not know.
           *
           * `declare class FILE { private _opaque: never }` — C's incomplete type.
           * A `declare` says the implementation is somewhere else, and for a class
           * that means the *layout* is somewhere else too, so there is nothing here
           * to lay out and nothing to construct.
           *
           * It has no value form. The only thing it can appear as is the pointee of
           * a `Pointer<T>`, which is one machine word whatever it points at, and
           * every operation that would need the layout is refused with a code and a
           * line. The private member in the idiom above is tsc's business, not this
           * compiler's: it is what stops two handles converting to each other.
           */
          readonly kind: "opaque";
          readonly name: string;
      };

export interface StructField {
    readonly name: string;
    readonly type: MachineType;
}

/** One method of a contract, with the slot it dispatches through. */
export interface InterfaceMethod {
    readonly name: string;
    readonly params: readonly MachineType[];
    readonly returns: MachineType;
}

/**
 * What each of a generic's type parameters actually is, at one instantiation.
 *
 * Keyed by the type parameter's **symbol**, so an imported generic is the same
 * generic however the import spelled it — the argument `resolveCallee` already
 * makes for functions, one level up.
 *
 * **To a {@link MachineType}, not to a `ts.Type`.** The type argument is erased
 * at the *use site*, under whatever substitution was in force there, so by the
 * time it is in here it is concrete and nothing ever has to resolve it again.
 *
 * That is not an optimisation, it is the only thing that works. Binding to the
 * `ts.Type` fails on a type argument that *mentions* the enclosing generic's
 * own parameter: inside `grow<T>`, the call `grow<Wrap<T>>` binds the new `T`
 * to `Wrap<T>` — whose own `T` is still a type parameter, and one the new
 * substitution maps back to a type containing it. Erasing that walks `Wrap`
 * into `Wrap` with nothing crossed and comes out as "a value cannot contain
 * itself", a true sentence about a type nobody wrote. Nothing short of
 * instantiating the `ts.Type` fixes it and tsc exports no way to do that — but
 * erasing one level at a time, at each use site, arrives at the same place
 * without needing to.
 *
 * The `ts.Type` was carried alongside for a while, on the theory that erasure
 * is not the only question asked about a type. It turned out to be dead weight:
 * everything that asks — `classNameAt`, `contractAt` — wants the *machine*
 * answer, because the machine answer is the one the substitution made concrete.
 *
 * The substitution is applied at the **leaf**, in {@link erase}, and that is
 * the whole of why monomorphisation is a small change here. `erase` already
 * takes a type apart structurally — `T[]` through `getIndexTypeOfType`,
 * `Pointer<T>` through `pointeeOf`, `Pair<T>` through `getPropertiesOfType` —
 * so every composite reaches a bare `T` on its own, and one case at the top of
 * the cascade answers for all of them.
 */
export type Substitution = ReadonlyMap<ts.Symbol, MachineType>;

/** Not inside a generic. The common case, and every caller outside lowering. */
export const NO_BINDINGS: Substitution = new Map<ts.Symbol, MachineType>();

/** Raised when a type is legal TypeScript but outside the language. */
export class ErasureError extends Error {
    constructor(
        message: string,
        readonly code: string,
        readonly node?: ts.Node,
    ) {
        super(message);
        this.name = "ErasureError";
    }
}

/**
 * What one erasure has already answered, and what it is still answering.
 *
 * `struct Node { struct Node *next; }` is an ordinary C shape, and it has no
 * finite spelling as a *tree* — so the erasure of one is a **graph**. The
 * machine type a cycle closes on is the very object being built, handed back
 * before its fields are in it, and the result is a `MachineType` that contains
 * itself somewhere below a `pointer`.
 *
 * That is safe because of the rule the rest of the file already keeps: an
 * aggregate is **nominal**, and everything that walks a type stops at its name.
 * `sameType` compares structs by name, `renderType` prints one, `needsDrop`
 * never looks through a pointer, and the lowerer interns by name too. Nothing
 * follows a cycle round, so nothing has to know it is in one. Adding a walk that
 * recurses through `pointee` into a struct's fields is what would break this,
 * and there is no reason to write one: a pointer is a machine word whatever is
 * behind it.
 *
 * The other half of the job is telling the legal cycle from the two that are
 * not, and the difference is *what was crossed* on the way round:
 *
 * | Crossed | `Node` again | Verdict |
 * |---|---|---|
 * | nothing | `self: Node` | `GF0307` — a value as large as itself and then larger |
 * | only buffers it owns | `kids: Node[]` | `GF0001` — a gap; see {@link Erasure.buffer} |
 * | an address | `next: Pointer<Node>` | a shape, and the point of all this |
 *
 * Both refusals are here rather than further downstream because here is where
 * the cycle is *visible*. Neither would announce itself later: the first is a
 * layout pass recursing until the stack ends, and the second is a drop that
 * inlines a copy of itself, forever.
 */
export class Erasure {
    /**
     * What this erasure's type parameters are bound to, if it is inside a
     * generic instantiation. Empty for every other erasure, which is most.
     *
     * It lives here rather than being threaded as its own argument because
     * `state` already reaches every recursive step, and a substitution that
     * some steps had and others did not would be a substitution applied in
     * some positions and not others — which is the silent half of getting this
     * wrong.
     */
    readonly bindings: Substitution;

    constructor(bindings: Substitution = NO_BINDINGS) {
        this.bindings = bindings;
    }

    /** The answer for every aggregate this erasure has reached. */
    readonly #answers = new Map<ts.Type, MachineType>();

    /** For each aggregate still being erased, the depths it was opened at. */
    readonly #openedAt = new Map<ts.Type, { indirections: number; buffers: number }>();

    /** How many indirections have been crossed to get here. */
    #indirections = 0;

    /** How many of those were buffers the enclosing value owns. */
    #buffers = 0;

    /**
     * Erase something the type around it only *points at*.
     *
     * The count is the whole of what makes a `Pointer<Node>` legal as a field of
     * `Node` and a bare `Node` not. Both close a cycle; only one of them crosses
     * something whose size does not depend on what is behind it.
     */
    through<T>(erasing: () => T): T {
        this.#indirections += 1;
        try {
            return erasing();
        } finally {
            this.#indirections -= 1;
        }
    }

    /**
     * Erase the element of a buffer the enclosing value **owns** — a `T[]`.
     *
     * An indirection like any other as far as the layout goes: the handle is one
     * machine word, so `kids: Node[]` is a `Node` with a size. It is counted
     * separately because copying and releasing one are not: destroying a `Node[]`
     * destroys every element, and if an element is a `Node` that is a loop the
     * backend writes *inline*, so the code for the drop would contain the code
     * for the drop. That is a missing feature — out-of-line copy and drop glue,
     * which is exactly how `std::vector<T>` inside `T` works in C++ — and it is
     * reported as one.
     */
    buffer<T>(erasing: () => T): T {
        this.#buffers += 1;
        try {
            return this.through(erasing);
        } finally {
            this.#buffers -= 1;
        }
    }

    /**
     * Register the object a cycle back to `type` will close on, then fill it in.
     *
     * Registered *before* `fill` runs, which is what closes the cycle, and left
     * registered afterwards, which is what makes two fields of the same type one
     * erasure rather than two. `fill` must push into the array the answer was
     * built around rather than replace it — the cycle is already holding it.
     */
    aggregate(type: ts.Type, answer: MachineType, fill: () => void): MachineType {
        this.#answers.set(type, answer);
        this.#openedAt.set(type, {indirections: this.#indirections, buffers: this.#buffers});
        try {
            fill();
        } finally {
            this.#openedAt.delete(type);
        }
        return answer;
    }

    /**
     * The answer for a type this erasure has already reached, or `null`.
     *
     * Throws for the two cycles that have no representation — see the table on
     * {@link Erasure}. Both are asked as "what has been crossed since this type
     * was opened", which is why the counts are saved rather than flags set: a
     * *sibling* field erased after a pointer field must not inherit its answer.
     */
    answered(type: ts.Type): MachineType | null {
        const answer = this.#answers.get(type);
        if (answer === undefined) {
            return null;
        }
        const opened = this.#openedAt.get(type);
        if (opened === undefined) {
            return answer;
        }

        const name = renderType(answer);
        const crossed = this.#indirections - opened.indirections;
        if (crossed === 0) {
            throw new ErasureError(
                `\`${name}\` contains itself by value. Fields are laid out inline — that ` +
                "is what makes the bytes match C's — so a value of this type would have " +
                `to be as large as itself and then larger. Hold a \`Pointer<${name}>\` ` +
                "instead, which is one machine word whatever is behind it, and is how C " +
                "writes the same shape.",
                "GF0307",
            );
        }
        if (crossed === this.#buffers - opened.buffers) {
            throw new ErasureError(
                `\`${name}\` holds more of itself in a \`${name}[]\`, and copying or ` +
                "releasing one of those is a loop over the elements that the compiler " +
                "writes inline — so the code for the copy would have to contain the code " +
                "for the copy, and there is no end to it.\n\n" +
                "This is a gap rather than a rule: it wants the copy and the drop to be " +
                "*functions* that call themselves, which is how `std::vector<T>` inside " +
                `\`T\` works in C++. Until then, an array of \`Pointer<${name}>\` holds ` +
                "the same shape with the freeing written out, and a `class` works today " +
                "because its destructor is already a function rather than something " +
                "spliced in at each site.",
                "GF0001",
            );
        }
        return answer;
    }
}

/**
 * Find a property whose key is a particular `unique symbol`.
 *
 * A symbol-keyed property has no nameable name — TypeScript mangles it to
 * `__@Brand@<id>`, where the id shifts between builds. But the computed key is
 * still an expression, it resolves to the brand's symbol, and *that* is stable
 * and public. This is what makes an unforgeable brand readable from here.
 */
function brandedProperty(
    checker: ts.TypeChecker,
    type: ts.Type,
    brand: string,
): ts.Symbol | null {
    for (const property of checker.getPropertiesOfType(type)) {
        const declaration = property.declarations?.[0] as ts.NamedDeclaration | undefined;
        const name = declaration?.name;
        if (!name || !ts.isComputedPropertyName(name)) {
            continue;
        }
        if (checker.getSymbolAtLocation(name.expression)?.name === brand) {
            return property;
        }
    }
    return null;
}

/**
 * The width behind a type's `WidthBrand`, or `null` if it has none.
 *
 * All twelve widths share the one key and differ only in the string literal
 * behind it. That is load-bearing and is the thing most likely to be
 * "simplified": a *different* key per width would leave every brand optional
 * and *absent* from the others, optional-and-absent is assignable, and the
 * widths would silently unify.
 */
export function scalarName(checker: ts.TypeChecker, type: ts.Type): ScalarName | null {
    const brand = brandedProperty(checker, type, "WidthBrand");
    if (!brand) {
        return null;
    }

    const branded = checker.getNonNullableType(checker.getTypeOfSymbol(brand));
    if (branded.isStringLiteral() && SCALAR_SET.has(branded.value)) {
        return branded.value as ScalarName;
    }
    return null;
}

export function isPointerType(checker: ts.TypeChecker, type: ts.Type): boolean {
    return brandedProperty(checker, type, "PointerBrand") !== null;
}

export function isReferenceType(checker: ts.TypeChecker, type: ts.Type): boolean {
    return brandedProperty(checker, type, "ReferenceBrand") !== null;
}

export function isCStringType(checker: ts.TypeChecker, type: ts.Type): boolean {
    return brandedProperty(checker, type, "CStringBrand") !== null;
}

/**
 * The type parameter a type **is**, seeing through what tsc leaves behind.
 *
 * A bare `T` is the easy case. The one that matters is `T | (T & {})`, which is
 * what comes back from asking a `Pointer<T>` what it points at when `T` is a
 * type parameter — the prelude spells `Pointer` as a conditional type (for the
 * enum-distribution reason `global.d.ts` documents at length), tsc cannot
 * resolve a conditional over an unresolved `T`, so it keeps *both* branches and
 * both of them say `T`. Read naively that is a union of two real types, which
 * this language does not have, and `alloc<T>()` inside a generic came back as
 * "`T | (T & {})` has no machine representation" — a message naming a type
 * nobody wrote.
 *
 * `{}` is skipped rather than matched, because it is what `NonNullable<T>`
 * leaves; every other member has to be the same parameter, so a genuine union
 * of two types still answers `undefined` and is refused where it always was.
 *
 * This does **not** make `Pointer<T>` usable inside a generic body, and is not
 * meant to: `p.deref()` and `p.store(v)` are rejected by tsc first, for the
 * same conditional-type reason. It makes the erasure honest for the operations
 * that do get past tsc, of which `alloc<T>()` is the useful one.
 */
export function typeParameterSymbolOf(type: ts.Type): ts.Symbol | undefined {
    if ((type.getFlags() & ts.TypeFlags.TypeParameter) !== 0) {
        // **The flag is not enough.** `this` inside a class body carries it too
        // — tsc models the polymorphic this-type as a type parameter, and its
        // symbol is the *class*. Answering with that made `this` inside
        // `Box<T>` look like an unbound parameter, so every `this.field` in a
        // generic class came back as "not supported", pointing inside the class
        // rather than at anything anybody wrote.
        //
        // So the declaration decides, not the flag: a real type parameter is
        // declared by a `<T>`.
        return type.symbol?.declarations?.some(ts.isTypeParameterDeclaration) === true
            ? type.symbol
            : undefined;
    }
    // A *substitution type*: tsc's note-to-itself that inside the true branch
    // of `[T] extends [X] ? … : …`, this `T` is additionally known to satisfy
    // `X`. It prints as `T`, it is `T`, and it does not carry the type
    // parameter flag — which is why `Pointer<T>`'s pointee came back as a union
    // of two things that both said `T` and neither of which matched.
    if ((type.getFlags() & ts.TypeFlags.Substitution) !== 0) {
        return typeParameterSymbolOf((type as ts.SubstitutionType).baseType);
    }
    if (!type.isUnionOrIntersection()) {
        return undefined;
    }
    let found: ts.Symbol | undefined;
    for (const part of type.types) {
        if (isEmptyObjectType(part)) {
            continue;
        }
        const symbol = typeParameterSymbolOf(part);
        if (symbol === undefined || (found !== undefined && found !== symbol)) {
            return undefined;
        }
        found = symbol;
    }
    return found;
}

/** `{}` — what `NonNullable<T>` reduces to for an unresolved `T`. */
function isEmptyObjectType(type: ts.Type): boolean {
    return (
        (type.getFlags() & ts.TypeFlags.Object) !== 0 &&
        type.getProperties().length === 0 &&
        type.getCallSignatures().length === 0 &&
        type.getConstructSignatures().length === 0 &&
        type.getStringIndexType() === undefined &&
        type.getNumberIndexType() === undefined
    );
}

/**
 * Erase a `ts.Type`.
 *
 * Throws {@link ErasureError} rather than returning a diagnostic, because the
 * caller always has a node to attach and this function usually does not.
 *
 * `state` is this erasure's memory of itself, and every recursive step passes
 * the one it was given: a recursive type is answered once and the answer closes
 * the cycle. A caller that has none is starting a fresh one, which is every
 * caller outside this file — see {@link Erasure}.
 */
export function erase(
    checker: ts.TypeChecker,
    type: ts.Type,
    state: Erasure = new Erasure(),
): MachineType {
    // `Reference<T> | null` — the result of `tryCast`, and the **only** union the
    // language has. It erases to the same machine type as `Reference<T>`, because
    // the null is representable inside the pair itself: a zero itab means "no".
    // So nullability stays entirely tsc's view of the program and reaches neither
    // the MIR nor the backend.
    //
    // Deliberately not a step toward general unions. Anything else with a `|` in
    // it falls through to the ordinary path and is refused.
    const nullable = nullableOf(checker, type);
    if (nullable !== null) {
        return erase(checker, nullable, state);
    }

    // A type this erasure has already answered — which, for one still open, is a
    // cycle closing: `Node` reached from inside `Node`. Asked before anything
    // else, so a recursive type stops here rather than a level further in, and
    // asked of the non-null type above so that `Pointer<Node> | null` and
    // `Pointer<Node>` are the same question.
    const answered = state.answered(type);
    if (answered !== null) {
        return answered;
    }

    // A type parameter, and what this instantiation bound it to. Before the
    // flag cascade below, because a `T` bound to `i32` has to *become* an
    // `i32` before anything asks what an `i32` is.
    //
    // Reaching here with nothing bound means a generic's body is being erased
    // outside any instantiation, which is not a program the compiler should be
    // looking at: a generic is lowered once per set of type arguments and never
    // on its own. It is stated as a gap rather than left to fail further in,
    // because further in it is "`T` has no machine representation", which is
    // true of every `T` and says nothing about what went wrong.
    const flags = type.getFlags();

    const parameter = typeParameterSymbolOf(type);
    if (parameter !== undefined) {
        const bound = state.bindings.get(parameter);
        if (bound === undefined) {
            throw new ErasureError(
                `\`${checker.typeToString(type)}\` is a type parameter, and nothing here ` +
                "says what it is. A generic is compiled once for each set of type " +
                "arguments it is used with, so there is no code to write until some " +
                "call decides.",
                "GF0001",
            );
        }
        // Already erased, at the use site, under the substitution in force
        // there. {@link Substitution} is why re-erasing it here would not be
        // the same thing and does not work.
        return bound;
    }

    if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {
        return {kind: "void"};
    }
    if (flags & ts.TypeFlags.BooleanLike) {
        return {kind: "bool"};
    }

    // -- The wrappers, before the things they wrap ---------------------------
    //
    // `Pointer<T>` is `T & CorePointer<T>` and `FixedArray<T, N>` extends
    // `CorePointer<T>`, so a wrapper's type **carries its pointee's brands as
    // well as its own**. Ask "is this a `CString`?" first and `Pointer<CString>`
    // says yes — it has a `CStringBrand`, because `CString` is one of its
    // intersection members — and a `const char **` erases to a `const char *`.
    //
    // That was silent: both are one machine word, so nothing failed to compile
    // and nothing crashed. `p[i]` strode by the wrong element and the generated
    // header declared one indirection too few.
    //
    // So the order here is a rule, not an accident: **most-wrapping first.** A
    // fixed array before a pointer, because it has both brands and is the more
    // specific of the two; a reference before a pointer, for the same reason;
    // and both before every brand check below, because the brands they carry
    // belong to what is inside them.
    const fixed = fixedArrayOf(checker, type, state);
    if (fixed !== null) {
        return fixed;
    }

    const wrapper = eraseWrapper(checker, type, state);
    if (wrapper !== null) {
        return wrapper;
    }

    const scalar = scalarName(checker, type);
    if (scalar) {
        return {kind: "scalar", name: scalar};
    }

    // Before both `StringLike` and `NumberLike`, because an enum satisfies one or
    // the other and neither answer would be right: a numeric enum would become a
    // widthless `number`, and a *string* enum would quietly become a `string`,
    // which is the one that matters — it would compile, and lay out a heap handle
    // where a set of integer constants was meant.
    const enumWidth = enumUnderlying(checker, type);
    if (enumWidth !== null) {
        return {kind: "scalar", name: enumWidth};
    }

    // Before the `StringLike` check, because a `CString` is an interface and not
    // string-like — but before the object case too, so it never falls through to
    // structural erasure and becomes a nameless struct with a `length` field.
    if (brandedProperty(checker, type, "CStringBrand") !== null) {
        return {kind: "cstring"};
    }

    if (flags & ts.TypeFlags.StringLike) {
        return {kind: "string"};
    }

    // A bare `number` with no brand. tsc cannot tell us the width, which is the
    // hole the width pass exists to close — but at a position where a machine
    // type is needed and no annotation supplied one, there is nothing to infer
    // from and the honest answer is to say so.
    if (flags & ts.TypeFlags.NumberLike) {
        throw new ErasureError(
            "this value is a plain `number` with no fixed width. Annotate it with one " +
            "of the twelve widths (`i32`, `u8`, `f64`, …) so the machine type is " +
            "written down rather than guessed.",
            "GF0161",
        );
    }

    // `dvec3` and its family, before the ambient-class path that would
    // otherwise make them opaque handles. They are written as ambient classes
    // because that is the one declaration giving a type *and* a value — so
    // `new dvec3(…)`, `v.x`, `dvec3.add(a, b)` and `a.add(b)` all come from one
    // place — but their layout is this compiler's rather than someone else's,
    // and it comes from the table instead of from tsc.
    //
    // Asking tsc would not work even if it were wanted: a `dvec3` declares
    // three data members and forty methods, and `contractOf` rejects that
    // mixture outright. Reading the layout from the table is what keeps that
    // rule intact rather than weakened for this one family (DECISIONS §22).
    const linalg = linalgTypeOf(type);
    if (linalg !== null) {
        return linalgStruct(linalg);
    }

    // Before the object case, and before `isArrayType`: a class is nominal, so
    // it must not fall through to structural erasure and become an aggregate
    // that happens to have the same fields.
    // Ambient first: a `declare class` is a handle whose layout lives in someone
    // else's build, and treating it as a class would ask this one to lay out
    // fields it cannot see.
    const opaqueName = ambientClassNameOf(type);
    if (opaqueName !== null) {
        return {kind: "opaque", name: opaqueName};
    }

    const asClass = classOf(checker, type, state);
    if (asClass !== null) {
        return asClass.args === undefined
            ? {kind: "class", name: asClass.name}
            : {kind: "class", name: asClass.name, args: asClass.args};
    }

    // `T[]` and `Array<T>` are one type in TypeScript and one type here: the
    // language's `std::vector`. An owning, growable handle whose elements live
    // inline in a single heap buffer.
    //
    // Checked before the general object path, which would otherwise erase it to a
    // nameless aggregate called `Array` and lay the *interface's* members out as
    // fields.
    if (checker.isArrayType(type)) {
        const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
        if (element === undefined) {
            throw new ErasureError("this array has no element type.", "GF0001");
        }
        // A buffer rather than a plain indirection: one machine word, so the
        // layout is finite, but the elements are this value's to copy and to
        // release. `Erasure.buffer` is where that distinction is spent.
        return {kind: "array", element: state.buffer(() => erase(checker, element, state))};
    }

    // `LocalFn<F>` — the same signature as a function pointer, plus a captured
    // environment. Before the plain call-signature path below, which tests for
    // *no* properties and would fail here: `LocalFn<F>` is `F & LocalFnCore<F>`,
    // and the brand is a property.
    if (brandedProperty(checker, type, "LocalFnBrand") !== null) {
        return {kind: "localfn", ...eraseSignature(checker, type, "a `LocalFn`", state)};
    }

    // `(a: i32) => i32` — a code address. Before `eraseObject`, which would see a
    // type with no properties and lay it out as an empty struct.
    //
    // One call signature and no properties, deliberately: a type with both is a
    // callable object, which needs an environment to be worth anything and is
    // therefore a closure rather than a function pointer.
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    if (calls.length > 0 && checker.getPropertiesOfType(type).length === 0) {
        return {kind: "fnptr", ...eraseSignature(checker, type, "a function pointer", state)};
    }

    if (flags & ts.TypeFlags.Object) {
        return eraseObject(checker, type, state);
    }

    throw new ErasureError(
        `\`${checker.typeToString(type)}\` has no machine representation yet.`,
        "GF0001",
    );
}

/**
 * The parameter and return types of a callable type's one call signature.
 *
 * Shared by `fnptr` and `localfn` so the two cannot drift apart. They differ in
 * what they carry alongside the code address — nothing, and an environment —
 * and not at all in how a signature is read, so a rule relaxed for one of them
 * would otherwise have to be remembered for the other.
 *
 * `what` names the form in the diagnostics, because "a function pointer is one
 * code address" is the right sentence for one of them and the wrong one for the
 * other.
 */
function eraseSignature(
    checker: ts.TypeChecker,
    type: ts.Type,
    what: string,
    state: Erasure,
): {readonly params: readonly MachineType[]; readonly returns: MachineType} {
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    if (calls.length === 0) {
        throw new ErasureError(`${what} needs a call signature, and this type has none.`, "GF0001");
    }
    if (calls.length > 1) {
        throw new ErasureError(
            `an overloaded function type has no single signature to point at. ${what} is ` +
            "one code address and one calling convention.",
            "GF0001",
        );
    }
    const signature = calls[0]!;
    if (signature.getTypeParameters()?.length) {
        throw new ErasureError(
            `a generic function type cannot be ${what}: there is no one body to take the ` +
            "address of.",
            "GF0001",
        );
    }
    return {
        params: signature.getParameters().map((parameter) => {
            const declaration = parameter.valueDeclaration;
            if (declaration === undefined || !ts.isParameter(declaration)) {
                throw new ErasureError(
                    "a parameter of this function type has no declaration to read a type " +
                    "from.",
                    "GF0001",
                );
            }
            if (declaration.questionToken || declaration.dotDotDotToken) {
                throw new ErasureError(
                    "an optional or rest parameter has no C spelling, so it cannot be part " +
                    "of this signature.",
                    "GF0001",
                );
            }
            // **Of the symbol, not of the declaration.** For an *instantiated*
            // signature the parameter's symbol carries the substituted type,
            // while its declaration still reads as it was written — so
            // `Array<i32>.forEach`'s callback erased as `T` rather than `i32`
            // and failed as a type with no machine representation. Identical
            // for a signature with no type parameters, which is every other
            // caller.
            //
            // Through, like the return below: a signature is not part of the
            // layout of whatever mentions it — a code address is one word — so a
            // callback that takes the very type it is a field of is an ordinary
            // shape rather than an infinite one.
            return state.through(() =>
                erase(checker, checker.getTypeOfSymbolAtLocation(parameter, declaration), state),
            );
        }),
        returns: state.through(() =>
            erase(checker, checker.getReturnTypeOfSignature(signature), state),
        ),
    };
}

/**
 * `Reference<T>` and `Pointer<T>`, or `null` when the type is neither.
 *
 * Split out of {@link erase} so that the ordering rule is visible: both are
 * intersections — `T & ReferenceCore<T>`, `T & CorePointer<T>` — so a wrapper
 * carries the brands of what it wraps, and asking about the *contents* first
 * gets a confident wrong answer rather than no answer. A reference is tried
 * before a pointer for the same reason, being the outer one when both appear.
 *
 * Without this the pair also falls through to structural erasure and is
 * reported as a nameless aggregate called `Box & ReferenceCore<Box>`, which is
 * a confusing way to be told no. The lowerer *builds* references (every `this`
 * is one); what is missing is reading one back out of source.
 */
function eraseWrapper(
    checker: ts.TypeChecker,
    type: ts.Type,
    state: Erasure,
): MachineType | null {
    if (isReferenceType(checker, type)) {
        // `Reference<I>` where `I` is a contract is the one reference that *is*
        // implemented, because it is the only way to hold a contract at all. It
        // erases to the `(itab, data)` pair rather than to a reference-to-something.
        const referent = referentOf(checker, type);
        if (referent !== null) {
            // A reference holds an address and never the thing itself — one
            // machine word, or two for a contract — so everything read out of it
            // is read from *behind* an indirection.
            const answer = state.through(() => eraseReferent(checker, referent, state));
            if (answer !== null) {
                return answer;
            }
        }
        throw new ErasureError(
            "this `Reference<T>` has no `T` to read through. A reference is an " +
            "address, so what it points at needs a layout and a size — `void` has " +
            "neither, and a type parameter has neither until some call says what " +
            "it is.",
            "GF0001",
        );
    }

    // `Pointer<T>`: a bare machine address. `T` exists only at compile time,
    // where it supplies the layout to read through and the stride for arithmetic.
    //
    // Spelled as an intersection so that `p.field` and `p.method()` resolve
    // without writing a dereference, which is the same auto-dereference C++
    // spells `->`. The pointee is therefore one member of the intersection rather
    // than the type itself — and for a `Pointer<Pointer<T>>` it is the *merged*
    // brand, `T & CorePointer<T>`, which is why erasing it has to come back
    // through here rather than reading `T` off the front.
    if (!isPointerType(checker, type)) {
        return null;
    }

    const pointee = pointeeOf(checker, type);
    if (pointee === null) {
        throw new ErasureError("this `Pointer<T>` has no pointee type to read through.", "GF0001");
    }
    // `Pointer<unknown>` is C's `void *`. Recognised **here** rather than in the
    // scalar cascade, so that `unknown` is a machine type only in the one
    // position where it means something: a bare `let x: unknown` is still
    // refused, where a general `unknown` → `void` rule would quietly give it a
    // type occupying no bytes.
    //
    // `void` as a pointee has a size of zero and an alignment of one, which is an
    // honest layout for nothing at all and a wrong answer to every question a
    // pointer asks — a stride of nothing, a `dealloc` size of nothing. The
    // frontend refuses all of them (`GF0305`); POINTER-ERASURE.md is the long
    // form of why that is a written refusal rather than a natural one.
    if (pointee.getFlags() & ts.TypeFlags.Unknown) {
        return {kind: "pointer", pointee: {kind: "void"}};
    }
    // The indirection that makes `struct Node { struct Node *next; }` a shape
    // with a size rather than an infinite one: a pointer is a machine word
    // whatever is behind it, so a cycle may close through here.
    return {kind: "pointer", pointee: state.through(() => erase(checker, pointee, state))};
}

/**
 * What a `Reference<T>` erases to, or `null` when `T` has no answer.
 *
 * Its own function so that {@link eraseWrapper} can put the whole of it behind
 * one indirection: everything here is read through an address, and a type that
 * reaches itself this way is `struct Node { struct Node *next; }` rather than a
 * value containing itself.
 *
 * **One machine word, except for a contract.** A reference is an address and
 * nothing else — the same register a `Pointer<T>` occupies, and the same one C++
 * gives a `T&`, which both the Itanium and the MSVC ABI specify as identical to
 * `T*`. What it carries that a pointer does not is entirely a frontend matter:
 * it cannot be null, it cannot be reseated, and a value converts to one
 * implicitly, which is what lets a stack local be passed by address in a
 * language with no `&`. A contract is the exception and is two words, because
 * `(itab, data)` is the only way to hold one at all.
 */
function eraseReferent(
    checker: ts.TypeChecker,
    referent: ts.Type,
    state: Erasure,
): MachineType | null {
    // A `Reference<T>` inside a generic. What `T` is decides every question
    // below — contract or class or shape — so it is answered first, from the
    // machine type this instantiation already erased at its call site.
    //
    // Resolving it here rather than letting `contractOf` see the *constraint*
    // is what makes the dispatch static. `ask<T extends Speaker>` instantiated
    // at `Dog` calls `Dog.speak` directly; reading the constraint instead would
    // build a contract named `T` and dispatch through an itable, which is a
    // working program and the wrong one — the whole claim of monomorphisation
    // is that the copy knows what it was instantiated with.
    const parameter = typeParameterSymbolOf(referent);
    if (parameter !== undefined) {
        const bound = state.bindings.get(parameter);
        return bound === undefined ? null : referenceTo(bound);
    }

    // Before `contractOf`, which would look at `Array<T>`'s declaration and
    // see an interface holding both methods and a data member — the shape
    // that is rejected as ambiguous. `Array` is neither a shape nor a
    // contract; it is a built-in with its own representation, and the same
    // early check `erase` makes for a bare `T[]` has to happen here too.
    if (checker.isArrayType(referent)) {
        return {kind: "reference", referent: erase(checker, referent, state)};
    }

    // `Reference<dvec3>`, for exactly the reason the array check above
    // exists. A `dvec3` declares three data members and forty methods,
    // which is the mixture `contractOf` refuses — and it refuses by
    // *throwing*, so a `Reference<dvec3>` would come back as "cannot be
    // erased" rather than as a reference. That is what a chained
    // `a.addMut(b).scaleMut(2)` produces, and the failure was a call
    // target the compiler said it did not support.
    //
    // Like `Array<T>`, a linear-algebra type is neither a shape nor a
    // contract: it is a built-in whose layout comes from a table
    // (DECISIONS §22), so it answers before the question is asked.
    if (linalgTypeOf(referent) !== null) {
        return {kind: "reference", referent: erase(checker, referent, state)};
    }

    // Before `contractOf` for the third time and the third reason: `String`
    // declares `substring` and friends as method signatures *and* `length` as a
    // data member, so a `Reference<string>` came back as "declares both methods
    // and the data member `length`" — a true sentence about `lib.es5.d.ts` and
    // no help at all to whoever wrote the reference.
    //
    // A gap rather than a rule, and the difference is that copying a `string`
    // is not free: it clones the buffer, so borrowing one is worth doing. What
    // is missing is reading the length or the bytes back through the reference.
    if (referent.getFlags() & ts.TypeFlags.StringLike) {
        throw new ErasureError(
            "a `Reference<string>` is not lowered yet. Copying a `string` clones its " +
            "buffer, so borrowing one is worth doing and this is a gap rather than a " +
            "rule — but nothing reads a `string` back through a reference yet. Pass " +
            "the `string`; the clone is one allocation.",
            "GF0001",
        );
    }

    const contract = contractOf(checker, referent, state);
    if (contract !== null) {
        return contract;
    }
    // `Reference<C>` for a class: one machine word holding the object's
    // address. This is how polymorphism travels — a `Reference<Base>` keeps
    // the dynamic type, where copying to a `Base` value would slice it.
    // A `Reference<T>` is bound once and dereferenced without asking, which
    // needs a layout to read through. An opaque handle has none, and the
    // type that carries an address you may only pass along is `Pointer<T>`.
    const opaqueReferent = ambientClassNameOf(referent);
    if (opaqueReferent !== null) {
        throw new ErasureError(
            `\`${opaqueReferent}\` is declared elsewhere, so this build does not ` +
            `know its layout and a \`Reference<${opaqueReferent}>\` has nothing ` +
            `to read through. Use \`Pointer<${opaqueReferent}>\`, which is an ` +
            "address and nothing more.",
            "GF0302",
        );
    }
    // Through the general path rather than by name, so that a
    // `Reference<Box<i32>>` names the instantiation and carries its arguments
    // like every other mention of one.
    const asClass = classOf(checker, referent, state);
    if (asClass !== null) {
        return {kind: "reference", referent: erase(checker, referent, state)};
    }

    // Everything else, which in practice means a struct or a fixed array.
    // `Reference<Point>` is C++'s `const Point&`, and this language's only way
    // to say "do not copy this" about a stack value — there is no way to take
    // the address of one, `alloc` is where a `Pointer<T>` comes from, and
    // heap-allocating to avoid a copy is not a trade anybody should be asked
    // to make.
    //
    // Last, and after every named case above, because those decide what a type
    // *is* — a contract, an array, a class — where this only asks what it
    // looks like.
    const value = erase(checker, referent, state);

    // **A reference is only worth having to something a copy costs
    // something.** These all fit in a register and are copied by moving it, so
    // a reference to one is an extra indirection bought with an extra load.
    // `Pointer<T>` is the spelling for an out-parameter of a scalar, and it is
    // the one C uses for the same job.
    if (COPY_IS_FREE.has(value.kind)) {
        throw new ErasureError(
            `\`${renderType(value)}\` is one machine word and copying it is one ` +
            "instruction, so a reference to it is slower than the value it borrows. " +
            "Pass it by value. If the point was to let the callee *write* it, that " +
            `is \`Pointer<${renderType(value)}>\`, which is what C uses for the same ` +
            "job.",
            "GF0002",
        );
    }

    return value.kind === "void" ? null : referenceTo(value);
}

/**
 * The referents a reference is never worth taking: one register, copied by
 * moving it. See {@link eraseReferent}.
 */
const COPY_IS_FREE: ReadonlySet<MachineType["kind"]> = new Set<MachineType["kind"]>([
    "scalar",
    "bool",
    "pointer",
    "fnptr",
    "localfn",
    "cstring",
]);

/**
 * Wrap an erased referent, seeing that a contract is *already* the pair.
 *
 * A contract has no value form, so `Reference<I>` erases to the `(itab, data)`
 * pair itself rather than to a reference-to-something. Without this, resolving
 * a generic's `T` to a contract would produce a reference to a pair, which is
 * one indirection more than exists.
 */
function referenceTo(referent: MachineType): MachineType {
    return referent.kind === "interface" ? referent : {kind: "reference", referent};
}

/**
 * The name of the class a type is an instance of, or `null`.
 *
 * Read off the declaration rather than off the shape, because a class is
 * **nominal** here even though TypeScript's assignability is structural: two
 * classes with identical fields have different vtables and different
 * identities, and one is not the other.
 */
export function classNameOf(type: ts.Type): string | null {
    return classDeclarationOf(type)?.name?.text ?? null;
}

/** The `class` declaration a type is an instance of, or `undefined`. */
export function classDeclarationOf(type: ts.Type): ts.ClassDeclaration | undefined {
    return type.getSymbol()?.declarations?.find(ts.isClassDeclaration);
}

/**
 * A class instance, with the type arguments it was instantiated at.
 *
 * `Box<i32>` and `Box<f64>` are **different classes** — different layouts,
 * different vtables, different destructors — so the name has to say which, and
 * the erased arguments have to travel with it. The lowerer is what turns those
 * into a `ClassInfo`, and the name alone could not carry them back.
 *
 * The name is readable rather than mangled, the way a struct's is: `<`, `>` and
 * `,` are unforgeable in a TypeScript identifier, so nothing a program declares
 * can collide with one, and the backend's `ident()` quotes a symbol that is not
 * plain — `@"__gf_vt$Box<i32>"` is legal LLVM and legible in `llvm-objdump`,
 * which is the whole reason those symbols keep the class's name at all.
 *
 * A non-generic class answers exactly what it always did: its own name, and no
 * arguments.
 */
function classOf(
    checker: ts.TypeChecker,
    type: ts.Type,
    state: Erasure,
): { readonly name: string; readonly args?: readonly MachineType[] } | null {
    const declaration = classDeclarationOf(type);
    const name = declaration?.name?.text;
    if (declaration === undefined || name === undefined) {
        return null;
    }
    if (declaration.typeParameters === undefined || declaration.typeParameters.length === 0) {
        return {name};
    }

    const parameters = declaration.typeParameters;
    const written = checker.getTypeArguments(type as ts.TypeReference);

    // `this` inside `Box<T>`'s own body is tsc's **this-type**, not a reference
    // to `Box<T>` — so it has no type arguments to read, and asking for them
    // gives an empty list. Its arguments are the class's own parameters, which
    // the substitution in force resolves: inside `Box<i32>`'s copy of the body,
    // `T` is `i32`, and this is what makes `this.value` find the right class.
    //
    // Without it a method body erased its own receiver as `Box<>` and the
    // property access came back as "not supported", pointing inside the class
    // rather than at anything the programmer wrote.
    const supplied =
        written.length === parameters.length
            ? written
            : parameters.map((parameter) => checker.getTypeAtLocation(parameter.name));

    // Through, because the arguments are part of this class's *identity* rather
    // than of its layout: a `Box<Node>` is one machine word whatever `Node`
    // turns out to be, so a `Node` that reaches itself through one is an
    // ordinary shape rather than a value containing itself.
    const args = supplied.map((argument) =>
        state.through(() => erase(checker, argument, state)),
    );
    return {name: `${name}<${args.map(renderType).join(", ")}>`, args};
}

/**
 * The name of an **ambient** class — one whose layout is elsewhere — or `null`.
 *
 * `declare` is TypeScript's word for "the implementation is elsewhere", and for
 * a class that means the layout is elsewhere too: there are no method bodies to
 * emit, no constructor to run, no field offsets that anything here could know.
 * So an ambient class is an opaque handle type rather than a class this
 * compiler lays out, and that is the whole rule — the `private _opaque: never`
 * in the idiom is what makes *tsc* keep two handles apart, and this compiler
 * never reads it.
 *
 * **Two conditions, because `collectClasses` skips on two.** A `declare class`
 * has the modifier; a class inside `declare module "std/io" { … }` does not,
 * because `declare` is illegal on a member of an already-ambient block — and it
 * is no less ambient for that. The set of classes this build lays out and the
 * set that erases to a handle have to be exact complements, or a class falls
 * down the gap between them: skipped by the collector as having no body, then
 * refused by erasure as a class it has never heard of, which is `GF0001` about
 * a declaration that was perfectly well formed.
 */
/**
 * `dvec3` and its family, recognised by **where they were declared**.
 *
 * DECISIONS §22. The name alone is not the question and must not become it: a
 * flat table of names would match a `dvec3` declared in any `.d.ts` the project
 * happens to include, and silently give a user's own type the compiler's
 * arithmetic. So the declaration has to sit inside `declare module
 * "std/linalg"`, which is the same rule `STD_MODULES` applies to `mi_malloc`.
 *
 * These are recognised *before* {@link ambientClassNameOf}, which would
 * otherwise claim them: they are written as ambient classes, and an ambient
 * class is normally an opaque handle whose layout lives in someone else's
 * build. A `dvec3`'s layout lives here, in {@link LINALG_TYPES}.
 */
export function linalgTypeOf(type: ts.Type): LinalgType | null {
    const symbol = type.getSymbol();
    if (symbol === undefined) {
        return null;
    }
    const declaration = symbol.declarations?.find(ts.isClassDeclaration);
    if (declaration?.name === undefined) {
        return null;
    }
    const found = LINALG_TYPES.get(declaration.name.text);
    if (found === undefined) {
        return null;
    }
    return declaringModuleOf(declaration) === LINALG_MODULE ? found : null;
}

/**
 * The specifier of the `declare module "…"` a node sits inside, if any.
 *
 * An ambient module's name is a *string literal*, which is what distinguishes
 * `declare module "std/linalg"` from a namespace called `linalg`. Asking for
 * the literal rather than the identifier is what keeps a namespace of that name
 * from answering yes.
 */
function declaringModuleOf(node: ts.Node): string | null {
    for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
        if (ts.isModuleDeclaration(at) && ts.isStringLiteral(at.name)) {
            return at.name.text;
        }
    }
    return null;
}

/**
 * The struct a linear-algebra type erases to: its fields, and nothing else.
 *
 * A matrix's fields are its **columns**, each the column vector's own struct.
 * Nested aggregates are inline, so a `dmat3` is three `dvec3` back to back —
 * 72 bytes, the layout a graphics API expects — and its columns are ordinary
 * field projections rather than anything this module had to invent.
 */
export function linalgStruct(found: LinalgType): MachineType {
    if (found.family === "mat") {
        const column = columnTypeOf(found);
        if (column === undefined) {
            throw new ErasureError(
                `\`${found.name}\` names a column type that does not exist.`,
                "GF9001",
            );
        }
        const columnStruct = linalgStruct(column);
        return {
            kind: "struct",
            name: linalgStructName(found),
            fields: found.fields.map((field) => ({name: field, type: columnStruct})),
        };
    }
    return {
        kind: "struct",
        name: linalgStructName(found),
        fields: found.fields.map((field) => ({
            name: field,
            type:
                found.element === "bool"
                    ? {kind: "bool"}
                    : {kind: "scalar", name: found.element},
        })),
    };
}

export function ambientClassNameOf(type: ts.Type): string | null {
    const symbol = type.getSymbol();
    if (symbol === undefined) {
        return null;
    }
    const declaration = symbol.declarations?.find(ts.isClassDeclaration);
    if (declaration === undefined || declaration.name === undefined) {
        return null;
    }
    const declared = (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0;
    if (!declared && !declaration.getSourceFile().isDeclarationFile) {
        return null;
    }
    return declaration.name.text;
}

/**
 * The non-null half of `X | null`, or `null` when the type is not that shape.
 *
 * Exactly one union is recognised, and only this one: `null` (or `undefined`,
 * which tsc folds in alongside it) with a single other member. A union of two
 * real types is not a thing this language has, and falls through to be refused
 * by whatever asked.
 */
export function nullableOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
    if (!type.isUnion()) {
        return null;
    }
    const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined;
    const real = type.types.filter((part) => (part.getFlags() & nullish) === 0);
    if (real.length !== 1 || real.length === type.types.length) {
        return null;
    }
    return real[0] ?? null;
}

/** What a `Reference<T>` refers to, read off its brand, or `null`. */
/**
 * What a `Pointer<T>` points at.
 *
 * Read from the brand rather than from the intersection's other member, for the
 * same reason {@link referentOf} does: the brand carries `T` exactly, where the
 * intersection carries whatever `T` happened to widen to.
 */
export function pointeeOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
    const brand = brandedProperty(checker, type, "PointerBrand");
    if (!brand) {
        return null;
    }
    const pointee = checker.getTypeOfSymbol(brand);
    // `Pointer<unknown>` is C's `void *`, and `NonNullable<unknown>` is `{}` —
    // an empty object type, which erases to "an object with no fields has no
    // machine representation". That message is true of `{}` and says nothing
    // about the program that was written, so the one pointee with no type is
    // handed back untouched for `erase` to recognise.
    if (pointee.getFlags() & ts.TypeFlags.Unknown) {
        return pointee;
    }
    return checker.getNonNullableType(pointee);
}

export function referentOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
    const brand = brandedProperty(checker, type, "ReferenceBrand");
    if (!brand) {
        return null;
    }
    return checker.getNonNullableType(checker.getTypeOfSymbol(brand));
}

/**
 * A *contract*, if this type is one: an interface carrying method signatures.
 *
 * DECISIONS §11.2 makes this decision **syntactic**, at the interface's own
 * declaration, and that is the whole of the rule:
 *
 * | Written | Is |
 * |---|---|
 * | `feed(): void` — a `MethodSignature` | a contract: dispatched, itab |
 * | `feed: () => void` — a `PropertySignature` of function type | a shape: an `FnPtr` field |
 *
 * They are different AST node kinds, so nothing is inferred from a type. Three
 * things support drawing the line here rather than anywhere else:
 *
 * * **tsc already agrees.** Under `strictFunctionTypes` method signatures are
 *   bivariant and function-typed properties are contravariant — TypeScript
 *   treats them as different things today, and this is the same seam.
 * * **JavaScript already agrees.** `feed() {}` in a class goes on the
 *   prototype: one copy, shared, looked up dynamically. `feed = () => {}` is an
 *   instance property. That is the vtable/field distinction exactly.
 * * **It keeps C's struct-of-callbacks.** A struct of function pointers is how
 *   a great deal of C API surface is shaped, and it stays a plain struct.
 *
 * A mixture is rejected rather than guessed at: an interface with both a method
 * and a data member would have to be a dispatched thing *and* a layout, and no
 * answer to that is better than the other two.
 */
export function contractOf(
    checker: ts.TypeChecker,
    type: ts.Type,
    state: Erasure = new Erasure(),
): MachineType | null {
    const properties = checker.getPropertiesOfType(type);
    const methods = properties.filter((property) =>
        property.declarations?.some(ts.isMethodSignature),
    );
    if (methods.length === 0) {
        return null;
    }

    const name = structNameOf(checker, type);
    if (methods.length !== properties.length) {
        const data = properties.find((property) => !methods.includes(property));
        throw new ErasureError(
            `\`${name}\` declares both methods and the data member \`${data?.name}\`. ` +
            "An interface is either a *shape* — data only, laid out as a struct — or " +
            "a *contract* — methods only, dispatched through an itable. One that is " +
            "both would have to be a layout and a dispatch table at once. Split it, " +
            "or make the data a method that returns it.",
            "GF0002",
        );
    }

    // Sorted by name, so a slot is a function of the method *set* rather than of
    // the declaration's source order: reordering the declaration is then not a
    // silent ABI change (DECISIONS §11.2).
    const sorted = [...methods].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Built empty and filled, so that a contract whose own methods mention it —
    // `next(): Reference<Cursor>`, the shape of every iterator — closes onto
    // this object rather than erasing forever. A method's types are behind an
    // indirection, which is what makes that a shape rather than an impossible
    // type: the pair is two words whatever the methods say.
    const dispatched: InterfaceMethod[] = [];
    return state.aggregate(type, {kind: "interface", name, methods: dispatched}, () => {
        for (const method of sorted) {
            const declaration = method.declarations?.find(ts.isMethodSignature);
            const signature =
                declaration === undefined
                    ? undefined
                    : checker.getSignatureFromDeclaration(declaration);
            if (declaration === undefined || signature === undefined) {
                throw new ErasureError(
                    `tsc could not give \`${name}.${method.name}\` a signature.`,
                    "GF0001",
                );
            }
            dispatched.push({
                name: method.name,
                params: declaration.parameters.map((parameter) =>
                    state.through(() => erase(checker, checker.getTypeAtLocation(parameter), state)),
                ),
                returns: state.through(() =>
                    erase(checker, checker.getReturnTypeOfSignature(signature), state),
                ),
            });
        }
    });
}

/**
 * `FixedArray<T, N>`, read off its brand.
 *
 * The length comes from the brand's numeric literal type, the same way a width
 * comes from the `WidthBrand`'s string literal. The element type comes from the
 * index signature rather than from the brand, so an aliased or inferred `T`
 * still resolves.
 */
function fixedArrayOf(
    checker: ts.TypeChecker,
    type: ts.Type,
    state: Erasure,
): MachineType | null {
    const brand = brandedProperty(checker, type, "FixedLengthBrand");
    if (!brand) {
        return null;
    }

    const length = checker.getNonNullableType(checker.getTypeOfSymbol(brand));
    if (!length.isNumberLiteral()) {
        throw new ErasureError(
            "a `FixedArray` needs a length known at compile time; this one's length " +
            "is not a literal.",
            "GF0001",
        );
    }
    if (length.value < 0 || !Number.isInteger(length.value)) {
        throw new ErasureError(
            `\`${length.value}\` is not a valid array length.`,
            "GF0164",
        );
    }

    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (element === undefined) {
        throw new ErasureError("this `FixedArray` has no element type.", "GF0001");
    }
    // Not `through`: the elements are *inline*, so a fixed array of the type it
    // is a field of is a value containing itself, and `GF0307` is the answer.
    return {kind: "fixedArray", element: erase(checker, element, state), length: length.value};
}

/**
 * An object type, as a struct.
 *
 * The *declaration order* of the properties is what tsc reports, and that is
 * the order the fields are laid out in — so two structurally identical types
 * whose fields are declared in a different order are different layouts, exactly
 * as they are in C.
 */
function eraseObject(checker: ts.TypeChecker, type: ts.Type, state: Erasure): MachineType {
    const isUnion = brandedProperty(checker, type, "UnionBrand") !== null;
    // A brand is a symbol-keyed marker, never a field: it says what the type *is*
    // and occupies nothing. `extends Union` is the first case where one reaches
    // here at all — every other branded type is recognised before this point —
    // and it would otherwise be laid out as an optional field of type `never`.
    const properties = checker
        .getPropertiesOfType(type)
        .filter((property) => !isBrand(property));
    if (properties.length === 0) {
        throw new ErasureError(
            "an object with no fields has no machine representation. A struct needs " +
            "at least one field; an empty one would occupy nothing and mean nothing.",
            "GF0001",
        );
    }

    const name = structNameOf(checker, type);
    // Built empty and filled below, because the answer has to exist before its
    // own fields are erased: `next: Pointer<Node>` comes back through here for
    // `Node`, and what closes that cycle is this object (see {@link Erasure}).
    const fields: StructField[] = [];
    const answer: MachineType = isUnion
        ? {kind: "struct", name, fields, union: true}
        : {kind: "struct", name, fields};
    return state.aggregate(type, answer, () => {
        for (const property of properties) {
            eraseField(checker, type, name, property, fields, state);
        }
    });
}

/**
 * One property of an object type, as a field — or the reason it is not one.
 *
 * Split out of {@link eraseObject} only so that the loop that fills a struct's
 * fields is a loop and not a page.
 */
function eraseField(
    checker: ts.TypeChecker,
    type: ts.Type,
    name: string,
    property: ts.Symbol,
    fields: StructField[],
    state: Erasure,
): void {
    const declaration = property.declarations?.[0];
    // A `MethodSignature` makes this a *contract*, and a contract has no value
    // form — it is C++'s abstract base, which cannot be held by value either.
    // Reaching here means one was written where a layout was wanted, so the
    // message says how to hold one instead. See `contractOf` for why the line
    // is drawn at the AST node kind.
    if (declaration !== undefined && ts.isMethodSignature(declaration)) {
        // `contractOf` raises the better message when the interface is *mixed*,
        // and it has to be given the chance: telling someone to write
        // `Reference<Bad>` and then rejecting that too is two round trips for
        // one mistake.
        //
        // Asked in an erasure of its own, because this type is open here as a
        // *struct* and `contractOf` would answer the same question with an
        // interface. Nothing survives the throw below, so what it records does
        // not matter — but a half-built answer left where a cycle could close
        // on it would, and this is one line rather than that.
        contractOf(checker, type);
        throw new ErasureError(
            `\`${name}\` declares the method \`${property.name}()\`, which makes it a ` +
            "*contract* rather than a plain shape — it has no layout, so it cannot " +
            `be a value, a field or a by-value parameter. Write \`Reference<${name}>\`, ` +
            "which is the two-word pair a contract is held through.\n\n" +
            "If dispatch was not what you wanted, a function-typed *property* — " +
            `\`${property.name}: () => …\` rather than \`${property.name}()\` — is an ` +
            "ordinary field holding a function pointer, and leaves this a struct.",
            "GF0002",
        );
    }
    if ((property.flags & ts.SymbolFlags.Optional) !== 0) {
        throw new ErasureError(
            `\`${name}.${property.name}\` is optional. There is no \`undefined\` ` +
            "here for it to be, and no space in the layout for it not to be.",
            "GF0002",
        );
    }
    fields.push({
        name: property.name,
        type: erase(checker, checker.getTypeOfSymbol(property), state),
    });
}

/** What an enum's width is called when nothing says otherwise. */
export const DEFAULT_ENUM_WIDTH: ScalarName = "i32";

/** The name a merged namespace uses to declare an enum's underlying type. */
export const ENUM_UNDERLYING = "Underlying";

/**
 * The declaration an enum's underlying type is written on, if there is one.
 *
 * TypeScript has no syntax for a C enum's underlying type, so it is declared by
 * merging a namespace into the enum:
 *
 *     enum SDL_EventType { Quit = 0x100 }
 *     declare namespace SDL_EventType { type Underlying = u32 }
 *
 * A *type* rather than a `const`, which is what keeps it out of the way: the
 * two are one symbol to tsc, so `SDL_EventType.Underlying` resolves in type
 * position and is checked like any other type reference — a typo is an ordinary
 * tsc error — while in value position it does not exist at all, so the enum's
 * members are the only thing an editor offers.
 *
 * Symbol merging does not care which half is written first, so the namespace
 * may precede the enum.
 */
export function enumUnderlyingSymbol(
    checker: ts.TypeChecker,
    type: ts.Type,
): ts.Symbol | undefined {
    const enumDeclaration = enumDeclarationOf(type);
    if (enumDeclaration === undefined) {
        return undefined;
    }
    const merged = checker.getSymbolAtLocation(enumDeclaration.name);
    return merged?.exports?.get(ENUM_UNDERLYING as ts.__String);
}

/** The enum a type belongs to, whether it is the enum itself or one member. */
function enumDeclarationOf(type: ts.Type): ts.EnumDeclaration | undefined {
    const declaration = type.getSymbol()?.declarations?.[0];
    if (declaration === undefined) {
        return undefined;
    }
    // A member (`E.A`) is an enum *literal*, and its symbol is the member's. The
    // enum carrying the declaration is its parent.
    if (ts.isEnumMember(declaration)) {
        return declaration.parent;
    }
    return ts.isEnumDeclaration(declaration) ? declaration : undefined;
}

/**
 * Whether any member of this enum is initialised with a string.
 *
 * TypeScript has string enums, and they are a perfectly reasonable thing to
 * write — they are just not lowered here yet, which is a different statement
 * from "the language refuses them". Asked of the members rather than of the
 * type, because a mixed enum is string-like in one member and numeric in the
 * next, and one string member is enough to make the whole thing not a set of
 * integers.
 */
function isStringEnum(checker: ts.TypeChecker, declaration: ts.EnumDeclaration): boolean {
    return declaration.members.some(
        (member) => typeof checker.getConstantValue(member) === "string",
    );
}

/**
 * The width behind an enum, or `null` if this type is not one.
 *
 * Defaults to {@link DEFAULT_ENUM_WIDTH}, because that is what a C enum is
 * unless the ABI says otherwise — so omitting the declaration is not an error,
 * it is the common case.
 */
export function enumUnderlying(
    checker: ts.TypeChecker,
    type: ts.Type,
): ScalarName | null {
    if ((type.getFlags() & ts.TypeFlags.EnumLike) === 0) {
        return null;
    }

    // A gap, not a rule. A string enum is implementable — its members would be
    // string constants, which the language already has — and it is the one way to
    // write named string constants while module-level `const` is unsupported.
    // What is missing is the lowering, so it is `GF0001` and says so.
    const declaration = enumDeclarationOf(type);
    if (declaration !== undefined && isStringEnum(checker, declaration)) {
        throw new ErasureError(
            `\`${declaration.name.text}\` is a string enum, and only integer enums are ` +
            "lowered so far. An integer enum takes its width from " +
            `\`declare namespace ${declaration.name.text} { type ${ENUM_UNDERLYING} = … }\`, ` +
            "and a string one would need no width at all — the members are string " +
            "constants — so the two are different lowerings rather than one with a " +
            "flag.",
            "GF0001",
        );
    }

    const declared = enumUnderlyingSymbol(checker, type);
    if (declared === undefined) {
        return DEFAULT_ENUM_WIDTH;
    }

    const name = scalarName(checker, checker.getDeclaredTypeOfSymbol(declared));
    if (name === null) {
        throw new ErasureError(
            `\`${ENUM_UNDERLYING}\` must be one of the integer widths — \`u8\`, \`i32\`, ` +
            "`u32` and so on. An enum is a set of integer constants, and this names " +
            "something that is not an integer.",
            "GF0166",
        );
    }
    if (isFloat(name)) {
        throw new ErasureError(
            `\`${ENUM_UNDERLYING}\` is \`${name}\`, and an enum holds integers. ` +
            "A floating-point enum has no meaning: its members are written as exact " +
            "constants and compared for equality.",
            "GF0166",
        );
    }
    return name;
}

/**
 * Whether a property is a brand rather than a field.
 *
 * A brand is symbol-keyed, which is what stops a source file from spelling it
 * and claiming a shape it does not have — and is also what makes it recognisable
 * here without a list of names to keep in step.
 */
function isBrand(property: ts.Symbol): boolean {
    const declaration = property.declarations?.[0] as ts.NamedDeclaration | undefined;
    const name = declaration?.name;
    return name !== undefined && ts.isComputedPropertyName(name);
}

/**
 * A name for a struct type.
 *
 * An `interface Point` or a `type Point = { … }` gives its own name. An inline
 * object type has none, so one is built from its property names.
 *
 * **A name is not an identity.** Two files may each declare an `interface
 * Pair`, both are legal TypeScript, and tsc says they are different types.
 * What tells them apart is {@link layoutKey}, and everything that interns or
 * compares a struct has to use that instead.
 */
function structNameOf(checker: ts.TypeChecker, type: ts.Type): string {
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const name = symbol?.getName();
    if (name !== undefined && name !== "__type" && name !== "__object") {
        return name;
    }
    return `{${checker
        .getPropertiesOfType(type)
        .map((property) => property.name)
        .join(",")}}`;
}

/**
 * What makes an aggregate *itself*: **its name and its layout, together.**
 *
 * A name alone is not an identity, and treating it as one was a silent
 * miscompile. Two files may each declare an `interface Pair`, both are legal
 * TypeScript, and tsc says they are different types — so interning both under
 * `Pair` made the second find the first's `TyId` and take its layout. Nothing
 * was ill-formed anywhere, so nothing was reported: a `Pair` of `u32` compared
 * as `i32`, and `-1 < 0` came back false. The same fault reached clang as
 * `fptosi.sat.i32.i8` for a `Pair<u8>` and a `Pair<f64>`, which the compiler
 * then reported as `GF9003` — itself being broken, about a program tsc had
 * accepted.
 *
 * A layout alone is not an identity either, and that is the half it is easy to
 * drop. It would make `interface Point {x: i32; y: i32}` and `interface Vec2
 * {x: i32; y: i32}` one struct — defensible, since tsc is structural and would
 * let you pass either for the other, but it would also mean the generated C
 * header declares one of the two names and not the other. So the name stays in.
 *
 * The two together give the rule that costs nothing and surprises nobody:
 *
 * | Two declarations | Same struct? |
 * |---|---|
 * | `Point {x: i32; y: i32}` in each of two files | yes — one name, one layout |
 * | `Pair {a: i32}` and `Pair {a: u32}` | no — the layouts differ |
 * | `Point {x: i32}` and `Vec2 {x: i32}` | no — the names differ |
 *
 * **Cycles close on a back reference.** `interface Node { next: Pointer<Node> }`
 * has no finite spelling as a tree, so a struct already being keyed is written
 * as `↑n` — its distance up the stack — which is de Bruijn's trick and makes
 * the string finite *and* canonical. Two structurally identical recursive
 * `Node`s in two files therefore key alike, which is the right answer.
 *
 * Not a field on {@link MachineType}, deliberately: a recursive struct's fields
 * are not filled in yet at the moment its object is created — that is what
 * closes the cycle in {@link Erasure} — so there is no point at which such a
 * key could be computed and stored. A function over the finished type has no
 * such moment to miss.
 */
export function layoutKey(type: MachineType): string {
    return keyOf(type, []);
}

function keyOf(type: MachineType, open: MachineType[]): string {
    switch (type.kind) {
        case "void":
        case "bool":
        case "string":
        case "cstring":
            return type.kind;
        case "scalar":
            return type.name;
        case "array":
            return `[${keyOf(type.element, open)}]`;
        case "fixedArray":
            return `[${keyOf(type.element, open)};${type.length}]`;
        case "pointer":
            return `*${keyOf(type.pointee, open)}`;
        case "reference":
            return `&${keyOf(type.referent, open)}`;
        case "fnptr":
        case "localfn":
            return `${type.kind}(${type.params
                .map((param) => keyOf(param, open))
                .join(",")})->${keyOf(type.returns, open)}`;
        // Nominal, and only nominal: a class has an identity beyond its shape,
        // and `collectClasses` refuses two of the same name, so the name is
        // already unique across a build. An opaque handle has no layout here at
        // all, which is the whole of what makes it opaque.
        case "class":
        case "opaque":
            return `${type.kind} ${type.name}`;
        case "struct":
        case "interface": {
            const at = open.indexOf(type);
            if (at >= 0) {
                return `↑${open.length - at}`;
            }
            open.push(type);
            try {
                const members =
                    type.kind === "struct"
                        ? type.fields.map((f) => `${f.name}:${keyOf(f.type, open)}`)
                        : type.methods.map(
                            (m) =>
                                `${m.name}(${m.params
                                    .map((param) => keyOf(param, open))
                                    .join(",")})->${keyOf(m.returns, open)}`,
                        );
                const what =
                    type.kind === "interface" ? "contract" : type.union === true ? "union" : "struct";
                return `${what} ${type.name}{${members.join(",")}}`;
            } finally {
                open.pop();
            }
        }
    }
}

/** A human-readable spelling, for diagnostics. */
export function renderType(type: MachineType): string {
    switch (type.kind) {
        case "void":
            return "void";
        case "bool":
            return "boolean";
        case "scalar":
            return type.name;
        case "string":
            return "string";
        case "cstring":
            return "CString";
        case "array":
            return `${renderType(type.element)}[]`;
        case "fnptr":
            return `(${type.params.map(renderType).join(", ")}) => ${renderType(type.returns)}`;
        case "localfn":
            return `LocalFn<(${type.params.map(renderType).join(", ")}) => ${renderType(
                type.returns,
            )}>`;
        case "pointer":
            // `Pointer<unknown>` is what a program writes; `void` is what it erases
            // to, and only the erasure reaches here. A diagnostic that said
            // `Pointer<void>` would name a type its reader cannot spell.
            return type.pointee.kind === "void"
                ? "Pointer<unknown>"
                : `Pointer<${renderType(type.pointee)}>`;
        case "reference":
            return `Reference<${renderType(type.referent)}>`;
        case "struct":
        case "class":
        case "opaque":
            return type.name;
        case "interface":
            return `Reference<${type.name}>`;
        case "fixedArray":
            return `FixedArray<${renderType(type.element)}, ${type.length}>`;
    }
}

/** Whether a scalar is one of the two floating-point widths. */
export function isFloat(name: ScalarName): boolean {
    return name === "f32" || name === "f64";
}

/** Whether a scalar is a signed integer. `f32`/`f64` are not integers at all. */
export function isSignedInteger(name: ScalarName): boolean {
    return name === "i8" || name === "i16" || name === "i32" || name === "i64" || name === "isize";
}

export function isInteger(name: ScalarName): boolean {
    return !isFloat(name);
}
