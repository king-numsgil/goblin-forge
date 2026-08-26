/**
 * Construction helpers for MIR.
 *
 * The generated bindings are plain data; this is the machinery that makes
 * building that data pleasant and, more importantly, makes the interning
 * disciplined. Every string appears once, every structural type appears once,
 * and category is computed once from the type — never re-derived from the
 * shape of an expression, which is the mistake REWRITE-PLAN §4.1 names
 * explicitly.
 */

import {
    type Abi,
    type Block,
    BlockId,
    type BlockKind,
    type Category,
    type ClassDef,
    ClassId,
    type ExternFunc,
    ExternId,
    type FieldDef,
    FileId,
    FuncId,
    type Function as MirFunction,
    type Global,
    type InterfaceDef,
    InterfaceId,
    type InterfaceMethod,
    type Linkage,
    type LocalDecl,
    LocalId,
    type Module,
    type Param,
    SCHEMA_FINGERPRINT,
    SigId,
    type Signature,
    type Span,
    type Statement,
    type StorageClass,
    type StructDef,
    StructId,
    SymId,
    type Terminator,
    type TyDef,
    TyId,
    type TyKind,
} from "./mir.generated.ts";

/**
 * A source position for compiler-generated code that corresponds to nothing the
 * user wrote. Debug info skips these rather than attributing them to line 0 of
 * whatever file happened to be first.
 */
export const SYNTHETIC: Span = {file: FileId(0), line: 0, col: 0};

/** A stable key for a structural type, so identical types intern to one id. */
function tyKindKey(kind: TyKind): string {
    switch (kind.kind) {
        case "Void":
        case "Bool":
        case "Str":
        case "CStr":
            return kind.kind;
        case "Int":
        case "Float":
            return `${kind.kind}:${kind.value}`;
        case "Simd":
            return `Simd:${kind.elem}:${kind.lanes}`;
        case "Pointer":
        case "Reference":
        case "Array":
            return `${kind.kind}:${kind.value}`;
        case "FnPtr":
            return `FnPtr:${kind.value}`;
        case "FixedArray":
            return `FixedArray:${kind.element}:${kind.length}`;
        case "Struct":
            return `Struct:${kind.value}`;
        case "Class":
            return `Class:${kind.value}`;
        case "Interface":
            return `Interface:${kind.value}`;
        case "Opaque":
            return `Opaque:${kind.value}`;
    }
}

export class ModuleBuilder {
    readonly name: SymId;
    readonly #strings: string[] = [];
    readonly #stringIndex = new Map<string, SymId>();
    readonly #files: string[] = [];
    readonly #fileIndex = new Map<string, FileId>();
    readonly #types: TyDef[] = [];
    readonly #typeIndex = new Map<string, TyId>();
    readonly #structs: StructDef[] = [];
    readonly #classes: ClassDef[] = [];
    readonly #interfaces: InterfaceDef[] = [];
    readonly #sigs: Signature[] = [];
    readonly #sigIndex = new Map<string, SigId>();
    readonly #externs: ExternFunc[] = [];
    readonly #globals: Global[] = [];
    readonly #funcs: MirFunction[] = [];

    constructor(name: string) {
        this.name = this.sym(name);
    }

    // ---- interning ---------------------------------------------------------

    sym(text: string): SymId {
        const existing = this.#stringIndex.get(text);
        if (existing !== undefined) {
            return existing;
        }
        const id = SymId(this.#strings.length);
        this.#strings.push(text);
        this.#stringIndex.set(text, id);
        return id;
    }

    file(path: string): FileId {
        const existing = this.#fileIndex.get(path);
        if (existing !== undefined) {
            return existing;
        }
        const id = FileId(this.#files.length);
        this.#files.push(path);
        this.#fileIndex.set(path, id);
        return id;
    }

    /**
     * Intern a type, computing its category from its structure.
     *
     * REWRITE-PLAN §4.1: the category is computed once, from the type, and every
     * ownership decision downstream is a lookup. The backend re-derives it in
     * debug builds and asserts agreement, so this cannot quietly disagree with
     * the half of the compiler that acts on it.
     */
    ty(kind: TyKind): TyId {
        const key = tyKindKey(kind);
        const existing = this.#typeIndex.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const id = TyId(this.#types.length);
        this.#types.push({kind, category: this.#categoryOf(kind)});
        this.#typeIndex.set(key, id);
        return id;
    }

    /** Declare a struct. Fields are laid out in declaration order and never reordered. */
    struct(options: {
        name: string;
        fields: { name: string; ty: TyId; span?: Span }[];
        cCompatible?: boolean;
        /** A C `union`: every field at offset 0, sized by the largest member. */
        union?: boolean;
        span?: Span;
    }): StructId {
        const id = this.declareStruct(options);
        this.defineStruct(id, {fields: options.fields});
        return id;
    }

    /**
     * Reserve a struct id before its fields are known.
     *
     * Two-phase, like {@link ModuleBuilder.declareClass}, and for the shape that
     * needs it: `struct Node { struct Node *next; }`. Interning that field's type
     * comes back through the struct it is a field of, so the id has to exist
     * before the fields do — the other order is the obvious one and does not
     * terminate.
     *
     * Unlike a class, **a struct's category is a function of its fields**, so a
     * `Struct` type interned in this window is `Trivial` whatever the struct
     * turns out to own. {@link defineStruct} settles that, and it is why the
     * pair is a pair rather than a convenience.
     */
    declareStruct(options: {
        name: string;
        cCompatible?: boolean;
        union?: boolean;
        span?: Span;
    }): StructId {
        const id = StructId(this.#structs.length);
        this.#structs.push({
            name: this.sym(options.name),
            fields: [],
            cCompatible: options.cCompatible ?? false,
            union: options.union ?? false,
            span: options.span ?? SYNTHETIC,
        });
        return id;
    }

    /** Fill in a struct declared earlier, and settle what it owns. */
    defineStruct(
        id: StructId,
        options: { fields: { name: string; ty: TyId; span?: Span }[] },
    ): void {
        const def = this.#structs[id];
        if (def === undefined) {
            throw new Error(`struct ${id} was never declared`);
        }
        def.fields = options.fields.map((field): FieldDef => ({
            name: this.sym(field.name),
            ty: field.ty,
            span: field.span ?? SYNTHETIC,
        }));

        // Every type interned while this struct had no fields was given a
        // category computed from a struct that owned nothing, so any that read
        // this one's is now stale. Recomputing the whole table is the honest fix
        // and costs nothing at this size.
        //
        // It settles, and in a single pass in all but a contrived case: a
        // category is a function of a type's *inline* components, and a type is
        // interned after those — so the table is already in dependency order
        // apart from the struct that had to come first. That one's cycle is
        // through a `Pointer` or a `Reference`, whose category is the same
        // answer whatever is behind it. The loop is here for the contrived case
        // (`Pointer<FixedArray<Node, 4>>` as a field of `Node`) rather than for
        // the ordinary one, and it cannot spin: the only category that moves is
        // `Trivial` becoming `Owning`, so every pass that changes anything
        // leaves one fewer type that can change.
        let settled = false;
        while (!settled) {
            settled = true;
            for (const ty of this.#types) {
                const category = this.#categoryOf(ty.kind);
                if (category !== ty.category) {
                    ty.category = category;
                    settled = false;
                }
            }
        }
    }

    /**
     * Reserve a class id before its shape is known.
     *
     * Two-phase, like {@link ModuleBuilder.declareFunction}, and for a sharper
     * reason: a class's own methods take `this` as a `Reference<Self>`, so
     * interning that parameter type needs the class's `TyId`, which needs its
     * `ClassId`. Nothing about the category depends on the fields — a class is
     * `Polymorphic` because it has a vtable — so the type is usable immediately.
     */
    declareClass(options: { name: string; base?: ClassId | null; span?: Span }): ClassId {
        const id = ClassId(this.#classes.length);
        this.#classes.push({
            name: this.sym(options.name),
            base: options.base ?? null,
            fields: [],
            ownFields: 0,
            vtable: [],
            implements: [],
            span: options.span ?? SYNTHETIC,
        });
        return id;
    }

    /**
     * Fill in a class declared earlier.
     *
     * `fields` and `vtable` must already be **flattened**, base entries first —
     * see `ClassDef` in the Rust definition. Passing a class's own fields only
     * would compile and then lay every derived object out on top of its base.
     */
    defineClass(
        id: ClassId,
        options: {
            fields: { name: string; ty: TyId; span?: Span }[];
            ownFields: number;
            vtable: FuncId[];
            implements?: { interface: InterfaceId; methods: FuncId[] }[];
        },
    ): void {
        const def = this.#classes[id];
        if (def === undefined) {
            throw new Error(`class ${id} was never declared`);
        }
        if (options.ownFields > options.fields.length) {
            throw new Error(
                `class ${this.#strings[def.name]} says its own fields start at ` +
                `${options.ownFields} but it has only ${options.fields.length} fields`,
            );
        }
        this.#classes[id] = {
            ...def,
            fields: options.fields.map((field) => ({
                name: this.sym(field.name),
                ty: field.ty,
                span: field.span ?? SYNTHETIC,
            })),
            ownFields: options.ownFields,
            vtable: options.vtable,
            // Sorted so a dynamic cast can binary-search rather than scan.
            implements: (options.implements ?? [])
                .slice()
                .sort((a, b) => a.interface - b.interface),
        };
    }

    declareInterface(options: { name: string; span?: Span }): InterfaceId {
        const id = InterfaceId(this.#interfaces.length);
        this.#interfaces.push({
            name: this.sym(options.name),
            methods: [],
            span: options.span ?? SYNTHETIC,
        });
        return id;
    }

    /**
     * Fill in an interface declared earlier.
     *
     * Methods are sorted by name here rather than at the call site, so a slot is
     * a function of the method *set* and reordering a declaration is not a silent
     * ABI change (DECISIONS §11.2).
     */
    defineInterface(id: InterfaceId, methods: { name: string; sig: SigId }[]): void {
        const def = this.#interfaces[id];
        if (def === undefined) {
            throw new Error(`interface ${id} was never declared`);
        }
        this.#interfaces[id] = {
            ...def,
            methods: methods
                .slice()
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
                .map((method) => ({name: this.sym(method.name), sig: method.sig})),
        };
    }

    /**
     * Record that a class is convertible to an interface, with the itab entries
     * that answer it.
     *
     * Called while *bodies* are being lowered rather than at `defineClass`, and
     * that ordering is the design rather than an accident: DECISIONS §11.2 makes
     * a static conversion **structural**, so the set of interfaces a class
     * converts to is only known once every conversion site has been seen. A class
     * that declares `implements` is registered eagerly on top of that, because
     * declaring it is what will make the class findable by a *dynamic* cast.
     *
     * Idempotent: the same pair registered twice keeps one itab, which is the
     * within-a-module interning §11.2 asks for. Across modules there is no
     * interning and none is needed — an itab is a cache, and only the type
     * descriptor is an identity.
     */
    implementInterface(id: ClassId, interfaceId: InterfaceId, methods: FuncId[]): void {
        const def = this.#classes[id];
        if (def === undefined) {
            throw new Error(`class ${id} was never declared`);
        }
        if (def.implements.some((entry) => entry.interface === interfaceId)) {
            return;
        }
        const implemented = [...def.implements, {interface: interfaceId, methods}];
        implemented.sort((a, b) => a.interface - b.interface);
        this.#classes[id] = {...def, implements: implemented};
    }

    /** The methods of an interface, in slot order. Empty if it has none. */
    interfaceMethods(id: InterfaceId): readonly InterfaceMethod[] {
        return this.#interfaces[id]?.methods ?? [];
    }

    /** How many parameters a signature declares. */
    paramCount(sig: SigId): number {
        return this.#sigs[sig]?.params.length ?? 0;
    }

    /** A class's flattened field list, for resolving a field index. */
    classFields(id: ClassId): readonly FieldDef[] {
        return this.#classes[id]?.fields ?? [];
    }

    sig(options: {
        params: (TyId | Param)[];
        ret: TyId;
        abi?: Abi;
        variadic?: boolean;
    }): SigId {
        const params: Param[] = options.params.map((param) =>
            typeof param === "number" ? {ty: param, name: null} : param,
        );
        const signature: Signature = {
            params,
            ret: options.ret,
            abi: options.abi ?? "Internal",
            variadic: options.variadic ?? false,
        };
        const key = JSON.stringify(signature);
        const existing = this.#sigIndex.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const id = SigId(this.#sigs.length);
        this.#sigs.push(signature);
        this.#sigIndex.set(key, id);
        return id;
    }

    extern(options: { name: string; sig: SigId; span?: Span }): ExternId {
        const id = ExternId(this.#externs.length);
        this.#externs.push({
            name: this.sym(options.name),
            sig: options.sig,
            span: options.span ?? SYNTHETIC,
        });
        return id;
    }

    // ---- declarations ------------------------------------------------------

    global(options: {
        name: string;
        ty: TyId;
        linkage?: Linkage;
        mutable?: boolean;
        init?: Uint8Array;
        span?: Span;
    }): void {
        this.#globals.push({
            name: this.sym(options.name),
            ty: options.ty,
            linkage: options.linkage ?? "Internal",
            mutable: options.mutable ?? false,
            init: options.init ?? null,
            span: options.span ?? SYNTHETIC,
        });
    }

    /** Reserve a function id before its body exists, so calls can refer to it. */
    declareFunction(options: {
        name: string;
        sig: SigId;
        linkage?: Linkage;
        span?: Span;
    }): FunctionBuilder {
        const id = FuncId(this.#funcs.length);
        const signature = this.#sigs[options.sig];
        if (signature === undefined) {
            throw new Error(`signature ${options.sig} is not in the signature table`);
        }
        const builder = new FunctionBuilder(this, id, {
            name: this.sym(options.name),
            sig: options.sig,
            linkage: options.linkage ?? "Internal",
            locals: [],
            blocks: [],
            span: options.span ?? SYNTHETIC,
        });
        // Local 0 is the return place; locals 1..=n are the parameters, in order.
        builder.addLocal({ty: signature.ret, storage: "Owned"});
        for (const param of signature.params) {
            builder.addLocal({
                ty: param.ty,
                storage: "Owned",
                ...(param.name !== null ? {nameSym: param.name} : {}),
            });
        }
        this.#funcs.push(builder.raw);
        return builder;
    }

    finish(): Module {
        return {
            schemaFingerprint: SCHEMA_FINGERPRINT,
            name: this.name,
            strings: this.#strings,
            files: this.#files,
            types: this.#types,
            structs: this.#structs,
            classes: this.#classes,
            interfaces: this.#interfaces,
            sigs: this.#sigs,
            externs: this.#externs,
            globals: this.#globals,
            funcs: this.#funcs,
        };
    }

    #categoryOf(kind: TyKind): Category {
        switch (kind.kind) {
            case "Void":
            case "Bool":
            case "Int":
            case "Float":
            case "FnPtr":
            // A vector is lanes of float and nothing else: bits to copy, and
            // nothing to destroy.
            case "Simd":
                return "Trivial";
            // A type with no value form: nothing here is ever copied or destroyed,
            // because nothing here is ever *held*. Only a `Pointer` to one travels,
            // and that pointer is a `Borrow` in its own right.
            case "Opaque":
                return "Trivial";
            // An address into somebody else's storage. Never destroyed — that is the
            // entire content of `Reference<T>`, and of `CString`: the compiler has
            // been told not to track it, which is what makes it the borrowed half of
            // the string pair.
            case "Pointer":
            case "Reference":
            case "CStr":
                return "Borrow";
            // A one-word handle to a heap buffer it owns.
            case "Str":
            case "Array":
                return "Owning";
            // Inline elements, no allocation of its own — so it owns whatever the
            // element type owns, and nothing otherwise.
            case "FixedArray": {
                const element = this.#types[kind.element];
                if (element === undefined) {
                    throw new Error(`element type ${kind.element} is not in the type table`);
                }
                return element.category === "Owning" || element.category === "Polymorphic"
                    ? "Owning"
                    : "Trivial";
            }
            case "Struct": {
                const def = this.#structs[kind.value];
                if (def === undefined) {
                    throw new Error(`struct ${kind.value} referenced before it was declared`);
                }
                // A struct with an owning field is owning. There is no default copy
                // operation to fall back on: `memcpy` is right for an array of `i32`
                // and a double free for an array of anything with a destructor
                // (REWRITE-PLAN §10).
                const owns = def.fields.some((field) => {
                    const fieldTy = this.#types[field.ty];
                    if (fieldTy === undefined) {
                        throw new Error(`field type ${field.ty} is not in the type table`);
                    }
                    return fieldTy.category === "Owning" || fieldTy.category === "Polymorphic";
                });
                return owns ? "Owning" : "Trivial";
            }
            // Unconditional, and deliberately not a function of the fields: a class
            // is polymorphic because it has a vtable pointer, which every class has.
            // Copying one slices and destroying one runs a destructor, whatever it
            // happens to hold.
            case "Class":
                return "Polymorphic";
            // A contract is never a value — it exists only as `Reference<I>`, whose
            // own category is `Borrow`. Answering `Borrow` here keeps anything that
            // does ask from concluding it must be destroyed.
            case "Interface":
                return "Borrow";
        }
    }
}

export class FunctionBuilder {
    readonly raw: MirFunction;
    readonly id: FuncId;
    readonly #module: ModuleBuilder;

    constructor(module: ModuleBuilder, id: FuncId, raw: MirFunction) {
        this.#module = module;
        this.id = id;
        this.raw = raw;
    }

    addLocal(options: {
        ty: TyId;
        storage: StorageClass;
        name?: string;
        nameSym?: SymId;
        span?: Span;
    }): LocalId {
        const id = LocalId(this.raw.locals.length);
        const nameSym =
            options.nameSym ?? (options.name !== undefined ? this.#module.sym(options.name) : null);
        const decl: LocalDecl = {
            ty: options.ty,
            storage: options.storage,
            name: nameSym,
            span: options.span ?? SYNTHETIC,
        };
        this.raw.locals.push(decl);
        return id;
    }

    /**
     * Reserve a block. The terminator is filled in by {@link seal}.
     *
     * Blocks are reserved rather than appended so that forward edges can be
     * named before their targets exist, which is what lowering a loop needs.
     */
    block(kind: BlockKind = "Normal"): BlockId {
        const id = BlockId(this.raw.blocks.length);
        this.raw.blocks.push({kind, statements: [], terminator: {kind: "Unreachable"}});
        return id;
    }

    push(block: BlockId, statement: Statement): void {
        this.#at(block).statements.push(statement);
    }

    seal(block: BlockId, terminator: Terminator): void {
        this.#at(block).terminator = terminator;
    }

    #at(block: BlockId): Block {
        const found = this.raw.blocks[block];
        if (found === undefined) {
            throw new Error(`block ${block} has not been reserved`);
        }
        return found;
    }
}
