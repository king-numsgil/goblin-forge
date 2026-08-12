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
  type ExternFunc,
  ExternId,
  type ClassDef,
  ClassId,
  type FieldDef,
  FileId,
  type Function as MirFunction,
  FuncId,
  type Global,
  type InterfaceDef,
  InterfaceId,
  type InterfaceMethod,
  type Linkage,
  type LocalDecl,
  LocalId,
  type Module,
  type Param,
  type Signature,
  SigId,
  SCHEMA_FINGERPRINT,
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
export const SYNTHETIC: Span = { file: FileId(0), line: 0, col: 0 };

/** A stable key for a structural type, so identical types intern to one id. */
function tyKindKey(kind: TyKind): string {
  switch (kind.kind) {
    case "Void":
    case "Bool":
    case "Str":
      return kind.kind;
    case "Int":
    case "Float":
      return `${kind.kind}:${kind.value}`;
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
  }
}

export class ModuleBuilder {
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

  readonly name: SymId;

  constructor(name: string) {
    this.name = this.sym(name);
  }

  // ---- interning ---------------------------------------------------------

  sym(text: string): SymId {
    const existing = this.#stringIndex.get(text);
    if (existing !== undefined) return existing;
    const id = SymId(this.#strings.length);
    this.#strings.push(text);
    this.#stringIndex.set(text, id);
    return id;
  }

  file(path: string): FileId {
    const existing = this.#fileIndex.get(path);
    if (existing !== undefined) return existing;
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
    if (existing !== undefined) return existing;
    const id = TyId(this.#types.length);
    this.#types.push({ kind, category: this.#categoryOf(kind) });
    this.#typeIndex.set(key, id);
    return id;
  }

  #categoryOf(kind: TyKind): Category {
    switch (kind.kind) {
      case "Void":
      case "Bool":
      case "Int":
      case "Float":
      case "FnPtr":
        return "Trivial";
      // An address into somebody else's storage. Never destroyed — that is the
      // entire content of `Reference<T>`.
      case "Pointer":
      case "Reference":
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

  /** Declare a struct. Fields are laid out in declaration order and never reordered. */
  struct(options: {
    name: string;
    fields: { name: string; ty: TyId; span?: Span }[];
    cCompatible?: boolean;
    span?: Span;
  }): StructId {
    const id = StructId(this.#structs.length);
    const fields: FieldDef[] = options.fields.map((field) => ({
      name: this.sym(field.name),
      ty: field.ty,
      span: field.span ?? SYNTHETIC,
    }));
    this.#structs.push({
      name: this.sym(options.name),
      fields,
      cCompatible: options.cCompatible ?? false,
      span: options.span ?? SYNTHETIC,
    });
    return id;
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
    if (def === undefined) throw new Error(`class ${id} was never declared`);
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
    if (def === undefined) throw new Error(`interface ${id} was never declared`);
    this.#interfaces[id] = {
      ...def,
      methods: methods
        .slice()
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((method) => ({ name: this.sym(method.name), sig: method.sig })),
    };
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
      typeof param === "number" ? { ty: param, name: null } : param,
    );
    const signature: Signature = {
      params,
      ret: options.ret,
      abi: options.abi ?? "Internal",
      variadic: options.variadic ?? false,
    };
    const key = JSON.stringify(signature);
    const existing = this.#sigIndex.get(key);
    if (existing !== undefined) return existing;
    const id = SigId(this.#sigs.length);
    this.#sigs.push(signature);
    this.#sigIndex.set(key, id);
    return id;
  }

  // ---- declarations ------------------------------------------------------

  extern(options: { name: string; sig: SigId; span?: Span }): ExternId {
    const id = ExternId(this.#externs.length);
    this.#externs.push({
      name: this.sym(options.name),
      sig: options.sig,
      span: options.span ?? SYNTHETIC,
    });
    return id;
  }

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
    builder.addLocal({ ty: signature.ret, storage: "Owned" });
    for (const param of signature.params) {
      builder.addLocal({
        ty: param.ty,
        storage: "Owned",
        ...(param.name !== null ? { nameSym: param.name } : {}),
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
}

export class FunctionBuilder {
  readonly #module: ModuleBuilder;
  readonly raw: MirFunction;
  readonly id: FuncId;

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
    this.raw.blocks.push({ kind, statements: [], terminator: { kind: "Unreachable" } });
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
    if (found === undefined) throw new Error(`block ${block} has not been reserved`);
    return found;
  }
}
