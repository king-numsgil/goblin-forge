/**
 * A C header for what a library exports.
 *
 * REWRITE-PLAN §12.9 asks for header emission alongside the library targets,
 * and the reason is that a `static-lib` nobody can call is not a deliverable.
 * The C side needs declarations, and hand-writing them is how the two sides
 * come to disagree about a struct's field order six months later.
 *
 * Generated from the **MIR**, not from the TypeScript. By the time a module
 * reaches here every type is concrete and sized, the C ABI has already accepted
 * it, and struct layout is the layout the backend actually used. Reading the
 * AST again would be a second derivation of the same facts, and a second thing
 * to keep in step.
 *
 * Only `Linkage::Export` functions appear, because only those have a C
 * signature — an internal function is classified however is fastest and has no
 * stable shape to publish (REWRITE-PLAN §6).
 */

import type { Module, Signature, TyKind } from "@goblin-forge/backend";

export interface HeaderOptions {
    /** The library's name, used for the include guard and the banner. */
    readonly name: string;
    /** What is being produced, which decides what a consumer has to link. */
    readonly kind: "static-lib" | "shared-lib";
    /** How the runtime was linked into it. */
    readonly runtime: "static" | "shared";
}

/**
 * What a consumer has to link, in the banner, because getting it wrong is not
 * a compile error — it is a second runtime.
 *
 * An archive carries only its own objects, so a `static-lib`'s consumer
 * supplies the runtime. A `shared-lib` already resolved everything at its own
 * link, so its consumer must **not** link the runtime archive as well: that
 * would put a second copy, with a second heap and a second allocation counter,
 * in the same program. Telling everyone the same thing was how this header came
 * to advise exactly that.
 */
function linkingAdvice(options: HeaderOptions): readonly string[] {
    if (options.kind === "static-lib") {
        return [
            " * Link the Goblin runtime alongside this library. A Goblin archive carries",
            " * only its own objects, so that two of them in one program do not each bring",
            " * a copy of the runtime.",
        ];
    }
    if (options.runtime === "shared") {
        return [
            " * Link this library's import stub, and the Goblin runtime's beside it — the",
            " * runtime is its own shared library here, shipped next to this one, and both",
            " * of you are calling into that one copy.",
        ];
    }
    return [
        " * Link this library's import stub and nothing else. The Goblin runtime is",
        " * already inside it, so linking the runtime archive as well would give your",
        " * program a second copy of it, with a second heap — and memory allocated by",
        " * one is not memory the other can free.",
    ];
}

/**
 * Raised when a header cannot be written.
 *
 * Two quite different reasons, and the `code` is which. **`GF9006`** is the
 * default and means the compiler is broken: the ABI classifier is supposed to
 * refuse anything with no C spelling long before this is asked, so the two
 * disagreeing is a bug here rather than in the program.
 *
 * The other reason is a real conflict in the program that only this file can
 * see — see the name check in {@link emitStructs} — and it carries its own
 * code, because telling somebody to report a compiler bug when what they need
 * to do is rename a type is the wrong instruction.
 */
export class HeaderError extends Error {
    constructor(
        message: string,
        readonly code: string = "GF9006",
    ) {
        super(message);
        this.name = "HeaderError";
    }
}

/**
 * The runtime functions a header declares when a `string` crosses, as both the
 * C declaration and the symbol behind it.
 *
 * One list rather than two, because the two disagreeing is the bug it exists to
 * prevent. A header naming `gf_string_free` beside a DLL that does not export
 * it is a consumer who cannot link, and the failure lands on them rather than
 * here — which is exactly what shipped until this was written down once.
 */
const RUNTIME_STRING_API = [
    {symbol: "gf_string_from_cstr", declaration: "GoblinString gf_string_from_cstr(const char* bytes);"},
    {symbol: "gf_string_clone", declaration: "GoblinString gf_string_clone(GoblinString s);"},
    {symbol: "gf_string_free", declaration: "void gf_string_free(GoblinString s);"},
] as const;

/**
 * Runtime symbols this module's header declares, and therefore the ones a
 * `shared-lib` has to publish beside its own.
 *
 * Empty unless a `string` actually crosses the boundary: the header declares
 * these under the same condition, and a library trafficking in none of them has
 * no reason to publish somebody else's symbols.
 *
 * Used only when the runtime is linked *statically* into the library, which is
 * the case where the library holds the only definition to publish. Linked
 * shared it holds an import, and the consumer links the runtime's own import
 * library — see the export list in `compile.ts` for why that is the uniform
 * answer rather than the forced one.
 */
export function runtimeSymbols(module: Module): readonly string[] {
    return usesStrings(module) ? RUNTIME_STRING_API.map((entry) => entry.symbol) : [];
}

/**
 * Render a C header declaring everything `module` exports.
 *
 * The result is a complete translation unit's worth of declarations: an include
 * guard, the fixed-width integer types, every struct an exported signature
 * mentions, and then the functions.
 */
export function emitHeader(module: Module, options: HeaderOptions): string {
    const guard = `GOBLIN_${identifier(options.name).toUpperCase()}_H`;
    const out: string[] = [];

    out.push(`/* Generated by goblin-forge for \`${options.name}\`. Do not edit.`);
    out.push(" *");
    out.push(" * Every declaration here is `extern \"C\"`, classified by the platform's own");
    out.push(" * rules — Win64 or System V — so a C compiler and this one agree about");
    out.push(" * registers, stack slots and hidden return pointers without either side");
    out.push(" * being told.");
    out.push(" *");
    out.push(...linkingAdvice(options));
    out.push(" */");
    out.push(`#ifndef ${guard}`);
    out.push(`#define ${guard}`);
    out.push("");
    out.push("#include <stdint.h>");
    out.push("#include <stdbool.h>");
    out.push("");
    out.push("#ifdef __cplusplus");
    out.push("extern \"C\" {");
    out.push("#endif");
    out.push("");

    if (usesStrings(module)) {
        out.push("/* A Goblin string.");
        out.push(" *");
        out.push(" * **Reading one is free.** It points at nul-terminated bytes, so `printf`,");
        out.push(" * `strlen` and every other `const char *` reader work on it unchanged.");
        out.push(" *");
        out.push(" * **Making one is not.** A length header sits sixteen bytes *behind* the");
        out.push(" * pointer, so a plain C string is not a GoblinString and passing one where");
        out.push(" * this type is expected reads a length out of whatever precedes your");
        out.push(" * literal. That is why this is a typedef and not `const char *`: the");
        out.push(" * compiler cannot stop you, so the name is the warning. Use");
        out.push(" * `gf_string_from_cstr`, which copies.");
        out.push(" *");
        out.push(" * **Freeing one is `gf_string_free`, never `free`** — the allocation starts");
        out.push(" * at the header, not at the pointer you were handed.");
        out.push(" *");
        out.push(" * Which strings you own is this library's business to document, exactly as");
        out.push(" * it is for any C API that hands out memory.");
        out.push(" */");
        out.push("typedef const char* GoblinString;");
        out.push("");
        for (const entry of RUNTIME_STRING_API) {
            out.push(entry.declaration);
        }
        out.push("");
    }

    const opaques = opaqueNames(module);
    if (opaques.length > 0) {
        out.push("/* Handles this library passes through but does not define.");
        out.push(" *");
        out.push(" * Incomplete on purpose: the layout belongs to whoever hands the handle");
        out.push(" * out, and neither this header nor the Goblin side has ever seen it. A");
        out.push(" * pointer to an incomplete type is all C needs, and all anyone should");
        out.push(" * want — dereferencing one is a compile error on both sides.");
        out.push(" */");
        for (const name of opaques) {
            out.push(`struct ${identifier(name)};`);
        }
        out.push("");
    }

    const structs = emitStructs(module);
    if (structs.length > 0) {
        out.push(...structs);
        out.push("");
    }

    let any = false;
    for (const func of module.funcs) {
        if (func.linkage !== "Export") {
            continue;
        }
        const signature = module.sigs[func.sig];
        if (signature === undefined) {
            continue;
        }
        out.push(declaration(module, sym(module, func.name), signature));
        any = true;
    }
    if (!any) {
        out.push("/* This library exports no functions. */");
    }

    out.push("");
    out.push("#ifdef __cplusplus");
    out.push("} /* extern \"C\" */");
    out.push("#endif");
    out.push("");
    out.push(`#endif /* ${guard} */`);
    return out.join("\n") + "\n";
}

/**
 * Struct definitions, in an order where each is defined before it is used.
 *
 * Nested aggregates are **inline** here as they are everywhere else, so a
 * struct genuinely contains its fields' bytes and the definition has to come
 * first — a forward declaration is not enough for a member of struct type.
 */
function emitStructs(module: Module): string[] {
    const order: number[] = [];
    const seen = new Set<number>();
    // The structs still being walked, and the ones a walk reached from inside
    // themselves — `struct Node { struct Node *next; }`, and the two-struct form
    // of the same shape. They need their name before their definition rather
    // than after it; see the emission below.
    const open = new Set<number>();
    const recursive = new Set<number>();
    // Signatures reached through a callback. Each gets a `typedef`, because C's
    // declarator syntax for a function *returning* a function pointer —
    // `int32_t (*f(void))(int32_t)` — is unreadable and a name is not optional
    // anyway once one appears as a struct field.
    const fnPtrs = new Set<number>();

    // **Post-order.** A struct is appended after everything it contains, because
    // nested aggregates are inline: `Line` holds two `Point`s by value, so C
    // needs `Point`'s definition — not a forward declaration — before it. Marking
    // on the way *down* and appending there produces the reverse order, which
    // compiles for pointers and fails for exactly the case this language cares
    // about.
    const visit = (ty: number): void => {
        const kind = module.types[ty]?.kind;
        if (kind === undefined) {
            return;
        }
        if (kind.kind === "Struct") {
            if (seen.has(kind.value)) {
                // Reached from inside its own walk, so the cycle is through a
                // pointer — nothing else here recurses, and a struct containing
                // itself by value is `GF0307` long before this.
                if (open.has(kind.value)) {
                    recursive.add(kind.value);
                }
                return;
            }
            // Marked before recursing so a struct reached twice is emitted once,
            // and so a cycle terminates.
            seen.add(kind.value);
            open.add(kind.value);
            for (const field of module.structs[kind.value]?.fields ?? []) {
                visit(field.ty);
            }
            open.delete(kind.value);
            order.push(kind.value);
            return;
        }
        if (kind.kind === "Pointer" || kind.kind === "Reference" || kind.kind === "Array") {
            visit(kind.value);
        }
        if (kind.kind === "FixedArray") {
            visit(kind.element);
        }
        // Through a callback's signature: a struct that appears only as a
        // callback's parameter still has to be declared before the callback is.
        if (kind.kind === "FnPtr") {
            const signature = module.sigs[kind.value];
            for (const param of signature?.params ?? []) {
                visit(param.ty);
            }
            if (signature !== undefined) {
                visit(signature.ret);
            }
            fnPtrs.add(kind.value);
        }
    };

    for (const func of module.funcs) {
        if (func.linkage !== "Export") {
            continue;
        }
        const signature = module.sigs[func.sig];
        if (signature === undefined) {
            continue;
        }
        for (const param of signature.params) {
            visit(param.ty);
        }
        visit(signature.ret);
    }

    // **Two different structs cannot share a C name.** Inside this compiler
    // they are told apart by `layoutKey`, which is a whole shape; a header has
    // only the name, and C has no way to say "the other `Pair`". Emitting both
    // produced two `typedef struct Pair` with different bodies — invalid C that
    // nothing here reported, and if a compiler accepted it every signature
    // would name whichever came first.
    //
    // Checked on the *sanitised* identifier rather than the name, because that
    // is what actually lands in the file: `Pair<i32>` and `Pair<u8>` are
    // different names that stay different (`Pair_i32_`, `Pair_u8_`), but
    // `identifier()` maps every character C cannot take onto `_`, so it is the
    // spelling after that which has to be unique.
    const named = new Map<string, number>();
    for (const id of order) {
        const def = module.structs[id];
        if (def === undefined) {
            continue;
        }
        const name = identifier(sym(module, def.name));
        const first = named.get(name);
        if (first !== undefined && first !== id) {
            const shape = (which: number): string =>
                (module.structs[which]?.fields ?? [])
                    .map((field) => `${cType(module, field.ty)} ${sym(module, field.name)}`)
                    .join("; ");
            throw new HeaderError(
                `two different types both cross this library's boundary as \`${name}\`, ` +
                `one holding \`${shape(first)}\` and the other \`${shape(id)}\`. A C ` +
                "header has only the name to tell them apart, and C has no way to say " +
                "\"the other one\" — so both would be declared and one of them would be " +
                "wrong.\n\nRename one of them. A generic carries its arguments in its " +
                "name already, so this is two declarations that genuinely share a name.",
                "GF0308",
            );
        }
        named.set(name, id);
    }

    // Which structs need their name before their definition: the recursive
    // ones, and every struct a callback's signature names. The callbacks'
    // typedefs are emitted before the struct definitions — a struct field of
    // callback type is spelled with one of those names — so any struct those
    // typedefs mention has to be forward-declared first. A forward
    // declaration is enough for the mention: C allows an incomplete parameter
    // type in a declarator that is not a definition, and a typedef never is.
    const forward = new Set<number>(recursive);
    const nameThrough = (ty: number): void => {
        const kind = module.types[ty]?.kind;
        if (kind === undefined) {
            return;
        }
        if (kind.kind === "Struct") {
            forward.add(kind.value);
            return;
        }
        if (kind.kind === "Pointer" || kind.kind === "Reference" || kind.kind === "Array") {
            nameThrough(kind.value);
            return;
        }
        if (kind.kind === "FixedArray") {
            nameThrough(kind.element);
            return;
        }
        // Through a nested callback too: its typedef is emitted in the same
        // block, ahead of every struct definition, so the structs it names
        // need the forward declaration as much as the outer one's do.
        if (kind.kind === "FnPtr") {
            const signature = module.sigs[kind.value];
            for (const param of signature?.params ?? []) {
                nameThrough(param.ty);
            }
            if (signature !== undefined) {
                nameThrough(signature.ret);
            }
        }
    };
    for (const sig of fnPtrs) {
        const signature = module.sigs[sig];
        for (const param of signature?.params ?? []) {
            nameThrough(param.ty);
        }
        if (signature !== undefined) {
            nameThrough(signature.ret);
        }
    }

    const out: string[] = [];
    // A struct that appears inside its own definition needs its name declared
    // first, because a `typedef` name is not in scope until its own declarator
    // is finished — `typedef struct Node { Node *next; } Node;` does not
    // compile. So the name comes first and the definition is written as a plain
    // `struct Node { … };`, which is the idiom C headers have always used for
    // this shape. The same form serves every struct the callback typedefs
    // below name, whose forward declaration is already in: re-typedefing the
    // name at the definition would be a redeclaration, which C89 and C99
    // refuse even where C11 allows it. Every other struct keeps the
    // one-declaration form.
    for (const id of order) {
        if (!forward.has(id)) {
            continue;
        }
        const name = identifier(sym(module, module.structs[id]?.name ?? 0));
        out.push(`typedef struct ${name} ${name};`);
    }
    if (out.length > 0) {
        out.push("");
    }

    // Before the structs, because a struct *field* of callback type is spelled
    // with one of these names — after them is invalid C for the struct of
    // callbacks, which is a shape this language means to support. Ascending by
    // signature id, which is a valid order for nesting: a signature that
    // mentions another callback can only name one interned before it, so the
    // inner typedef is always emitted first.
    for (const sig of [...fnPtrs].sort((a, b) => a - b)) {
        out.push(`typedef ${functionPointer(module, sig, fnPtrName(sig))};`);
        out.push("");
    }
    for (const id of order) {
        const def = module.structs[id];
        if (def === undefined) {
            continue;
        }
        const name = identifier(sym(module, def.name));
        out.push(forward.has(id) ? `struct ${name} {` : `typedef struct ${name} {`);
        for (const field of def.fields) {
            out.push(`    ${member(module, field.ty, identifier(sym(module, field.name)))};`);
        }
        out.push(forward.has(id) ? "};" : `} ${name};`);
        out.push("");
    }
    if (out.length > 0) {
        out.pop();
    }
    return out;
}

/**
 * The typedef name for a callback signature.
 *
 * By signature id, which is stable for a given program because the frontend
 * interns signatures in the order it meets them.
 */
function fnPtrName(sig: number): string {
    return `GfFn${sig}`;
}

function declaration(module: Module, name: string, signature: Signature): string {
    const params = signature.params.map((param, index) =>
        member(module, param.ty, `p${index}`),
    );
    if (signature.variadic) {
        params.push("...");
    }
    const list = params.length === 0 ? "void" : params.join(", ");
    return `${cType(module, signature.ret)} ${identifier(name)}(${list});`;
}

/**
 * A declarator: the C type with a name in the middle of it.
 *
 * Separate from {@link cType} because C's declarator syntax puts the name
 * *inside* the type for arrays — `int32_t xs[8]`, not `int32_t[8] xs` — and
 * writing the two as one string is how that gets silently wrong.
 */
function member(module: Module, ty: number, name: string): string {
    const kind = module.types[ty]?.kind;
    if (kind?.kind === "FixedArray") {
        return `${cType(module, kind.element)} ${name}[${kind.length}]`;
    }
    return `${cType(module, ty)} ${name}`;
}

/** `ret (*name)(params)`, with an empty name for an abstract declarator. */
function functionPointer(module: Module, sig: number, name: string): string {
    const signature = module.sigs[sig];
    if (signature === undefined) {
        throw new HeaderError(`signature ${sig} is not in the module`);
    }
    const params = signature.params.map((param) => cType(module, param.ty));
    if (signature.variadic) {
        params.push("...");
    }
    const list = params.length === 0 ? "void" : params.join(", ");
    return `${cType(module, signature.ret)} (*${name})(${list})`;
}

function cType(module: Module, ty: number): string {
    const kind = module.types[ty]?.kind;
    if (kind === undefined) {
        throw new HeaderError(`type ${ty} is not in the module`);
    }
    return spell(module, kind);
}

function spell(module: Module, kind: TyKind): string {
    switch (kind.kind) {
        case "Void":
            return "void";
        case "Bool":
            return "bool";
        case "Int":
            return INT_TYPES[kind.value] ?? "intptr_t";
        case "Float":
            return kind.value === "F32" ? "float" : "double";
        // A `dvec3` crosses the C boundary as the struct it is, which is what a
        // C caller can name; the vector form exists only between a load and a
        // store and never reaches a signature (DECISIONS §22). Reaching here is
        // a frontend that put one in an export.
        case "Simd":
            throw new HeaderError("a vector has no C spelling");
        case "Pointer":
        case "Reference":
            return `${cType(module, kind.value)}*`;
        case "Struct":
            return identifier(sym(module, module.structs[kind.value]?.name ?? 0));
        case "FixedArray":
            // Only reachable through `member`, which handles it. A bare fixed array
            // as a parameter or return has no C spelling — C cannot pass one by
            // value — and the ABI classifier rejects it before this is asked.
            return `${cType(module, kind.element)}*`;
        // Spelled as its own typedef rather than as `const char *`, and the
        // difference is the whole point. Reading one *is* just a `const char *`.
        // But the length header sits behind the pointer, so a C literal is not one
        // — and a header that says `const char *` invites exactly that mistake,
        // which reads a length from whatever precedes the literal and is silently
        // wrong rather than loudly. The name is the only warning available.
        case "Str":
            return "GoblinString";
        // The other half of the pair, and the whole reason the pair exists: a
        // signature can now say which of the two it means. This one really is a
        // plain `const char *`, and whether the caller owns it is documentation.
        case "CStr":
            return "const char*";
        // These own something, or carry a vtable. `require_plain_data` in the ABI
        // classifier refuses them at the boundary, so reaching here means the two
        // halves disagree about what may cross.
        // Its typedef, not an inline declarator. C's syntax for a function
        // *returning* a function pointer puts the parameter list on the outside —
        // `int32_t (*pick(bool))(int32_t)` — which a `${ret} ${name}(${params})`
        // template cannot produce and nobody wants to read. The typedef makes a
        // callback an ordinary noun everywhere it appears.
        case "FnPtr":
            return fnPtrName(kind.value);
        // An incomplete type, forward-declared in the preamble. C asks for nothing
        // more than this to hold a pointer to one, which is the only way one ever
        // appears.
        case "Opaque":
            return `struct ${identifier(sym(module, kind.value))}`;
        case "Array":
        case "Class":
        case "Interface":
            throw new HeaderError(
                `\`${kind.kind}\` has no C spelling. The ABI classifier is meant to have ` +
                "rejected this before a header was asked for.",
            );
    }
}

const INT_TYPES: Record<string, string> = {
    I8: "int8_t",
    I16: "int16_t",
    I32: "int32_t",
    I64: "int64_t",
    U8: "uint8_t",
    U16: "uint16_t",
    U32: "uint32_t",
    U64: "uint64_t",
    Isize: "intptr_t",
    Usize: "uintptr_t",
};

/** Whether any exported signature mentions a `string`. */
function usesStrings(module: Module): boolean {
    const isStr = (ty: number): boolean => module.types[ty]?.kind.kind === "Str";
    return module.funcs.some((func) => {
        if (func.linkage !== "Export") {
            return false;
        }
        const signature = module.sigs[func.sig];
        if (signature === undefined) {
            return false;
        }
        return signature.params.some((param) => isStr(param.ty)) || isStr(signature.ret);
    });
}

/**
 * Every opaque handle an exported signature mentions, in first-seen order.
 *
 * Only ever reached through a pointer — an opaque type has no value form — so
 * this looks one level through `Pointer` and no further.
 */
function opaqueNames(module: Module): string[] {
    const names: string[] = [];
    const note = (ty: number): void => {
        const kind = module.types[ty]?.kind;
        if (kind?.kind !== "Pointer") {
            return;
        }
        const pointee = module.types[kind.value]?.kind;
        if (pointee?.kind !== "Opaque") {
            return;
        }
        const name = sym(module, pointee.value);
        if (!names.includes(name)) {
            names.push(name);
        }
    };
    for (const func of module.funcs) {
        if (func.linkage !== "Export") {
            continue;
        }
        const signature = module.sigs[func.sig];
        if (signature === undefined) {
            continue;
        }
        for (const param of signature.params) {
            note(param.ty);
        }
        note(signature.ret);
    }
    return names;
}

function sym(module: Module, id: number): string {
    return module.strings[id] ?? `sym${id}`;
}

/**
 * A name C will accept.
 *
 * Anonymous struct names are built from their field list — `{x,y}` — which is
 * a fine key and not an identifier.
 */
function identifier(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
    return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
