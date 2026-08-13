/**
 * The checked TypeScript AST, lowered to MIR.
 *
 * Two things this file is not allowed to do, both of them lessons from v1:
 *
 * * **Work ownership out from context.** There is no `takeOwnership`, no
 *   `cloneOf`, no `ownsAllocation`. Copy and move are written into the MIR;
 *   the category comes from the type; the storage class comes from the place.
 * * **Return an expression that needs a statement.** Everything lands in a
 *   basic block. A helper that needed a loop to produce a value is what forced
 *   v1's `Expr::Seq`, and there is nowhere for one to hide here — the CFG is
 *   the only place code goes.
 *
 * ## The width pass
 *
 * Expressions are handled in two passes over the same tree, and the split is
 * the point.
 *
 * {@link BodyLowerer.width} answers *what width is this expression, on its own
 * terms* — bottom-up, memoised, and the only place a width diagnostic is
 * raised. It reports one of three things: a definite type, **polymorphic**
 * (built only from literals, so it takes its width from context), or an error
 * already reported.
 *
 * `#value` then lowers top-down, with the expected type known, so a literal is
 * range-checked against the width it is actually becoming and a promotion is
 * emitted as an explicit `Cast` rather than assumed.
 *
 * Doing it in one pass is what forces a compiler to guess at `a * b < c`. The
 * rules themselves live in `@goblin-forge/checker`'s width tables, not here:
 * REWRITE-PLAN §7 asks for one table-driven place, and scattering them back
 * through lowering is how they stop agreeing with each other.
 */

import ts from "typescript";

import {
  checkLiteral,
  commonType,
  type Diagnostic,
  ErasureError,
  erase,
  fits,
  hasExplicitRadix,
  isFloatType,
  isIntegerLiteral,
  isIntegerType,
  isMachineComparable,
  literalDigits,
  type MachineType,
  type Operator,
  type OperatorInfo,
  OPERATORS,
  rangeOf,
  renderType,
  sameType,
  type ScalarName,
  classNameOf,
  contractOf,
  isCStringType,
  referentOf,
} from "@goblin-forge/checker";
import {
  type ClassInfo,
  type ClassMethod,
  collectClasses,
} from "./classes.ts";
import {
  type BinOp,
  type BlockId,
  type CastKind,
  type ClassId,
  type ExternId,
  FieldId,
  type FuncId,
  type FunctionBuilder,
  type InterfaceId,
  type IntTy,
  LocalId,
  type Module as MirModule,
  ModuleBuilder,
  type Operand,
  type Place,
  type Rvalue,
  type SigId,
  type Terminator,
  type TyId,
  type UnwindAction,
} from "@goblin-forge/backend";

export interface LowerResult {
  readonly module: MirModule | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

const NO_UNWIND: UnwindAction = { kind: "Unreachable" };

/** The intrinsic that spells a width conversion. */
const NATIVE_CAST = "nativeCast";
/** The intrinsic that spells "hand this value's ownership somewhere else". */
const MOVE = "move";
/** The intrinsic that builds a `FixedArray<T, N>`. */
const FIXED_ARRAY = "fixedArray";
/** `tryCast<T>(value)` — a checked downcast, `null` when the answer is no. */
const TRY_CAST = "tryCast";
/** `cstring(s)` — borrow a `string`'s bytes as a raw `const char *`. */
const CSTRING = "cstring";
/** `cstring_free(c)` — release one that came from a Goblin `string`. */
const CSTRING_FREE = "cstring_free";

/**
 * Runtime entry points the lowerer names directly.
 *
 * These are declared as ordinary `extern "C"` imports and called with ordinary
 * `Call` terminators, because that is what they are — there is no privileged
 * channel into the runtime. It also means they show up in a MIR dump, which is
 * where you want to see that `console.log` of an `i32` became a conversion and
 * a print rather than something magic.
 */
const RUNTIME = {
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
} as const;

/** `console` methods, and which stream each writes to. */
const CONSOLE_METHODS: Partial<Record<string, "out" | "err">> = {
  log: "out",
  info: "out",
  debug: "out",
  warn: "err",
  error: "err",
};

const INT_TY: Record<Exclude<ScalarName, "f32" | "f64">, IntTy> = {
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
const OPERATOR_TOKENS: Partial<Record<ts.SyntaxKind, Operator>> = {
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

/** How an operator is spelled in the MIR. */
const MIR_OPS: Record<Operator, BinOp> = {
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

/**
 * What {@link BodyLowerer.width} concluded about an expression.
 *
 * `poly` is the interesting one: an expression built only from literals has no
 * width of its own and takes one from wherever it lands. `42` is an `i32` in
 * one place and a `u8` in another, and neither is a conversion.
 */
type Width =
  | { readonly kind: "typed"; readonly type: MachineType }
  | { readonly kind: "poly" }
  | { readonly kind: "error" };

const STRING: MachineType = { kind: "string" };
const CSTRING_TYPE: MachineType = { kind: "cstring" };
const USIZE: MachineType = { kind: "scalar", name: "usize" };
const VOID: MachineType = { kind: "void" };

const POLY: Width = { kind: "poly" };
const ERROR: Width = { kind: "error" };
const typed = (type: MachineType): Width => ({ kind: "typed", type });

/**
 * A lowered expression, and the type it actually has.
 *
 * `temporary` is set when the value lives in a temporary this expression
 * created. That changes what its single use is allowed to do with it: a
 * temporary can be *moved* into a binding rather than cloned, and *borrowed*
 * into a call rather than cloned, because it is already the copy.
 */
interface Typed {
  readonly operand: Operand;
  readonly type: MachineType;
  readonly temporary?: LocalId;
  /**
   * A reference to something nothing owns.
   *
   * Legal as an *argument*: the temporary dies at the end of the enclosing
   * full-expression, which is after the call returns. Illegal as a *binding*,
   * which would outlive it — that is `GF0234`, and it is the one place the
   * distinction matters, so the flag is set here and read only there.
   */
  readonly borrowsTemporary?: true;
}

interface Binding {
  readonly local: LocalId;
  readonly type: MachineType;
  readonly ty: TyId;
}

/**
 * One lexical scope, with an **identity**.
 *
 * The identity is the important part. An early exit has to release the scopes
 * opened inside the block it is leaving and no others, and the way that goes
 * wrong is arithmetic on scope *depth* — an inclusive bound where an exclusive
 * one was meant. That is v1's `switch` double free, and REWRITE-PLAN §10 asks
 * for it to be impossible rather than merely fixed.
 *
 * So `break` names the scope it is unwinding *to* by identity, and the unwind
 * loop compares objects. There is no depth to get off by one.
 */
interface Scope {
  readonly id: number;
  readonly bindings: Map<string, Binding>;
  /**
   * Locals declared in this scope, in declaration order. Released in reverse,
   * because destruction is construction backwards.
   */
  readonly locals: LocalId[];
}

/**
 * A lexical scope stack.
 *
 * REWRITE-PLAN §7: v1's map of inferred local widths was flat — a local
 * declared inside a branch stayed visible afterwards — and it got away with it
 * only because tsc rejects any program that could observe it. That is a bet,
 * not a design.
 */
class Scopes {
  #nextId = 0;
  readonly #stack: Scope[] = [];

  constructor() {
    this.push();
  }

  push(): Scope {
    const scope: Scope = { id: this.#nextId++, bindings: new Map(), locals: [] };
    this.#stack.push(scope);
    return scope;
  }

  pop(): Scope {
    if (this.#stack.length === 1) throw new Error("popped the outermost scope");
    return this.#stack.pop()!;
  }

  get innermost(): Scope {
    return this.#stack[this.#stack.length - 1]!;
  }

  declare(name: string, binding: Binding): void {
    const scope = this.innermost;
    scope.bindings.set(name, binding);
    scope.locals.push(binding.local);
  }

  lookup(name: string): Binding | undefined {
    for (let index = this.#stack.length - 1; index >= 0; index -= 1) {
      const found = this.#stack[index]!.bindings.get(name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * Scopes from innermost outward, stopping **before** `until`.
   *
   * `until` is released by its own block exit, not by whatever is jumping out
   * of it — which is exactly the inclusive-versus-exclusive distinction that
   * cost v1 a double free.
   */
  inside(until: Scope): Scope[] {
    const out: Scope[] = [];
    for (let index = this.#stack.length - 1; index >= 0; index -= 1) {
      const scope = this.#stack[index]!;
      if (scope.id === until.id) return out;
      out.push(scope);
    }
    throw new Error("the scope being unwound to is not on the stack");
  }

  /** Every scope, innermost first. What a `return` unwinds. */
  all(): Scope[] {
    return [...this.#stack].reverse();
  }
}

/** Where `break` and `continue` go, and what they have to release to get there. */
interface LoopFrame {
  readonly breakTo: BlockId;
  readonly continueTo: BlockId;
  /**
   * The scope the loop statement itself lives in. Everything opened inside it
   * is released on the way out; it is not.
   */
  readonly enclosing: Scope;
}

export function lower(
  program: ts.Program,
  checker: ts.TypeChecker,
  moduleName: string,
  options: {
    readonly requireMain?: boolean;
    readonly root?: string;
    /** The entry file. Its exports are the build's public ABI. */
    readonly entry?: string;
  } = {},
): LowerResult {
  return new Lowerer(
    program,
    checker,
    moduleName,
    options.requireMain ?? true,
    options.root ?? "",
    options.entry ?? "",
  ).run();
}

interface FnSignature {
  readonly params: readonly { name: string; type: MachineType }[];
  readonly returns: MachineType;
}

/**
 * A function the module can call.
 *
 * `imported` is a function declared with no body — an `extern "C"` symbol some
 * other library defines. It is classified by the C rules on both halves of the
 * call, because the recorded signature is the only thing the two sides share.
 */
type FnRecord =
  | {
      readonly kind: "defined";
      readonly id: FuncId;
      readonly sig: SigId;
      readonly signature: FnSignature;
      /** The name as written, before any qualification. */
      readonly name: string;
      readonly exported: boolean;
    }
  | {
      readonly kind: "imported";
      readonly sig: SigId;
      readonly signature: FnSignature;
      readonly name: string;
      readonly exported: boolean;
      /** Where it was declared, for the span on the extern when one is made. */
      readonly declaration: ts.FunctionDeclaration;
    };

/** One member of a class, waiting for its body to be lowered. */
type ClassBody =
  | { readonly kind: "destructor"; readonly info: ClassInfo; readonly builder: FunctionBuilder }
  | {
      readonly kind: "constructor";
      readonly info: ClassInfo;
      /** Absent when the class declares none and the constructor is generated. */
      readonly node: ts.ConstructorDeclaration | undefined;
      readonly builder: FunctionBuilder;
      readonly params: readonly { name: string; type: MachineType }[];
    }
  | {
      readonly kind: "method";
      readonly info: ClassInfo;
      readonly node: ts.MethodDeclaration;
      readonly builder: FunctionBuilder;
      readonly params: readonly { name: string; type: MachineType }[];
      readonly returns: MachineType;
    };

/**
 * Whether a value of this type has anything to release.
 *
 * A *lookup on the type*, which is the whole point — v1's `ownsAllocation`
 * asked the same question of an expression's *node kind* and got it wrong at
 * one site out of every six (REWRITE-PLAN §4.1).
 */
/**
 * A short, stable tag for a module, from its path.
 *
 * FNV-1a over the file name. Used to qualify the symbols of *internal*
 * functions, which nothing outside this compilation may name — so the tag needs
 * to be unique and an assembler-legal identifier, and needs to be nothing else.
 */
function moduleTag(fileName: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < fileName.length; index += 1) {
    hash ^= fileName.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function needsDrop(type: MachineType): boolean {
  switch (type.kind) {
    case "string":
    case "array":
    case "class":
      return true;
    case "fixedArray":
      return needsDrop(type.element);
    case "struct":
      return type.fields.some((field) => needsDrop(field.type));
    default:
      return false;
  }
}

class Lowerer {
  readonly #program: ts.Program;
  readonly #checker: ts.TypeChecker;
  readonly #mir: ModuleBuilder;
  readonly #diagnostics: Diagnostic[] = [];
  readonly #functions = new Map<string, FnRecord>();

  /**
   * A key that is unique across the whole program.
   *
   * Two files may each declare a private `helper`, and both are legal — the
   * names are scoped to their modules, and tsc says so. Keying the function
   * table by the bare name makes the second overwrite the first, and emitting
   * both under that name is a duplicate-symbol error from Cranelift with no
   * file and no line, which is precisely the failure REWRITE-PLAN §8 forbids.
   */
  #keyOf(node: ts.Node, name: string): string {
    return `${node.getSourceFile().fileName}#${name}`;
  }

  /**
   * The symbol a function is emitted under.
   *
   * An **exported** function keeps its bare name: that is the C ABI contract,
   * it is what the generated header declares, and it is what a `.def` file
   * names. An **internal** one is qualified by its module, because nothing
   * outside this compilation may refer to it and two modules may each have one.
   *
   * The qualifier is a hash rather than the path: a path contains characters no
   * assembler accepts, and its length is unbounded.
   */
  #symbolOf(node: ts.Node, name: string, exported: boolean): string {
    if (exported) return name;
    return `${name}$${moduleTag(this.#relative(node.getSourceFile().fileName))}`;
  }

  /**
   * A file's path relative to the project root.
   *
   * The tag is derived from this rather than from the absolute path, so that
   * the same sources produce the same symbols on two machines and in two
   * checkouts. An absolute path would make the golden MIR churn on every move
   * and a build unreproducible for no reason.
   */
  #relative(fileName: string): string {
    const path = fileName.replaceAll("\\", "/");
    if (this.#root !== "" && path.startsWith(`${this.#root}/`)) {
      return path.slice(this.#root.length + 1);
    }
    return path;
  }

  /**
   * Resolve a called name to the function it names, through **tsc**.
   *
   * By symbol rather than by string, which is what makes an import work: the
   * name at the call site and the name at the declaration are the same symbol
   * even when they are spelled differently, and two same-named privates in
   * different files are different symbols even though they are spelled alike.
   */
  resolveCallee(expression: ts.Expression): FnRecord | undefined {
    let symbol = this.#checker.getSymbolAtLocation(expression);
    if (symbol === undefined) return undefined;
    // An imported name is an *alias* for the thing it imports.
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = this.#checker.getAliasedSymbol(symbol);
    }
    const declaration = symbol.declarations?.find(ts.isFunctionDeclaration);
    if (declaration?.name === undefined) return undefined;
    return this.#functions.get(this.#keyOf(declaration, declaration.name.text));
  }

  readonly #requireMain: boolean;
  readonly #root: string;
  readonly #entry: string;

  constructor(
    program: ts.Program,
    checker: ts.TypeChecker,
    moduleName: string,
    requireMain: boolean,
    root: string,
    entry: string,
  ) {
    this.#program = program;
    this.#checker = checker;
    this.#mir = new ModuleBuilder(moduleName);
    this.#requireMain = requireMain;
    this.#root = root.replaceAll("\\", "/");
    this.#entry = entry.replaceAll("\\", "/");
  }

  /**
   * Whether a declaration is part of the build's **public ABI**.
   *
   * REWRITE-PLAN §3 asks whether `export` means "visible to other Goblin
   * modules" or "visible to the dynamic linker", and warns that v1 conflates
   * them. They are different things and this is where they separate.
   *
   * `export` is TypeScript's word for *importable*, and a program is one
   * compilation, so an exported function another module calls needs no C ABI at
   * all — it is an ordinary internal call, free to take a `string`.
   *
   * The **entry module's** exports are the public surface: they are what a
   * `static-lib` publishes, what the generated header declares, and what a DLL
   * names in its `.def`. Those are classified by the platform's C rules and
   * limited to plain data (`GF0301`). Everything else is internal, whatever it
   * says in the source.
   */
  #isPublic(node: ts.Node, exported: boolean): boolean {
    if (!exported) return false;
    if (this.#entry === "") return true;
    return node.getSourceFile().fileName.replaceAll("\\", "/") === this.#entry;
  }

  run(): LowerResult {
    const sources = this.#program
      .getSourceFiles()
      .filter(
        (file) =>
          !file.isDeclarationFile && !this.#program.isSourceFileFromExternalLibrary(file),
      );

    // Classes come first and in their own phase, because a top-level function
    // may take one as a parameter, and because a class's methods have to exist
    // as functions before anything can put them in a vtable.
    const classBodies = this.#declareClasses();

    // Two passes: declare every function before lowering any body, so a call
    // to something defined further down the file resolves.
    const declared: { node: ts.FunctionDeclaration; builder: FunctionBuilder }[] = [];
    for (const source of sources) {
      for (const statement of source.statements) {
        const one = this.#declare(statement);
        if (one) declared.push(one);
      }
    }

    for (const body of classBodies) this.#lowerClassBody(body);
    for (const { node, builder } of declared) {
      this.#lowerBody(node, builder);
    }

    // A `bin` needs `main`: the platform C runtime calls it by that symbol, and
    // without it the failure is an unresolved-external from the linker with no
    // file and no line — the shape of error REWRITE-PLAN §8 exists to prevent.
    // A library needs no entry point at all, which is most of what makes it a
    // library.
    const hasMain = [...this.#functions.values()].some(
      (record) => record.kind === "defined" && record.exported && record.name === "main",
    );
    if (this.#requireMain && !hasMain) {
      const first = sources[0];
      if (first !== undefined) {
        this.error(
          first,
          "GF0004",
          "this is a `bin` target and it exports no `main`. Add " +
            "`export function main(): i32`, or build it as a library with " +
            "`type: \"static-lib\"` or `type: \"shared-lib\"`.",
        );
      }
    }

    if (this.#diagnostics.some((d) => d.severity === "error")) {
      return { module: undefined, diagnostics: this.#diagnostics };
    }
    return { module: this.#mir.finish(), diagnostics: this.#diagnostics };
  }

  // -- classes -------------------------------------------------------------

  #classes = new Map<string, ClassInfo>();
  readonly #classTys = new Map<string, TyId>();
  readonly #classIds = new Map<string, ClassId>();

  /** The interned `TyId` of a class, by name. */
  classTy(name: string): TyId | undefined {
    return this.#classTys.get(name);
  }

  classInfo(name: string): ClassInfo | undefined {
    return this.#classes.get(name);
  }

  /** The record for a function emitted under a generated symbol. */
  fn(symbol: string): FnRecord | undefined {
    return this.#functions.get(symbol);
  }

  /**
   * The class an expression denotes, seeing through one `Reference<T>`, or
   * `undefined`.
   *
   * Answered from tsc directly and **without reporting anything**, so a caller
   * can use it to decide *whether* a construct is about a class before
   * committing to lowering it as one.
   */
  /**
   * The element type, when this expression is a `T[]` or a reference to one.
   *
   * A *probe*: it answers `undefined` rather than reporting, because the caller
   * is deciding whether a property access is an array call at all and most of
   * them are not.
   */
  arrayElementAt(expression: ts.Expression): MachineType | undefined {
    const type = this.#checker.getTypeAtLocation(expression);
    const candidates = type.isIntersection() ? type.types : [type];
    for (const part of candidates) {
      if (!this.#checker.isArrayType(part)) continue;
      const element = this.#checker.getIndexTypeOfType(part, ts.IndexKind.Number);
      if (element === undefined) continue;
      return this.erase(expression, element);
    }
    return undefined;
  }

  classNameAt(expression: ts.Expression): string | undefined {
    const type = this.#checker.getTypeAtLocation(expression);
    const direct = classNameOf(type);
    if (direct !== null && this.#classes.has(direct)) return direct;
    // `Reference<C>` is `C & ReferenceCore<C>`, so the class is one of the
    // intersection's members rather than the type itself.
    if (type.isIntersection()) {
      for (const part of type.types) {
        const name = classNameOf(part);
        if (name !== null && this.#classes.has(name)) return name;
      }
    }
    return undefined;
  }

  /**
   * Register every class, and every function each one owns.
   *
   * Four sub-phases, and the order between them is the whole reason this is not
   * inline in {@link Lowerer.run}:
   *
   * 1. reserve a `ClassId` and a `TyId` per class, so `Reference<Self>` can be
   *    interned while the class is still being described;
   * 2. declare the constructor, the destructor and every method as ordinary
   *    functions, so a vtable slot has a `FuncId` to hold;
   * 3. fill in each class's flattened fields and vtable;
   * 4. hand the bodies back to be lowered after top-level functions are
   *    declared, so a method can call one.
   */
  #declareClasses(): ClassBody[] {
    this.#classes = collectClasses(this.#program, this.#checker, {
      unsupported: (node, what) => this.unsupported(node, what),
      refuse: (node, message) => this.error(node, "GF0002", message),
      erase: (at, type) => this.erase(at, type),
    });

    for (const [name, info] of this.#classes) {
      const id = this.#mir.declareClass({
        name,
        base: (info.base ? this.#classIds.get(info.base.name) : null) ?? null,
        span: this.span(info.node),
      });
      this.#classIds.set(name, id);
      this.#classTys.set(name, this.#mir.ty({ kind: "Class", value: id }));
    }

    const bodies: ClassBody[] = [];
    for (const info of this.#classes.values()) {
      const self: MachineType = { kind: "class", name: info.name };
      const selfRef: MachineType = { kind: "reference", referent: self };

      // The destructor. Compiler-generated: there is no syntax for one, and
      // there does not need to be — a class holding a `string` releases it
      // because the field's own type says so.
      bodies.push({
        kind: "destructor",
        info,
        builder: this.#declareClassFn(info.destructorSymbol, [selfRef], VOID, info.node),
      });

      // A constructor is emitted whenever there is construction to do, which is
      // not the same as whenever one is written: a class whose fields carry
      // initialisers has work to do without declaring one, and so does a class
      // that only derives from such a class.
      if (info.constructorSymbol !== undefined) {
        const params = info.ctor === undefined ? [] : this.#classFnParams(info.ctor);
        if (params !== undefined) {
          bodies.push({
            kind: "constructor",
            info,
            node: info.ctor,
            builder: this.#declareClassFn(
              info.constructorSymbol,
              [selfRef, ...params.map((p) => p.type)],
              VOID,
              info.ctor ?? info.node,
            ),
            params,
          });
        }
      }

      for (const method of info.methods.values()) {
        // An inherited method belongs to the class that declared it and is
        // emitted once, there.
        if (method.owner !== info.name) continue;
        const params = this.#classFnParams(method.declaration);
        if (params === undefined) continue;
        const signature = this.#checker.getSignatureFromDeclaration(method.declaration);
        const returns =
          signature === undefined
            ? undefined
            : this.erase(
                method.declaration.type ?? method.declaration,
                this.#checker.getReturnTypeOfSignature(signature),
              );
        if (returns === undefined) {
          this.unsupported(method.declaration, "a method tsc could not give a signature to");
          continue;
        }
        bodies.push({
          kind: "method",
          info,
          node: method.declaration,
          builder: this.#declareClassFn(
            method.symbol,
            [selfRef, ...params.map((p) => p.type)],
            returns,
            method.declaration,
          ),
          params,
          returns,
        });
      }
    }

    for (const [name, info] of this.#classes) {
      const id = this.#classIds.get(name);
      if (id === undefined) continue;
      const vtable: FuncId[] = [];
      let complete = true;
      for (const symbol of info.slots) {
        const record = this.#functions.get(symbol);
        if (record === undefined || record.kind !== "defined") {
          // Only reachable when a member failed to lower, which has already
          // been reported. Leaving the class out keeps one bad method from
          // becoming a second, more confusing error about a missing vtable.
          complete = false;
          break;
        }
        vtable.push(record.id);
      }
      if (!complete) continue;

      this.#mir.defineClass(id, {
        fields: info.fields.map((field) => ({
          name: field.name,
          ty: this.tyOf(field.type, field.declaration),
          span: this.span(field.declaration),
        })),
        ownFields: info.ownFieldsAt,
        vtable,
      });
    }

    // Declared `implements`, registered eagerly and **after** `defineClass`,
    // which rewrites the list wholesale.
    //
    // A static conversion registers its own itab at the conversion site, so
    // this is not what makes those work. It is what makes a *dynamic* cast
    // work: `tryCast<Pet>(x)` searches the object's type descriptor, and a
    // class whose only mention of `Pet` is in another module — or in no
    // module, because nothing converted it statically — would have an empty
    // table and answer "no" to a question whose answer is yes.
    for (const info of this.#classes.values()) {
      for (const clause of info.node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const expression of clause.types) {
          const contract = this.#contractFrom(expression);
          if (contract === undefined) continue;
          this.tyOf(contract, expression);
          this.implement(info.name, contract, expression);
        }
      }
    }

    return bodies;
  }

  /** The contract named by an `implements` clause entry, if it is one. */
  #contractFrom(
    expression: ts.ExpressionWithTypeArguments,
  ): Extract<MachineType, { kind: "interface" }> | undefined {
    try {
      const contract = contractOf(
        this.#checker,
        this.#checker.getTypeAtLocation(expression),
      );
      return contract?.kind === "interface" ? contract : undefined;
    } catch (error) {
      if (error instanceof ErasureError) {
        this.error(expression, error.code, error.message);
        return undefined;
      }
      throw error;
    }
  }

  #classFnParams(
    node: ts.ConstructorDeclaration | ts.MethodDeclaration,
  ): { name: string; type: MachineType }[] | undefined {
    const params: { name: string; type: MachineType }[] = [];
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name)) {
        this.unsupported(parameter, "a destructured parameter");
        return undefined;
      }
      if (parameter.questionToken || parameter.dotDotDotToken || parameter.initializer) {
        this.unsupported(parameter, "an optional, rest, or defaulted parameter");
        return undefined;
      }
      if (ts.canHaveModifiers(parameter) && (ts.getModifiers(parameter)?.length ?? 0) > 0) {
        // `constructor(private x: i32)` declares a field as a side effect of a
        // parameter. It is a real convenience and it is also a second place
        // fields come from; one place is worth more here than the shorthand.
        this.unsupported(parameter, "a parameter property");
        return undefined;
      }
      const type = this.erase(parameter, this.#checker.getTypeAtLocation(parameter));
      if (type === undefined) return undefined;
      params.push({ name: parameter.name.text, type });
    }
    return params;
  }

  #declareClassFn(
    symbol: string,
    params: MachineType[],
    returns: MachineType,
    at: ts.Node,
  ): FunctionBuilder {
    const sig = this.#mir.sig({
      params: params.map((param) => ({ ty: this.tyOf(param, at), name: null })),
      ret: this.tyOf(returns, at),
      abi: "Internal",
    });
    const builder = this.#mir.declareFunction({
      name: symbol,
      sig,
      linkage: "Internal",
      span: this.span(at),
    });
    this.#functions.set(symbol, {
      kind: "defined",
      id: builder.id,
      sig,
      name: symbol,
      exported: false,
      signature: {
        params: params.map((type, index) => ({ name: index === 0 ? "this" : `p${index}`, type })),
        returns,
      },
    });
    return builder;
  }

  // -- declarations --------------------------------------------------------

  #declare(
    statement: ts.Statement,
  ): { node: ts.FunctionDeclaration; builder: FunctionBuilder } | undefined {
    // Type-only declarations are erased. They shape the program's types and
    // contribute no code, so there is nothing here to lower and nothing to
    // complain about.
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      statement.kind === ts.SyntaxKind.EmptyStatement
    ) {
      return undefined;
    }
    // Handled by `#declareClasses`, which ran before this and needed to: a
    // function here may take a class as a parameter.
    if (ts.isClassDeclaration(statement)) return undefined;
    if (!ts.isFunctionDeclaration(statement)) {
      this.unsupported(statement, describe(statement));
      return undefined;
    }
    if (statement.name === undefined) {
      this.unsupported(statement, "an anonymous function declaration");
      return undefined;
    }
    // A function with no body is an `extern "C"` import: some other library
    // defines it, and the declaration is the only thing the two sides share.
    if (statement.body === undefined) {
      this.#declareImport(statement);
      return undefined;
    }
    if (statement.typeParameters && statement.typeParameters.length > 0) {
      // REWRITE-PLAN §11.7 — monomorphisation or nothing — is still open. Until
      // it is answered this is a gap rather than a rule, which is what GF0001
      // means.
      this.unsupported(statement.typeParameters[0]!, "a generic function");
      return undefined;
    }

    const name = statement.name.text;
    const exported =
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    // `export` makes it importable; being an entry-module export makes it part
    // of the build's public ABI. Only the second is a C boundary.
    const isPublic = this.#isPublic(statement, exported);

    const signature = this.#signature(statement);
    if (signature === undefined) return undefined;

    // An exported function is a boundary, so what crosses it has to be
    // something both sides can agree about. Checked here rather than left to
    // the backend's classifier: that one panics, and REWRITE-PLAN §8 says a
    // program tsc accepted must never reach it.
    if (isPublic && statement.body !== undefined) {
      let crossable = true;
      signature.params.forEach((param, index) => {
        const at = statement.parameters[index] ?? statement;
        if (!this.#checkCBoundary(param.type, at, `the parameter \`${param.name}\``)) {
          crossable = false;
        }
      });
      if (!this.#checkCBoundary(signature.returns, statement.type ?? statement, "the return")) {
        crossable = false;
      }
      if (!crossable) return undefined;
    }

    // An exported function is a C entry point: something outside this module
    // calls it by its symbol, so it is classified by the C rules. `main` in
    // particular is called by the platform C runtime.
    const sig = this.#mir.sig({
      params: signature.params.map((param) => ({
        ty: this.tyOf(param.type, statement),
        name: null,
      })),
      ret: this.tyOf(signature.returns, statement),
      abi: isPublic ? "C" : "Internal",
    });

    if (isPublic && name === "main" && !this.#checkEntryPoint(statement, signature)) {
      return undefined;
    }

    const builder = this.#mir.declareFunction({
      name: this.#symbolOf(statement, name, isPublic),
      sig,
      linkage: isPublic ? "Export" : "Internal",
      span: this.span(statement),
    });

    this.#functions.set(this.#keyOf(statement, name), {
      kind: "defined",
      id: builder.id,
      sig,
      signature,
      name,
      exported: isPublic,
    });
    return { node: statement, builder };
  }

  /**
   * A function declared with no body: an `extern "C"` symbol.
   *
   * Its signature is classified by the platform's C rules on both halves of the
   * call, which is the point — REWRITE-PLAN §6 asks that both sides read the
   * same recorded shape, so that an internal call to an exported function
   * agrees with itself.
   *
   * The MIR extern is **not** made here, only the record that can make one. An
   * extern in the module is an undefined symbol in the object file, so
   * declaring it eagerly means declaring a library's surface and calling half
   * of it fails to link on the half you did not call — which is not how a C
   * header behaves. {@link externIdOf} makes it at the first call site.
   */
  #declareImport(node: ts.FunctionDeclaration): void {
    if (node.name === undefined) return;
    const name = node.name.text;
    const key = this.#keyOf(node, name);
    if (this.#functions.has(key)) return;

    // A body-less declaration is only an import when nothing in this build
    // defines it. TypeScript's overload signatures are body-less too, and they
    // belong to a function whose implementation is the very next declaration —
    // treating one as an `extern "C"` import drops the implementation and asks
    // the linker for a symbol the program was about to define itself.
    if (this.#hasImplementation(node)) return;

    const signature = this.#signature(node);
    if (signature === undefined) return;

    const sig = this.#mir.sig({
      params: signature.params.map((param) => ({
        ty: this.tyOf(param.type, node),
        name: null,
      })),
      ret: this.tyOf(signature.returns, node),
      abi: "C",
    });
    this.#functions.set(key, {
      kind: "imported",
      sig,
      signature,
      name,
      exported: true,
      declaration: node,
    });
  }

  /** Whether some other declaration of this name in this build has a body. */
  #hasImplementation(node: ts.FunctionDeclaration): boolean {
    const symbol = node.name === undefined ? undefined : this.#checker.getSymbolAtLocation(node.name);
    return (
      symbol?.declarations?.some(
        (declaration) =>
          ts.isFunctionDeclaration(declaration) && declaration.body !== undefined,
      ) ?? false
    );
  }

  /**
   * The MIR extern for an imported function, made on first use.
   *
   * Memoised by C name, exactly as {@link runtimeFn} is, and for the same
   * reason: an extern is an undefined symbol, so the module should carry one
   * only for a symbol it actually calls.
   */
  externIdOf(record: Extract<FnRecord, { kind: "imported" }>): ExternId {
    const existing = this.#externs.get(record.name);
    if (existing !== undefined) return existing;
    const id = this.#mir.extern({
      name: record.name,
      sig: record.sig,
      span: this.span(record.declaration),
    });
    this.#externs.set(record.name, id);
    return id;
  }

  /**
   * Whether a type may cross the C boundary, reporting if it may not.
   *
   * The same rule the backend's `require_plain_data` enforces, said in the
   * frontend where there is a node to point at. The backend keeps its copy as
   * defence in depth — it should now be unreachable.
   */
  #checkCBoundary(type: MachineType, at: ts.Node, what: string): boolean {
    // `string` is deliberately absent from this list. It is a valid,
    // nul-terminated `char *` — the runtime lays it out that way on purpose —
    // so C reads one with no conversion, and ownership becomes the documented,
    // manual thing it is in every C API that hands out memory. `T[]` is not:
    // its elements are laid out for this compiler and its header is a shape
    // nothing else knows.
    const reason =
      type.kind === "array"
        ? "owns a heap buffer whose elements are laid out for this compiler, and " +
          "nothing outside this build knows that shape"
        : type.kind === "class"
          ? "is a class, so it carries a vtable pointer that only means something inside this build"
          : type.kind === "interface"
            ? "is an interface reference: a pair of pointers into this build's own tables"
            : type.kind === "struct" && type.fields.some((f) => needsDrop(f.type))
              ? "has a field that owns a heap buffer. A `string` may cross on its " +
                "own, where the signature makes the question visible and a doc " +
                "comment can answer it — buried in a struct there is nothing to " +
                "see and nothing to document"
              : type.kind === "fixedArray" && needsDrop(type.element)
                ? "has elements that own a heap buffer"
                : undefined;
    if (reason === undefined) return true;
    this.error(
      at,
      "GF0301",
      `${what} is a \`${renderType(type)}\`, which ${reason}. An exported ` +
        "function is called from outside this build, so it can only take and " +
        "return plain data — the fixed widths, `boolean`, a struct of those, or " +
        "a `Pointer<T>` and a length.",
    );
    return false;
  }

  #signature(node: ts.FunctionDeclaration): FnSignature | undefined {
    const params: { name: string; type: MachineType }[] = [];
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name)) {
        this.unsupported(parameter, "a destructured parameter");
        return undefined;
      }
      if (parameter.questionToken || parameter.dotDotDotToken || parameter.initializer) {
        this.unsupported(parameter, "an optional, rest, or defaulted parameter");
        return undefined;
      }
      const type = this.erase(parameter, this.#checker.getTypeAtLocation(parameter));
      if (type === undefined) return undefined;
      params.push({ name: parameter.name.text, type });
    }

    const signature = this.#checker.getSignatureFromDeclaration(node);
    if (signature === undefined) {
      this.unsupported(node, "a function tsc could not give a signature to");
      return undefined;
    }
    const returns = this.erase(
      node.type ?? node,
      this.#checker.getReturnTypeOfSignature(signature),
    );
    if (returns === undefined) return undefined;

    return { params, returns };
  }

  /** `main` is called by the platform C runtime, so it has to look like C's. */
  #checkEntryPoint(node: ts.FunctionDeclaration, signature: FnSignature): boolean {
    if (!(signature.returns.kind === "scalar" && signature.returns.name === "i32")) {
      this.error(
        node.type ?? node,
        "GF0004",
        "`main` must return `i32` — it is called by the platform C runtime and " +
          `its result becomes the process exit code. This one returns ` +
          `\`${renderType(signature.returns)}\`.`,
      );
      return false;
    }
    if (signature.params.length !== 0) {
      this.error(
        node.parameters[0] ?? node,
        "GF0004",
        "`main` takes no arguments yet. The argc/argv pair arrives with arrays " +
          "and strings, in milestone 5.",
      );
      return false;
    }
    return true;
  }

  /**
   * Lower one member of a class.
   *
   * `this` is bound as an ordinary local of type `Reference<Self>` — a borrow,
   * always, never a by-value object (REWRITE-PLAN §4.6). v1 typed it as a plain
   * object parameter and got away with it because internal calls pass
   * addresses; with a C struct ABI in place that would mean every method
   * mutating a copy.
   */
  #lowerClassBody(body: ClassBody): void {
    const self: MachineType = {
      kind: "reference",
      referent: { kind: "class", name: body.info.name },
    };
    const scopes = new Scopes();
    scopes.declare("this", {
      local: LocalId(1),
      type: self,
      ty: this.tyOf(self, body.info.node),
    });

    if (body.kind === "destructor") {
      this.#lowerDestructor(body, scopes);
      return;
    }

    body.params?.forEach((param, index) => {
      scopes.declare(param.name, {
        local: LocalId(index + 2),
        type: param.type,
        ty: this.tyOf(param.type, body.node ?? body.info.node),
      });
    });

    const returns = body.kind === "constructor" ? VOID : (body.returns ?? VOID);
    const lowerer = new BodyLowerer(this, body.builder, scopes, returns);
    lowerer.setClassContext(body.info, body.kind === "constructor");
    if (body.kind === "constructor") {
      lowerer.runConstructor(body.info, body.node?.body);
      return;
    }
    if (body.node?.body !== undefined) lowerer.run(body.node.body);
  }

  /**
   * The generated destructor: release this class's **own** fields in reverse
   * declaration order, then run the base's.
   *
   * Own fields only, because the base destructor releases the base's — running
   * the flattened list here would free every inherited field twice. Reverse
   * order because destruction is construction backwards, and base last because
   * a derived object is built base-first.
   */
  #lowerDestructor(body: ClassBody, scopes: Scopes): void {
    const info = body.info;
    const builder = body.builder;
    const block = builder.block();
    const self = LocalId(1);

    for (let index = info.fields.length - 1; index >= info.ownFieldsAt; index -= 1) {
      const field = info.fields[index]!;
      if (!needsDrop(field.type)) continue;
      builder.push(block, {
        kind: "Drop",
        place: {
          local: self,
          projection: [{ kind: "Deref" }, { kind: "Field", value: FieldId(index) }],
        },
        flag: null,
        unwind: { kind: "Unreachable" },
      });
    }

    if (info.base !== undefined) {
      const base = this.#functions.get(info.base.destructorSymbol);
      if (base !== undefined && base.kind === "defined") {
        const after = builder.block();
        builder.seal(block, {
          kind: "Call",
          callee: { kind: "Direct", value: { kind: "Local", value: base.id } },
          args: [{ kind: "Borrow", value: { local: self, projection: [] } }],
          destination: { place: { local: LocalId(0), projection: [] }, target: after },
          unwind: { kind: "Unreachable" },
        });
        builder.seal(after, { kind: "Return" });
        void scopes;
        return;
      }
    }

    builder.seal(block, { kind: "Return" });
    void scopes;
  }

  #lowerBody(node: ts.FunctionDeclaration, builder: FunctionBuilder): void {
    const record = this.#functions.get(this.#keyOf(node, node.name!.text));
    if (record === undefined || node.body === undefined) return;

    const scopes = new Scopes();
    record.signature.params.forEach((param, index) => {
      scopes.declare(param.name, {
        local: LocalId(index + 1),
        type: param.type,
        ty: this.tyOf(param.type, node),
      });
    });

    // The entry point, and only for a `bin`: a library has no `main` of its
    // own, and the program that does have one is somebody else's.
    const isEntry =
      this.#requireMain && record.kind === "defined" && record.exported && record.name === "main";
    new BodyLowerer(this, builder, scopes, record.signature.returns).run(node.body, isEntry);
  }

  // -- shared services -----------------------------------------------------

  get mir(): ModuleBuilder {
    return this.#mir;
  }

  get checker(): ts.TypeChecker {
    return this.#checker;
  }

  get functions(): ReadonlyMap<string, FnRecord> {
    return this.#functions;
  }

  /** The MIR type id for an erased machine type. */
  tyOf(type: MachineType, at: ts.Node): TyId {
    switch (type.kind) {
      case "void":
        return this.#mir.ty({ kind: "Void" });
      case "bool":
        return this.#mir.ty({ kind: "Bool" });
      case "string":
        return this.#mir.ty({ kind: "Str" });
      case "cstring":
        return this.#mir.ty({ kind: "CStr" });
      case "struct":
        return this.#structTy(type, at);
      case "class": {
        const ty = this.classTy(type.name);
        if (ty === undefined) {
          this.unsupported(at, `the class \`${type.name}\``);
          return this.#mir.ty({ kind: "Void" });
        }
        return ty;
      }
      case "interface":
        return this.#interfaceTy(type, at);
      case "reference":
        return this.#mir.ty({ kind: "Reference", value: this.tyOf(type.referent, at) });
      case "pointer":
        return this.#mir.ty({ kind: "Pointer", value: this.tyOf(type.pointee, at) });
      case "fixedArray":
        return this.#mir.ty({
          kind: "FixedArray",
          element: this.tyOf(type.element, at),
          length: BigInt(type.length),
        });
      case "array":
        return this.#mir.ty({ kind: "Array", value: this.tyOf(type.element, at) });
      case "scalar":
        if (type.name === "f32" || type.name === "f64") {
          return this.#mir.ty({
            kind: "Float",
            value: type.name === "f32" ? "F32" : "F64",
          });
        }
        return this.#mir.ty({ kind: "Int", value: INT_TY[type.name] });
      default:
        this.unsupported(at, `the type \`${renderType(type)}\``);
        return this.#mir.ty({ kind: "Void" });
    }
  }

  readonly #externs = new Map<string, ExternId>();

  /**
   * Declare a runtime function, once per module.
   *
   * Ordinary `extern "C"` imports called with ordinary `Call` terminators.
   * There is no privileged channel into the runtime, and a MIR dump shows the
   * calls, which is where you want to see them.
   */
  runtimeFn(name: string, params: MachineType[], ret: MachineType, at: ts.Node): ExternId {
    const existing = this.#externs.get(name);
    if (existing !== undefined) return existing;
    const id = this.#mir.extern({
      name,
      sig: this.#mir.sig({
        params: params.map((param) => ({ ty: this.tyOf(param, at), name: null })),
        ret: this.tyOf(ret, at),
        abi: "C",
      }),
    });
    this.#externs.set(name, id);
    return id;
  }

  readonly #structs = new Map<string, TyId>();

  /**
   * Intern a struct type by name.
   *
   * By name rather than by shape: erasure already decided what the name is, and
   * two types with the same fields in a different order are different layouts.
   * Interning by shape would silently merge them.
   */
  #structTy(type: Extract<MachineType, { kind: "struct" }>, at: ts.Node): TyId {
    const existing = this.#structs.get(type.name);
    if (existing !== undefined) return existing;

    // Reserved before the fields are erased, so a struct that (later) contains
    // a pointer to itself does not recurse forever.
    const id = this.#mir.struct({
      name: type.name,
      fields: type.fields.map((field) => ({
        name: field.name,
        ty: this.tyOf(field.type, at),
      })),
    });
    const ty = this.#mir.ty({ kind: "Struct", value: id });
    this.#structs.set(type.name, ty);
    return ty;
  }

  readonly #interfaces = new Map<string, InterfaceId>();
  readonly #interfaceTys = new Map<string, TyId>();
  readonly #interfaceInfo = new Map<string, Extract<MachineType, { kind: "interface" }>>();

  /**
   * Intern a contract by name, declaring it and its method signatures.
   *
   * The receiver of an interface method is typed `Pointer<void>` rather than
   * `Reference<Self>`: the whole point of dispatch is that the implementing
   * class is not known here, and every candidate's `this` is one machine word
   * whatever class it belongs to, so the Cranelift signature is identical
   * either way. Naming it as an opaque address says that on purpose.
   */
  #interfaceTy(
    type: Extract<MachineType, { kind: "interface" }>,
    at: ts.Node,
  ): TyId {
    const existing = this.#interfaceTys.get(type.name);
    if (existing !== undefined) return existing;

    const id = this.#mir.declareInterface({ name: type.name, span: this.span(at) });
    this.#interfaces.set(type.name, id);
    this.#interfaceInfo.set(type.name, type);
    const ty = this.#mir.ty({ kind: "Interface", value: id });
    this.#interfaceTys.set(type.name, ty);

    const receiver = this.#mir.ty({
      kind: "Pointer",
      value: this.#mir.ty({ kind: "Void" }),
    });
    this.#mir.defineInterface(
      id,
      type.methods.map((method) => ({
        name: method.name,
        sig: this.#mir.sig({
          params: [
            { ty: receiver, name: null },
            ...method.params.map((param) => ({ ty: this.tyOf(param, at), name: null })),
          ],
          ret: this.tyOf(method.returns, at),
          abi: "Internal",
        }),
      })),
    );
    return ty;
  }

  interfaceId(name: string): InterfaceId | undefined {
    return this.#interfaces.get(name);
  }

  classId(name: string): ClassId | undefined {
    return this.#classIds.get(name);
  }

  interfaceInfo(name: string): Extract<MachineType, { kind: "interface" }> | undefined {
    return this.#interfaceInfo.get(name);
  }

  /**
   * Record a class → contract conversion, resolving the itab's entries.
   *
   * The entries are a **gather from the vtable**: the class's final overrider
   * for each of the interface's methods, in the interface's own slot order. No
   * search happens at run time and none happens in the backend.
   */
  readonly #implemented = new Set<string>();

  implement(className: string, contract: Extract<MachineType, { kind: "interface" }>, at: ts.Node): boolean {
    // Idempotent, and it has to be: the propagation below re-enters this for
    // every derived class, and a three-deep hierarchy would otherwise walk
    // itself forever.
    const key = `${className}\0${contract.name}`;
    if (this.#implemented.has(key)) return true;
    this.#implemented.add(key);

    const classId = this.#classIds.get(className);
    const info = this.#classes.get(className);
    const interfaceId = this.#interfaces.get(contract.name);
    if (classId === undefined || info === undefined || interfaceId === undefined) {
      this.unsupported(at, `converting \`${className}\` to \`${contract.name}\``);
      return false;
    }

    const methods: FuncId[] = [];
    for (const wanted of contract.methods) {
      const found = info.methods.get(wanted.name);
      const record = found === undefined ? undefined : this.#functions.get(found.symbol);
      if (found === undefined || record === undefined || record.kind !== "defined") {
        // tsc has already checked the shape, so a genuine mismatch never gets
        // here — reaching this means the two disagree about what satisfies
        // what, which is a compiler bug rather than a user one.
        this.unsupported(
          at,
          `converting \`${className}\` to \`${contract.name}\`, whose method ` +
            `\`${wanted.name}\` this compiler could not resolve`,
        );
        return false;
      }
      methods.push(record.id);
    }

    this.#mir.implementInterface(classId, interfaceId, methods);

    // Every class derived from this one satisfies the contract too, and needs
    // **its own** itab holding **its own** final overriders. Inheriting the
    // base's would make a dynamic cast on a `Derived` hand back `Base`'s
    // methods — the right shape and the wrong bodies, which is the quiet kind
    // of wrong. So the table is flattened here, the same way fields and vtable
    // slots are flattened in `classes.ts`.
    for (const [derivedName, derived] of this.#classes) {
      if (derivedName === className) continue;
      let base = derived.base;
      let inherits = false;
      while (base !== undefined) {
        if (base.name === className) {
          inherits = true;
          break;
        }
        base = base.base;
      }
      if (inherits) this.implement(derivedName, contract, at);
    }
    return true;
  }

  erase(at: ts.Node, type: ts.Type): MachineType | undefined {
    try {
      return erase(this.#checker, type);
    } catch (error) {
      if (error instanceof ErasureError) {
        this.error(at, error.code, error.message);
        return undefined;
      }
      throw error;
    }
  }

  span(node: ts.Node) {
    const source = node.getSourceFile();
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { file: this.#mir.file(source.fileName), line: line + 1, col: character + 1 };
  }

  unsupported(node: ts.Node, what: string): void {
    this.error(
      node,
      "GF0001",
      `${what} is not supported yet. This is a gap in the compiler rather than a ` +
        `rule about the language.`,
    );
  }

  error(node: ts.Node, code: string, message: string): void {
    const source = node.getSourceFile();
    const start = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    this.#diagnostics.push({
      severity: "error",
      code,
      source: "goblin",
      message,
      location: {
        file: source.fileName,
        line: line + 1,
        column: character + 1,
        length: Math.max(1, node.getEnd() - start),
      },
    });
  }
}

/**
 * Lowers one function body into basic blocks.
 *
 * The current block is a cursor: statements append to it, and control flow
 * seals it and moves the cursor. When the cursor is `undefined` the code that
 * follows is unreachable, and statements are dropped rather than appended to a
 * block that has already returned.
 */
class BodyLowerer {
  readonly #outer: Lowerer;
  readonly #f: FunctionBuilder;
  readonly #scopes: Scopes;
  readonly #returns: MachineType;
  /** Memoised {@link width} results, so each node is judged — and reported — once. */
  readonly #widths = new Map<ts.Node, Width>();
  /**
   * Temporaries created by the full-expression currently being lowered, in
   * order of creation. REWRITE-PLAN §4.4 adopts C++'s rule verbatim: a
   * temporary dies at the end of the full-expression that made it, in reverse
   * order of creation.
   */
  readonly #temporaries: LocalId[] = [];
  readonly #loops: LoopFrame[] = [];
  /** Locals that have been moved from, and the name they were moved under. */
  readonly #moved = new Map<LocalId, string>();
  #current: BlockId | undefined;

  /** The class whose member is being lowered, when one is. */
  #self: ClassInfo | undefined;
  #inConstructor = false;

  constructor(outer: Lowerer, f: FunctionBuilder, scopes: Scopes, returns: MachineType) {
    this.#outer = outer;
    this.#f = f;
    this.#scopes = scopes;
    this.#returns = returns;
  }

  setClassContext(info: ClassInfo, inConstructor: boolean): void {
    this.#self = info;
    this.#inConstructor = inConstructor;
  }

  // -- classes -------------------------------------------------------------

  /**
   * Resolve a subject to the class it is, seeing through one `Reference<T>`.
   *
   * A method's `this` is a `Reference<Self>`, and a local holding an object is
   * the object; a field access has to work on both without the caller caring
   * which it has. Seeing through the reference here is what `Projection::Deref`
   * exists for — nothing is ever *retyped*, which is the v1 bug REWRITE-PLAN
   * §10 opens with.
   */
  #asClass(subject: Typed): { info: ClassInfo; place: Place } | undefined {
    let type = subject.type;
    const extra: Place["projection"] = [];
    if (type.kind === "reference" && type.referent.kind === "class") {
      extra.push({ kind: "Deref" });
      type = type.referent;
    }
    if (type.kind !== "class") return undefined;
    const info = this.#outer.classInfo(type.name);
    if (info === undefined) return undefined;
    if (subject.operand.kind === "Const") return undefined;
    const base = subject.operand.value;
    return {
      info,
      place: { local: base.local, projection: [...base.projection, ...extra] },
    };
  }

  #fieldOf(info: ClassInfo, name: string): { index: number; type: MachineType } | undefined {
    const index = info.fields.findIndex((field) => field.name === name);
    if (index < 0) return undefined;
    return { index, type: info.fields[index]!.type };
  }

  /** `this`, as a `Reference<Self>` borrowed from the parameter holding it. */
  #thisTyped(at: ts.Node): Typed | undefined {
    const binding = this.#scopes.lookup("this");
    if (binding === undefined || this.#self === undefined) {
      this.#outer.error(
        at,
        "GF0002",
        "`this` is only meaningful inside a method or a constructor.",
      );
      return undefined;
    }
    return { operand: { kind: "Borrow", value: placeOf(binding.local) }, type: binding.type };
  }

  /**
   * `new C(a, b)`.
   *
   * Two steps, both written down rather than implied: `Default` zeroes the
   * storage **and installs the vtable pointer**, so the object is dispatchable
   * — and therefore destructible — before the constructor runs a line; then the
   * constructor is an ordinary call taking `Reference<Self>`.
   */
  #new(expression: ts.NewExpression): Typed | undefined {
    if (!ts.isIdentifier(expression.expression)) {
      this.#outer.unsupported(expression, "an expression after `new`");
      return undefined;
    }
    const name = expression.expression.text;
    const info = this.#outer.classInfo(name);
    if (info === undefined) {
      this.#outer.unsupported(expression, `\`new ${name}\``);
      return undefined;
    }
    const type: MachineType = { kind: "class", name };
    const ty = this.#outer.tyOf(type, expression);

    const local = this.#f.addLocal({
      ty,
      storage: "Temporary",
      span: this.#outer.span(expression),
    });
    this.#push({ kind: "StorageLive", value: local });
    this.#push({ kind: "Init", place: placeOf(local), rvalue: { kind: "Default" } });
    this.#temporaries.push(local);

    const args = this.#classCallArgs(
      expression,
      info,
      info.constructorSymbol,
      expression.arguments ?? ts.factory.createNodeArray(),
      this.#refTo(expression, placeOf(local), type),
    );
    if (args === undefined) return undefined;
    if (args !== null) {
      const record = this.#outer.fn(info.constructorSymbol!);
      if (record === undefined || record.kind !== "defined") return undefined;
      this.#callDirect(record.id, args, undefined);
    } else if ((expression.arguments?.length ?? 0) > 0) {
      this.#outer.error(
        expression,
        "GF0002",
        `\`${name}\` declares no constructor, so \`new ${name}\` takes no arguments.`,
      );
      return undefined;
    }

    return { operand: { kind: "Move", value: placeOf(local) }, type, temporary: local };
  }

  /**
   * Marshal the arguments of a constructor or method call, with the receiver
   * first.
   *
   * Returns `null` when there is no such function to call — a class with no
   * constructor — so that the caller can tell "nothing to do" from "something
   * went wrong", which `undefined` already means.
   */
  #classCallArgs(
    at: ts.Node,
    info: ClassInfo,
    symbol: string | undefined,
    args: readonly ts.Expression[],
    receiver: Operand,
  ): Operand[] | undefined | null {
    if (symbol === undefined) return null;
    const record = this.#outer.fn(symbol);
    if (record === undefined) {
      this.#outer.unsupported(at, `a call to \`${info.name}\`'s \`${symbol}\``);
      return undefined;
    }
    // Parameter 0 is the receiver; the declared parameters follow it.
    const expected = record.signature.params.slice(1);
    if (args.length !== expected.length) {
      this.#outer.error(
        at,
        "GF0002",
        `this takes ${expected.length} argument${expected.length === 1 ? "" : "s"}, ` +
          `and ${args.length} ${args.length === 1 ? "was" : "were"} supplied.`,
      );
      return undefined;
    }
    const out: Operand[] = [receiver];
    for (const [index, argument] of args.entries()) {
      const want = expected[index]!.type;
      const value = this.#expressionTyped(argument, want);
      if (value === undefined) return undefined;
      out.push(this.#forArgument(argument, value));
    }
    return out;
  }

  /**
   * `&place`, as an operand.
   *
   * A reference is one machine word and a `Borrow`, so it needs a local to live
   * in but never needs releasing. Reading it back with `Copy` is right: a
   * reference is trivially copied, and copying one does not end the original.
   */
  #refTo(at: ts.Node, place: Place, referent: MachineType): Operand {
    const type: MachineType = { kind: "reference", referent };
    const local = this.#f.addLocal({
      ty: this.#outer.tyOf(type, at),
      storage: "Temporary",
      span: this.#outer.span(at),
    });
    this.#push({ kind: "StorageLive", value: local });
    this.#push({ kind: "Init", place: placeOf(local), rvalue: { kind: "Ref", value: place } });
    return { kind: "Copy", value: placeOf(local) };
  }

  /** A call whose result is discarded, or lands in a fresh temporary. */
  #callDirect(id: FuncId, args: Operand[], destination: LocalId | undefined): void {
    const block = this.#current;
    if (block === undefined) return;
    const next = this.#f.block();
    const place = placeOf(destination ?? LocalId(0));
    this.#f.seal(block, {
      kind: "Call",
      callee: { kind: "Direct", value: { kind: "Local", value: id } },
      args,
      destination: { place, target: next },
      unwind: { kind: "Unreachable" },
    });
    this.#current = next;
  }


  run(body: ts.Block, isEntry = false): void {
    this.#current = this.#f.block();
    // The runtime's one initialisation point, before the program's first
    // statement. An ordinary `extern "C"` call like every other runtime call —
    // it shows up in a MIR dump, which is where you want to see it, and it is
    // linked because it is *called* rather than because a platform happened to
    // pull in a constructor.
    if (isEntry) this.#callRuntimeVoid(body, RUNTIME.init);
    this.#block(body);
    // Falling off the end of a `void` function is a return. tsc has already
    // rejected falling off the end of one that returns a value.
    if (this.#current !== undefined) this.#seal({ kind: "Return" });
  }

  /** Call a `void` runtime function that takes nothing, purely for its effect. */
  #callRuntimeVoid(at: ts.Node, name: string): void {
    const id = this.#outer.runtimeFn(name, [], VOID, at);
    const next = this.#f.block();
    this.#seal({
      kind: "Call",
      callee: { kind: "Direct", value: { kind: "Extern", value: id } },
      args: [],
      destination: { place: placeOf(LocalId(0)), target: next },
      unwind: NO_UNWIND,
    });
    this.#current = next;
  }

  /**
   * `Class$new` — the base's construction, then the field initialisers, then
   * whatever the declared constructor's body says.
   *
   * That is C++'s order and it is the whole of why this is not simply `run`.
   * A default member initialiser runs *after* the base subobject is complete
   * and *before* the constructor body, so a base constructor writing a field
   * cannot be undone by a derived initialiser, and a constructor body assigning
   * over an initialised field wins. Running the initialisers at the `new` site
   * instead would put every class's ahead of every base constructor body, which
   * is the same answer only until one of them looks at the other's work.
   *
   * `body` is absent when the class declares no constructor and this one exists
   * only to run initialisers — its own, the base's, or both.
   */
  runConstructor(info: ClassInfo, body: ts.Block | undefined): void {
    this.#current = this.#f.block();

    if (body === undefined) {
      // Generated. tsc is not here to insist on `super()`, so the base call is
      // written out rather than waited for.
      if (info.base?.needsConstructor === true) this.#callBaseConstructor(info, info.node);
      this.#fieldInitialisers(info);
    } else if (info.base === undefined) {
      // No base, so no `super()` to wait behind: the initialisers are the first
      // thing that happens.
      this.#fieldInitialisers(info);
      this.#block(body);
    } else {
      // tsc requires `super()` in the constructor of a derived class, so the
      // initialisers are emitted from there — which is where C++ runs them.
      this.#pendingInitialisers = info;
      this.#block(body);
    }

    if (this.#current !== undefined) this.#seal({ kind: "Return" });
  }

  /**
   * The class whose field initialisers are waiting for a `super()` to finish.
   *
   * Cleared as soon as they are emitted, so a second `super()` — which tsc
   * rejects anyway — could not run them twice.
   */
  #pendingInitialisers: ClassInfo | undefined;

  /** Run the initialisers held back for the base construction to finish. */
  #emitPendingInitialisers(): void {
    const info = this.#pendingInitialisers;
    if (info === undefined) return;
    this.#pendingInitialisers = undefined;
    this.#fieldInitialisers(info);
  }

  /**
   * `this.field = <initialiser>` for each of this class's own initialised
   * fields, in declaration order.
   *
   * Own fields only: the base's were run by the base's constructor, and running
   * the flattened list here would run an inherited initialiser twice — the
   * construction-side twin of the double free the destructor avoids by the same
   * rule.
   */
  #fieldInitialisers(info: ClassInfo): void {
    for (const field of info.initialisedFields) {
      const initialiser = field.declaration.initializer;
      if (initialiser === undefined) continue;
      const index = info.fields.indexOf(field);
      if (index < 0) continue;

      // Each initialiser is its own full-expression, so whatever temporaries it
      // makes die at the end of it — the same rule a statement gets, and the
      // reason a `class C { s: string = "a" + "b" }` in a loop does not
      // accumulate the concatenation's intermediates.
      this.#fullExpression(() => {
        const value = this.#expressionTyped(initialiser, field.type);
        if (value === undefined) return;
        // `Assign` rather than `Init`, and the same node `this.x = …` uses in a
        // constructor body: the storage was zeroed by `Default` before the
        // constructor was called, so an owning field holds an empty value that
        // is released before the new one lands.
        this.#push({
          kind: "Assign",
          place: {
            local: LocalId(1),
            projection: [{ kind: "Deref" }, { kind: "Field", value: FieldId(index) }],
          },
          rvalue: { kind: "Use", value: this.#forStorage(value) },
        });
      });
    }
  }

  /** `Base$new(this)`, for a generated constructor that has no `super()` to read. */
  #callBaseConstructor(info: ClassInfo, at: ts.Node): void {
    const base = info.base;
    if (base?.constructorSymbol === undefined) return;
    const record = this.#outer.fn(base.constructorSymbol);
    if (record === undefined || record.kind !== "defined") {
      this.#outer.unsupported(at, `a call to \`${base.name}\`'s constructor`);
      return;
    }
    this.#callDirect(record.id, [{ kind: "Copy", value: placeOf(LocalId(1)) }], undefined);
  }

  // -- statements ----------------------------------------------------------

  #block(node: ts.Block): void {
    const scope = this.#scopes.push();
    for (const statement of node.statements) {
      if (this.#current === undefined) break;
      this.#statement(statement);
    }
    // Falling out of a block ends its locals. An early exit released them
    // already and left `#current` undefined, so this does not double up.
    this.#endScope(scope);
    this.#scopes.pop();
  }

  #statement(statement: ts.Statement): void {
    if (ts.isReturnStatement(statement)) return this.#return(statement);
    if (ts.isVariableStatement(statement)) return this.#declaration(statement);
    if (ts.isIfStatement(statement)) return this.#if(statement);
    if (ts.isWhileStatement(statement)) return this.#while(statement);
    if (ts.isForStatement(statement)) return this.#for(statement);
    if (ts.isBreakStatement(statement)) return this.#break(statement);
    if (ts.isContinueStatement(statement)) return this.#continue(statement);
    if (ts.isBlock(statement)) return this.#block(statement);
    if (ts.isExpressionStatement(statement)) return this.#expressionStatement(statement);
    if (statement.kind === ts.SyntaxKind.EmptyStatement) return;
    this.#outer.unsupported(statement, describe(statement));
  }

  #return(statement: ts.ReturnStatement): void {
    const mark = this.#temporaries.length;
    if (statement.expression !== undefined) {
      const value = this.#returnValue(statement.expression);
      if (value === undefined) return;
      // The return place is local 0, always. For a register-sized value the
      // backend loads it; for an aggregate the caller designated the storage.
      // One mechanism, not two (REWRITE-PLAN §4.5).
      this.#push({ kind: "Init", place: placeOf(LocalId(0)), rvalue: { kind: "Use", value } });
    }
    // The return value is already in place, so releasing everything else is
    // safe — including the temporaries the return expression itself made.
    this.#endTemporaries(mark);
    for (const scope of this.#scopes.all()) this.#endScope(scope);
    this.#seal({ kind: "Return" });
  }

  /**
   * The value of a `return`, moved rather than copied where that is what it is.
   *
   * `return local` is a move and always has been (REWRITE-PLAN §4.4). It is the
   * one move nobody has to write, because there is nothing else it could mean:
   * the local is about to go out of scope, so copying it and then destroying
   * the original is an allocation and a free with no observable difference.
   *
   * **A by-value parameter is not such a local**, and this is the one place the
   * distinction is invisible in the source. `return s` and `return move(s)`
   * lower to the same move, so the rule `GF0236` states has to hold for both:
   * the caller releases a by-value argument when the call ends (REWRITE-PLAN
   * §11.4), and an owning value travels as a one-word handle (§4.5), so the
   * callee's parameter is a *different local* holding the same buffer. Moving
   * out of it hands the buffer to the caller and leaves the caller's own
   * release still to come — the double free `GF0236` exists to prevent.
   *
   * Where the written `move` is an error, though, this is a copy. `return s` is
   * exactly the read of an owning value that copies everywhere else in the
   * language, and copying is what C++ produces here too once its own implicit
   * move is unavailable — so the answer is the same, and only the allocation
   * differs.
   */
  #returnValue(expression: ts.Expression): Operand | undefined {
    if (ts.isIdentifier(expression) && sameType(this.#returns, this.#widthType(expression))) {
      const binding = this.#scopes.lookup(expression.text);
      if (binding !== undefined && this.#owns(binding.type) && !this.#isOwningParameter(binding)) {
        if (this.#readMoved(expression, binding.local, expression.text)) return undefined;
        this.#moved.set(binding.local, expression.text);
        return { kind: "Move", value: placeOf(binding.local) };
      }
    }
    const value = this.#expressionTyped(expression, this.#returns);
    return value === undefined ? undefined : this.#forStorage(value);
  }

  #widthType(expression: ts.Expression): MachineType {
    const width = this.width(expression);
    return width.kind === "typed" ? width.type : VOID;
  }

  /** Whether a value of this type has anything to destroy. */
  #owns(type: MachineType): boolean {
    return needsDrop(type);
  }

  /**
   * Whether a by-value argument needs a copy the *caller* makes.
   *
   * A scalar is copied by being put in a register, so passing it is already the
   * copy. Anything that travels by address or by handle is not: without an
   * explicit copy the callee would be writing through to the caller's value,
   * which is precisely the value semantics this language is built on
   * (REWRITE-PLAN §4.5).
   */
  #needsCallerCopy(type: MachineType): boolean {
    return (
      this.#owns(type) ||
      type.kind === "struct" ||
      type.kind === "fixedArray" ||
      type.kind === "class"
    );
  }

  #break(statement: ts.BreakStatement): void {
    const frame = this.#loops[this.#loops.length - 1];
    if (frame === undefined || statement.label !== undefined) {
      this.#outer.unsupported(statement, statement.label ? "a labelled break" : "`break` here");
      return;
    }
    this.#exitLoop(frame, frame.breakTo);
  }

  #continue(statement: ts.ContinueStatement): void {
    const frame = this.#loops[this.#loops.length - 1];
    if (frame === undefined || statement.label !== undefined) {
      this.#outer.unsupported(
        statement,
        statement.label ? "a labelled continue" : "`continue` here",
      );
      return;
    }
    this.#exitLoop(frame, frame.continueTo);
  }

  /**
   * Leave a loop, releasing exactly the scopes opened inside it.
   *
   * The scope holding the loop statement is **not** released here: it lives
   * outside the breakable block and is released by that block's own exit.
   * Releasing it here as well is v1's double free, and it only ever fires when
   * the subject owns something — which is why it survived so long
   * (REWRITE-PLAN §10).
   */
  #exitLoop(frame: LoopFrame, target: BlockId): void {
    for (const scope of this.#scopes.inside(frame.enclosing)) this.#endScope(scope);
    this.#seal({ kind: "Goto", value: target });
  }

  // -- scopes and temporaries ---------------------------------------------

  /**
   * Release a scope's locals, in reverse order of declaration.
   *
   * `StorageDead` is all this emits. Where a `Drop` belongs is not a question
   * the lowerer answers — the drop elaboration pass decides that from the
   * initialisedness of each local at each point, which is what makes the
   * decision impossible to get wrong one site at a time (REWRITE-PLAN §5.1).
   */
  #endScope(scope: Scope): void {
    for (let index = scope.locals.length - 1; index >= 0; index -= 1) {
      this.#push({ kind: "StorageDead", value: scope.locals[index]! });
    }
  }

  /**
   * Run `body` as one full-expression, ending any temporaries it creates.
   *
   * REWRITE-PLAN §4.4 takes C++'s rule verbatim, because it is well understood
   * and it is what people will expect.
   */
  #fullExpression<T>(body: () => T): T {
    const mark = this.#temporaries.length;
    const result = body();
    this.#endTemporaries(mark);
    return result;
  }

  #endTemporaries(mark: number): void {
    for (let index = this.#temporaries.length - 1; index >= mark; index -= 1) {
      this.#push({ kind: "StorageDead", value: this.#temporaries[index]! });
    }
    this.#temporaries.length = mark;
  }

  /**
   * Branch on a condition, ending the condition's temporaries on both edges.
   *
   * A condition's temporaries have to outlive the branch that reads them — the
   * terminator is part of the same full-expression — so they cannot simply be
   * released before sealing. And they cannot be released at the top of the
   * *targets* either, because a target is reachable from more than one place:
   * a loop's exit block is entered both by the condition failing and by
   * `break`, and a `StorageDead` there would run twice on the `break` path.
   *
   * So each edge gets a block of its own. Cranelift folds the empty ones away,
   * and the alternative is a double free that only appears once conditions
   * start producing values that own something.
   */
  #branchEndingTemporaries(
    cond: Operand,
    mark: number,
    thenTarget: BlockId,
    elseTarget: BlockId,
  ): void {
    const dying: LocalId[] = [];
    for (let index = this.#temporaries.length - 1; index >= mark; index -= 1) {
      dying.push(this.#temporaries[index]!);
    }
    this.#temporaries.length = mark;

    if (dying.length === 0) {
      this.#seal({ kind: "Branch", cond, thenBlock: thenTarget, elseBlock: elseTarget });
      return;
    }

    const onTrue = this.#f.block();
    const onFalse = this.#f.block();
    this.#seal({ kind: "Branch", cond, thenBlock: onTrue, elseBlock: onFalse });

    for (const [edge, target] of [
      [onTrue, thenTarget],
      [onFalse, elseTarget],
    ] as const) {
      for (const local of dying) {
        this.#f.push(edge, { kind: "StorageDead", value: local });
      }
      this.#f.seal(edge, { kind: "Goto", value: target });
    }
  }

  #declaration(statement: ts.VariableStatement): void {
    this.#declarationList(statement.declarationList);
  }

  #declarationList(list: ts.VariableDeclarationList): void {
    for (const declaration of list.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        this.#outer.unsupported(declaration, "a destructuring binding");
        return;
      }
      if (declaration.initializer === undefined) {
        this.#outer.unsupported(declaration, "a binding without an initialiser");
        return;
      }

      // The annotation is what gives a binding its width. Without one, the
      // initialiser's own width is used — and if the initialiser is built only
      // from literals there is nothing to take a width from, which is the one
      // case that has to be reported rather than guessed.
      const type = this.#bindingType(declaration);
      if (type === undefined) return;

      const ty = this.#outer.tyOf(type, declaration);
      const local = this.#f.addLocal({
        ty,
        // A binding owns what it holds and its scope destroys it. For the
        // trivial types this milestone covers there is nothing to destroy, but
        // the storage class is recorded from the start rather than inferred
        // later — that is the whole point of REWRITE-PLAN §4.2.
        storage: "Owned",
        name: declaration.name.text,
        span: this.#outer.span(declaration),
      });

      // The initialiser's temporaries die at the end of *this* declaration —
      // after the value has been moved into the binding, not before.
      const name = declaration.name.text;
      const initializer = declaration.initializer;
      this.#fullExpression(() => {
        const value = this.#expressionTyped(initializer, type);
        if (value === undefined) return;
        // REWRITE-PLAN §4.4: **no lifetime extension.** C++ keeps a temporary
        // bound to a `const&` alive for as long as the reference; here that is
        // rejected instead, because extending a lifetime puts ownership back
        // into the compiler's inference and keeping it out is the reason
        // `Reference<T>` is written rather than deduced.
        //
        // Only a *binding* can outlive the temporary. Passing one as an
        // argument is fine and stays fine — the call finishes inside the
        // enclosing full-expression.
        if (value.borrowsTemporary === true) {
          this.#outer.error(
            initializer,
            "GF0234",
            "nothing owns this value, so it would be released at the end of " +
              "this statement and the reference would outlive it. Bind it to a " +
              "name first, then take a reference to that.",
          );
          return;
        }
        this.#push({ kind: "StorageLive", value: local });
        this.#push({
          kind: "Init",
          place: placeOf(local),
          rvalue: { kind: "Use", value: this.#forStorage(value) },
        });
        this.#scopes.declare(name, { local, type, ty });
      });
    }
  }

  #bindingType(declaration: ts.VariableDeclaration): MachineType | undefined {
    if (declaration.type !== undefined) {
      return this.#outer.erase(
        declaration.type,
        this.#outer.checker.getTypeAtLocation(declaration.type),
      );
    }
    const width = this.width(declaration.initializer!);
    if (width.kind === "error") return undefined;
    if (width.kind === "typed") return width.type;
    this.#outer.error(
      declaration,
      "GF0161",
      `\`${declaration.name.getText()}\` has no width: its initialiser is built ` +
        "only from literals, and a literal takes its width from context rather " +
        "than having one of its own. Annotate the binding.",
    );
    return undefined;
  }

  #if(statement: ts.IfStatement): void {
    const mark = this.#temporaries.length;
    const cond = this.#condition(statement.expression);
    if (cond === undefined) return;

    const thenBlock = this.#f.block();
    const elseBlock = statement.elseStatement ? this.#f.block() : undefined;
    const joinBlock = this.#f.block();

    this.#branchEndingTemporaries(cond, mark, thenBlock, elseBlock ?? joinBlock);

    this.#current = thenBlock;
    this.#statement(statement.thenStatement);
    if (this.#current !== undefined) this.#seal({ kind: "Goto", value: joinBlock });

    if (statement.elseStatement && elseBlock !== undefined) {
      this.#current = elseBlock;
      this.#statement(statement.elseStatement);
      if (this.#current !== undefined) this.#seal({ kind: "Goto", value: joinBlock });
    }

    this.#current = joinBlock;
  }

  #while(statement: ts.WhileStatement): void {
    const enclosing = this.#scopes.innermost;
    const head = this.#f.block();
    const body = this.#f.block();
    const exit = this.#f.block();

    this.#seal({ kind: "Goto", value: head });
    this.#current = head;
    this.#loopCondition(statement.expression, body, exit);

    this.#current = body;
    this.#loops.push({ breakTo: exit, continueTo: head, enclosing });
    this.#statement(statement.statement);
    this.#loops.pop();
    if (this.#current !== undefined) this.#seal({ kind: "Goto", value: head });

    this.#current = exit;
  }

  /**
   * A `for` loop, desugared into its four parts.
   *
   * The initialiser gets a scope of its own, so `for (let i: i32 = 0; …)` binds
   * `i` for the loop and nothing after it — and `continue` releases the body's
   * scopes but not `i`, which is what makes the update expression still able to
   * read it.
   */
  #for(statement: ts.ForStatement): void {
    const outer = this.#scopes.push();

    if (statement.initializer !== undefined) {
      if (ts.isVariableDeclarationList(statement.initializer)) {
        this.#declarationList(statement.initializer);
      } else {
        this.#fullExpression(() => {
          this.#value(statement.initializer as ts.Expression, undefined);
        });
      }
    }

    const head = this.#f.block();
    const body = this.#f.block();
    const update = this.#f.block();
    const exit = this.#f.block();

    this.#seal({ kind: "Goto", value: head });
    this.#current = head;
    if (statement.condition === undefined) {
      this.#seal({ kind: "Goto", value: body });
    } else {
      this.#loopCondition(statement.condition, body, exit);
    }

    this.#current = body;
    // `continue` goes to the update, not to the condition: skipping the update
    // is how a `for` loop turns into an infinite one.
    this.#loops.push({ breakTo: exit, continueTo: update, enclosing: outer });
    this.#statement(statement.statement);
    this.#loops.pop();
    if (this.#current !== undefined) this.#seal({ kind: "Goto", value: update });

    this.#current = update;
    if (statement.incrementor !== undefined) {
      this.#fullExpression(() => {
        this.#expressionValue(statement.incrementor!);
      });
    }
    this.#seal({ kind: "Goto", value: head });

    this.#current = exit;
    this.#endScope(outer);
    this.#scopes.pop();
  }

  /**
   * Emit a loop's condition test.
   *
   * A constant-true condition becomes an unconditional jump, so the exit block
   * is never referenced and is simply dropped. Emitting a conditional branch to
   * a block that is then never filled is a Cranelift verifier error, not a
   * warning, and `while (true) { return; }` is one keystroke away
   * (REWRITE-PLAN §10).
   */
  #loopCondition(expression: ts.Expression, body: BlockId, exit: BlockId): void {
    if (expression.kind === ts.SyntaxKind.TrueKeyword) {
      this.#seal({ kind: "Goto", value: body });
      return;
    }
    const mark = this.#temporaries.length;
    const cond = this.#condition(expression);
    if (cond === undefined) return;
    this.#branchEndingTemporaries(cond, mark, body, exit);
  }

  #expressionStatement(statement: ts.ExpressionStatement): void {
    this.#fullExpression(() => {
      this.#expressionValue(statement.expression);
    });
  }

  /** Lower an expression whose value is discarded. */
  #expressionValue(expression: ts.Expression): void {
    if (ts.isCallExpression(expression)) {
      this.#value(expression, undefined);
      return;
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      this.#assignment(expression);
      return;
    }
    this.#outer.unsupported(expression, "this expression as a statement");
  }

  #assignment(expression: ts.BinaryExpression): void {
    if (ts.isPropertyAccessExpression(expression.left)) {
      this.#fieldAssignment(expression.left, expression.right);
      return;
    }
    if (ts.isElementAccessExpression(expression.left)) {
      const target = this.#elementPlace(expression.left);
      if (target === undefined) return;
      const value = this.#expressionTyped(expression.right, target.element);
      if (value === undefined) return;
      // `Assign`: the element holds a live value, and for an owning element
      // that value is destroyed before the new one lands.
      this.#push({
        kind: "Assign",
        place: target.place,
        rvalue: { kind: "Use", value: this.#forStorage(value) },
      });
      return;
    }
    if (!ts.isIdentifier(expression.left)) {
      this.#outer.unsupported(expression.left, "assigning to anything but a local");
      return;
    }
    const binding = this.#scopes.lookup(expression.left.text);
    if (binding === undefined) {
      this.#outer.unsupported(expression.left, "assigning to a non-local name");
      return;
    }
    const value = this.#expressionTyped(expression.right, binding.type);
    if (value === undefined) return;
    // `Assign`, not `Init`: the destination holds a live value, and for an
    // owning type that value has to be destroyed before the new one lands.
    this.#push({
      kind: "Assign",
      place: placeOf(binding.local),
      rvalue: { kind: "Use", value: this.#forStorage(value) },
    });
    // The binding holds a value again, so a `move` before this one no longer
    // says anything about reading it. This is C++'s rule for a moved-from
    // object: it is empty rather than invalid, and assigning to it is how you
    // put it back into a known state. Without this, a `let` could never be
    // reused after being moved out of — which is the ordinary shape of handing
    // a buffer on from inside a loop.
    //
    // The right-hand side is lowered *first*, so `s = s` and `s = f(move(s))`
    // still see the move that precedes them.
    this.#moved.delete(binding.local);
  }

  /**
   * `p.x = 1` — assigning through a field.
   *
   * `Assign` rather than `Init`: the field holds a live value, and for an
   * owning field that value is destroyed before the new one lands.
   */
  #fieldAssignment(target: ts.PropertyAccessExpression, source: ts.Expression): void {
    const subject = this.#value(target.expression, undefined);
    if (subject === undefined) return;

    const asClass = this.#asClass(subject);
    if (asClass !== undefined) {
      const field = this.#fieldOf(asClass.info, target.name.text);
      if (field === undefined) {
        this.#outer.unsupported(target, `\`${asClass.info.name}.${target.name.text}\``);
        return;
      }
      const value = this.#expressionTyped(source, field.type);
      if (value === undefined) return;
      // `Assign` even inside a constructor, and it is safe there because
      // `Default` zeroed the object first: releasing a zeroed owning field is
      // a no-op all the way down (`gf_string_free(null)` returns).
      this.#push({
        kind: "Assign",
        place: {
          local: asClass.place.local,
          projection: [...asClass.place.projection, { kind: "Field", value: FieldId(field.index) }],
        },
        rvalue: { kind: "Use", value: this.#forStorage(value) },
      });
      return;
    }

    if (subject.type.kind !== "struct") {
      this.#outer.unsupported(target, "assigning to this property");
      return;
    }
    const index = this.#fieldIndex(subject.type, target.name.text);
    const field = subject.type.fields[index];
    if (field === undefined) {
      this.#outer.unsupported(target, `the field \`${target.name.text}\``);
      return;
    }
    const place = this.#placeOfSubject(target, subject);
    if (place === undefined) return;

    const value = this.#expressionTyped(source, field.type);
    if (value === undefined) return;
    this.#push({
      kind: "Assign",
      place: {
        local: place.local,
        projection: [...place.projection, { kind: "Field", value: FieldId(index) }],
      },
      rvalue: { kind: "Use", value: this.#forStorage(value) },
    });
  }

  // -- the width pass ------------------------------------------------------

  /**
   * The width an expression has on its own terms.
   *
   * Memoised, and the only place a width diagnostic is raised — the lowering
   * walk that follows consults this rather than re-deriving anything, so no
   * error is reported twice and no rule is applied in two places.
   */
  width(expression: ts.Expression): Width {
    const cached = this.#widths.get(expression);
    if (cached !== undefined) return cached;
    const computed = this.#computeWidth(expression);
    this.#widths.set(expression, computed);
    return computed;
  }

  #computeWidth(expression: ts.Expression): Width {
    if (ts.isParenthesizedExpression(expression)) return this.width(expression.expression);

    // A literal has no width of its own; it takes one from wherever it lands.
    if (ts.isNumericLiteral(expression)) return POLY;

    // A string literal does: there is only one string type.
    if (ts.isStringLiteralLike(expression)) return typed(STRING);
    if (ts.isTemplateExpression(expression)) return typed(STRING);

    if (ts.isPropertyAccessExpression(expression)) return this.#propertyWidth(expression);
    if (ts.isElementAccessExpression(expression)) return this.#elementWidth(expression);
    // An object literal has no type of its own, the same way a numeric literal
    // has no width of its own: it is an initialiser for whatever struct is
    // expected. Erasing what tsc infers for it in isolation gives an anonymous
    // shape whose fields are plain `number`, which is both wrong and unhelpful.
    if (ts.isObjectLiteralExpression(expression)) return POLY;

    if (
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return typed({ kind: "bool" });
    }

    if (ts.isIdentifier(expression)) {
      const binding = this.#scopes.lookup(expression.text);
      if (binding === undefined) {
        this.#outer.unsupported(expression, `the name \`${expression.text}\``);
        return ERROR;
      }
      return typed(binding.type);
    }

    // A ternary has whatever type its arms agree on. Either arm may be built
    // only from literals and take its width from the other — or from context,
    // when both are.
    if (ts.isConditionalExpression(expression)) {
      if (this.width(expression.condition).kind === "error") return ERROR;
      const whenTrue = this.width(expression.whenTrue);
      const whenFalse = this.width(expression.whenFalse);
      if (whenTrue.kind === "error" || whenFalse.kind === "error") return ERROR;
      if (whenTrue.kind === "poly") return whenFalse;
      if (whenFalse.kind === "poly") return whenTrue;
      if (!sameType(whenTrue.type, whenFalse.type)) {
        this.#outer.error(
          expression,
          "GF0161",
          `the two arms of this conditional are a \`${renderType(whenTrue.type)}\` and ` +
            `a \`${renderType(whenFalse.type)}\`. Both arms have to produce the same ` +
            "type, because the expression has one.",
        );
        return ERROR;
      }
      return whenTrue;
    }

    if (ts.isPrefixUnaryExpression(expression)) {
      if (expression.operator === ts.SyntaxKind.ExclamationToken) {
        return typed({ kind: "bool" });
      }
      return this.width(expression.operand);
    }

    if (expression.kind === ts.SyntaxKind.ThisKeyword) {
      const binding = this.#scopes.lookup("this");
      if (binding === undefined) {
        this.#outer.error(
          expression,
          "GF0002",
          "`this` is only meaningful inside a method or a constructor.",
        );
        return ERROR;
      }
      return typed(binding.type);
    }

    if (ts.isNewExpression(expression)) {
      if (!ts.isIdentifier(expression.expression)) {
        this.#outer.unsupported(expression, "an expression after `new`");
        return ERROR;
      }
      const name = expression.expression.text;
      if (this.#outer.classInfo(name) === undefined) {
        this.#outer.unsupported(expression, `\`new ${name}\``);
        return ERROR;
      }
      return typed({ kind: "class", name });
    }

    // `[a, b, c]` — the type comes from tsc, not from the elements, because
    // `[]` has no element to ask and the annotation is what says what it is.
    if (ts.isArrayLiteralExpression(expression)) {
      const type = this.#outer.erase(
        expression,
        this.#outer.checker.getContextualType(expression) ??
          this.#outer.checker.getTypeAtLocation(expression),
      );
      if (type === undefined) return ERROR;
      if (type.kind !== "array") {
        this.#outer.unsupported(expression, `an array literal of \`${renderType(type)}\``);
        return ERROR;
      }
      for (const element of expression.elements) {
        if (this.width(element).kind === "error") return ERROR;
      }
      return typed(type);
    }

    if (ts.isCallExpression(expression)) return this.#callWidth(expression);
    if (ts.isBinaryExpression(expression)) return this.#binaryWidth(expression);

    this.#outer.unsupported(expression, describe(expression));
    return ERROR;
  }

  /** `s.length` on a string, or a field of a struct or a class. */
  #propertyWidth(expression: ts.PropertyAccessExpression): Width {
    // Before the general path, and asked of tsc rather than of the width pass,
    // so that a field reached through a `Reference<C>` resolves the same way a
    // field of a value does.
    const className = this.#outer.classNameAt(expression.expression);
    if (className !== undefined) {
      const info = this.#outer.classInfo(className);
      const field = info?.fields.find((f) => f.name === expression.name.text);
      if (field !== undefined) return typed(field.type);
      if (info?.methods.has(expression.name.text) === true) {
        this.#outer.unsupported(expression, "a method used as a value");
        return ERROR;
      }
      this.#outer.unsupported(expression, `\`${className}.${expression.name.text}\``);
      return ERROR;
    }

    const subject = this.width(expression.expression);
    if (subject.kind === "error") return ERROR;
    if (subject.kind !== "typed") {
      this.#outer.unsupported(expression, "this property access");
      return ERROR;
    }

    if (subject.type.kind === "string" || subject.type.kind === "cstring") {
      if (expression.name.text === "length") return typed(USIZE);
      this.#outer.unsupported(
        expression,
        `\`${renderType(subject.type)}.${expression.name.text}\``,
      );
      return ERROR;
    }

    const array =
      subject.type.kind === "reference" ? subject.type.referent : subject.type;
    if (array.kind === "array" || array.kind === "fixedArray") {
      if (expression.name.text === "length") return typed(USIZE);
      this.#outer.unsupported(expression, `\`${expression.name.text}\` on an array`);
      return ERROR;
    }

    if (subject.type.kind === "struct") {
      const field = subject.type.fields.find((f) => f.name === expression.name.text);
      if (field === undefined) {
        this.#outer.unsupported(expression, `the field \`${expression.name.text}\``);
        return ERROR;
      }
      return typed(field.type);
    }

    this.#outer.unsupported(expression, "this property access");
    return ERROR;
  }

  /** `xs[i]` — the element type of whatever is being indexed. */
  #elementWidth(expression: ts.ElementAccessExpression): Width {
    const subject = this.width(expression.expression);
    if (subject.kind === "error") return ERROR;
    if (subject.kind !== "typed") {
      this.#outer.unsupported(expression, "indexing this");
      return ERROR;
    }
    const through =
      subject.type.kind === "reference" ? subject.type.referent : subject.type;
    const element = elementTypeOf(through);
    if (element === undefined) {
      this.#outer.unsupported(
        expression,
        `indexing a \`${renderType(subject.type)}\``,
      );
      return ERROR;
    }
    if (this.width(expression.argumentExpression).kind === "error") return ERROR;
    return typed(element);
  }

  /** The index of a field in its struct, which is its position in the layout. */
  #fieldIndex(type: Extract<MachineType, { kind: "struct" }>, name: string): number {
    return type.fields.findIndex((field) => field.name === name);
  }

  /**
   * Whether `xs.m(…)` is a call on a `T[]`, and what `T` is.
   *
   * Asked of **tsc**, never of the width pass, for the reason the method-call
   * path already documents about `console`: the width pass *reports*, so
   * running it over a receiver that turns out not to be an array raises a
   * diagnostic about a name before anything has decided this was not an array
   * call at all. `console.log` is a property access too.
   */
  #arrayElementAt(access: ts.PropertyAccessExpression): MachineType | undefined {
    return this.#outer.arrayElementAt(access.expression);
  }

  /**
   * The array a value denotes, seeing through one `Reference<T[]>`.
   *
   * The same job `#asClass` does for objects, and it exists for the same
   * reason: a reference is the *address of the handle*, so reaching the
   * elements is one `Deref` further down than it is from the array itself.
   * Nothing is ever retyped — the projection says which indirection is which.
   */
  #asArray(at: ts.Node, subject: Typed): { place: Place; element: MachineType } | undefined {
    const type = subject.type;
    const array =
      type.kind === "array"
        ? type
        : type.kind === "reference" && type.referent.kind === "array"
          ? type.referent
          : undefined;
    if (array === undefined) return undefined;

    const place = this.#placeOfSubject(at, subject);
    if (place === undefined) return undefined;
    return {
      place:
        type.kind === "reference"
          ? { local: place.local, projection: [...place.projection, { kind: "Deref" }] }
          : place,
      element: array.element,
    };
  }

  #callWidth(expression: ts.CallExpression): Width {
    // A constructor returns nothing; `super(…)` is a statement.
    if (expression.expression.kind === ts.SyntaxKind.SuperKeyword) return typed(VOID);

    if (ts.isPropertyAccessExpression(expression.expression)) {
      const method = this.#methodWidth(expression, expression.expression);
      if (method !== "not-a-method") return method;
      return this.#consoleWidth(expression);
    }
    if (!ts.isIdentifier(expression.expression)) {
      this.#outer.unsupported(expression.expression, "this call target");
      return ERROR;
    }
    if (expression.expression.text === NATIVE_CAST) {
      // The target width is the call's own type, which tsc has already
      // resolved from the type argument. Reading it from there rather than
      // from `typeArguments` means an aliased or inferred `T` still works.
      const target = this.#outer.erase(
        expression,
        this.#outer.checker.getTypeAtLocation(expression),
      );
      return target === undefined ? ERROR : typed(target);
    }

    if (expression.expression.text === FIXED_ARRAY) {
      // The *contextual* type first. `fixedArray(4, 0)` infers `T` from the
      // literal `0`, which is a plain `number` and has no width — the
      // annotation on the binding is what says `i32`, and it is the answer that
      // matters.
      const type = this.#outer.erase(
        expression,
        this.#outer.checker.getContextualType(expression) ??
          this.#outer.checker.getTypeAtLocation(expression),
      );
      return type === undefined ? ERROR : typed(type);
    }

    // `tryCast<T>(x)` is a `Reference<T>`, nullable. The nullability is tsc's
    // business and never reaches the machine type: the pair is the same
    // sixteen bytes either way, with a zero itab meaning "no".
    if (expression.expression.text === TRY_CAST) {
      const type = this.#tryCastTarget(expression);
      return type === undefined ? ERROR : typed(type);
    }

    // `cstring(s)` is a `CString` whatever it was handed.
    if (expression.expression.text === CSTRING) {
      const argument = expression.arguments[0];
      if (argument !== undefined && this.width(argument).kind === "error") return ERROR;
      return typed(CSTRING_TYPE);
    }

    if (expression.expression.text === CSTRING_FREE) {
      const argument = expression.arguments[0];
      if (argument !== undefined && this.width(argument).kind === "error") return ERROR;
      return typed(VOID);
    }

    // `move(x)` has whatever type `x` has; it changes ownership, not type.
    if (expression.expression.text === MOVE) {
      const argument = expression.arguments[0];
      if (expression.arguments.length !== 1 || argument === undefined) {
        this.#outer.error(expression, "GF0235", "`move` takes exactly one value.");
        return ERROR;
      }
      return this.width(argument);
    }

    const target = this.#outer.resolveCallee(expression.expression);
    if (target === undefined) {
      this.#outer.unsupported(expression, `a call to \`${expression.expression.text}\``);
      return ERROR;
    }
    return typed(target.signature.returns);
  }

  /** The declared return type of `obj.m(…)`, or `"not-a-method"`. */
  #methodWidth(
    expression: ts.CallExpression,
    access: ts.PropertyAccessExpression,
  ): Width | "not-a-method" {
    // `xs.push(v)` and `xs.pop()`. Before the class and contract paths because
    // an array is neither, and its two methods are the compiler's rather than
    // any declaration's.
    const element = this.#arrayElementAt(access);
    if (element !== undefined) {
      for (const argument of expression.arguments) {
        if (this.width(argument).kind === "error") return ERROR;
      }
      switch (access.name.text) {
        case "push":
          return typed(VOID);
        case "pop":
          return typed(element);
        default:
          this.#outer.unsupported(
            expression,
            `\`${access.name.text}\` on a \`${renderType(element)}[]\``,
          );
          return ERROR;
      }
    }

    const contract = this.#contractAt(access.expression);
    if (contract !== undefined) {
      const method = contract.methods.find((m) => m.name === access.name.text);
      if (method === undefined) {
        this.#outer.unsupported(expression, `\`${contract.name}.${access.name.text}()\``);
        return ERROR;
      }
      for (const argument of expression.arguments) {
        if (this.width(argument).kind === "error") return ERROR;
      }
      return typed(method.returns);
    }

    // `super.m()` resolves against the *base*, statically. Asking tsc for the
    // type of `super` would answer with the base too, but going through the
    // class registry keeps one path for "which body does this name" and it is
    // the same one the lowerer uses.
    const info =
      access.expression.kind === ts.SyntaxKind.SuperKeyword
        ? this.#self?.base
        : this.#outer.classInfo(this.#outer.classNameAt(access.expression) ?? "");
    if (info === undefined) {
      if (access.expression.kind !== ts.SyntaxKind.SuperKeyword) return "not-a-method";
      this.#outer.error(
        access,
        "GF0002",
        "`super` is only meaningful inside a method of a class that extends another.",
      );
      return ERROR;
    }
    const className = info.name;
    const method = info.methods.get(access.name.text);
    if (method === undefined) {
      this.#outer.unsupported(expression, `\`${className}.${access.name.text}()\``);
      return ERROR;
    }
    const record = this.#outer.fn(method.symbol);
    if (record === undefined) return ERROR;
    for (const argument of expression.arguments) {
      if (this.width(argument).kind === "error") return ERROR;
    }
    return typed(record.signature.returns);
  }

  #consoleWidth(expression: ts.CallExpression): Width {
    const access = expression.expression as ts.PropertyAccessExpression;
    if (
      ts.isIdentifier(access.expression) &&
      access.expression.text === "console" &&
      CONSOLE_METHODS[access.name.text] !== undefined
    ) {
      const argument = expression.arguments[0];
      if (argument !== undefined && this.width(argument).kind === "error") return ERROR;
      return typed({ kind: "void" });
    }
    this.#outer.unsupported(expression, "this call target");
    return ERROR;
  }

  #binaryWidth(expression: ts.BinaryExpression): Width {
    if (this.#nullTestOf(expression) !== undefined) return typed({ kind: "bool" });

    const operator = OPERATOR_TOKENS[expression.operatorToken.kind];
    if (operator === undefined) {
      const kind = expression.operatorToken.kind;
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
        return typed({ kind: "bool" });
      }
      this.#outer.unsupported(
        expression.operatorToken,
        `the operator \`${expression.operatorToken.getText()}\``,
      );
      return ERROR;
    }

    const info = OPERATORS[operator];
    const left = this.width(expression.left);
    const right = this.width(expression.right);
    if (left.kind === "error" || right.kind === "error") return ERROR;

    // A shift does not promote to a common type: the result is the value's
    // type and the count is converted to it (REWRITE-PLAN §7).
    const operandType = info.shift
      ? left
      : this.#combine(expression, operator, left, right);
    if (operandType.kind === "error") return ERROR;

    if (
      info.integerOnly &&
      operandType.kind === "typed" &&
      isFloatType(operandType.type)
    ) {
      this.#outer.error(
        expression.operatorToken,
        "GF0162",
        `\`${operator}\` is defined on integers; these operands are ` +
          `\`${renderType(operandType.type)}\`.`,
      );
      return ERROR;
    }

    if (info.comparison) {
      if (operandType.kind === "typed" && !this.#comparable(expression, operator, info, operandType.type)) {
        return ERROR;
      }
      return typed({ kind: "bool" });
    }
    return operandType;
  }

  /**
   * Whether two values of this type may be compared with this operator.
   *
   * tsc has nothing to say here: `<` on two strings is what it means in
   * TypeScript, and `===` on two objects is a question TypeScript can answer
   * because objects are references there. Neither survives the trip to a value
   * model on a machine, so the frontend is the only thing that can refuse them
   * — and until it did, both reached Cranelift and panicked, which is exactly
   * the failure REWRITE-PLAN §8 says must not be reachable from source.
   */
  #comparable(
    at: ts.BinaryExpression,
    operator: Operator,
    info: OperatorInfo,
    type: MachineType,
  ): boolean {
    if (isMachineComparable(type)) return true;

    // A `string` knows whether it equals another — the runtime compares the
    // bytes — but not which of two comes first.
    if (type.kind === "string") {
      if (!info.ordered) return true;
      this.#outer.unsupported(
        at.operatorToken,
        `\`${operator}\` on two strings, which needs a lexicographic comparison`,
      );
      return false;
    }

    // Everything left is an aggregate, and this is the value model rather than
    // a gap. In TypeScript `a === b` on two objects asks whether they are the
    // *same object*; here they are values, so there is no such question to ask
    // — two values with equal fields are as interchangeable as two `3`s.
    this.#outer.error(
      at.operatorToken,
      "GF0002",
      `\`${operator}\` has no meaning on a \`${renderType(type)}\`. In TypeScript ` +
        `this asks whether two names refer to the same object; here objects are ` +
        `values, so the question does not arise — and comparing the bytes would ` +
        `be wrong, because padding between fields holds nothing in particular. ` +
        `Compare the fields you care about.`,
    );
    return false;
  }

  /** The type both operands promote to, or an error naming why there is none. */
  #combine(at: ts.Node, operator: Operator, left: Width, right: Width): Width {
    if (left.kind === "poly") return right;
    if (right.kind === "poly") return left;
    if (left.kind !== "typed" || right.kind !== "typed") return ERROR;

    const common = commonType(left.type, right.type);
    if (common !== null) return typed(common);

    this.#outer.error(
      at,
      "GF0161",
      `\`${renderType(left.type)}\` and \`${renderType(right.type)}\` have no ` +
        `common type, so \`${operator}\` has no type to work at. Neither holds ` +
        `every value of the other. Convert one with \`nativeCast\` to say which ` +
        `you meant.`,
    );
    return ERROR;
  }

  // -- lowering ------------------------------------------------------------

  /** Lower an expression to an operand of exactly `expected`. */
  #expression(expression: ts.Expression, expected: MachineType): Operand | undefined {
    return this.#expressionTyped(expression, expected)?.operand;
  }

  /** As {@link #expression}, keeping the temporary marker the caller may need. */
  #expressionTyped(expression: ts.Expression, expected: MachineType): Typed | undefined {
    const value = this.#value(expression, expected);
    if (value === undefined) return undefined;
    return this.#coerce(expression, value, expected);
  }

  /** Lower an expression that must produce a `bool`. */
  #condition(expression: ts.Expression): Operand | undefined {
    const width = this.width(expression);
    if (width.kind === "error") return undefined;
    if (width.kind === "poly" || width.type.kind !== "bool") {
      const shown = width.kind === "poly" ? "a number" : `\`${renderType(width.type)}\``;
      this.#outer.error(
        expression,
        "GF0002",
        `a condition must be a \`boolean\`; this is ${shown}. There is no ` +
          "truthiness here — write the comparison you mean.",
      );
      return undefined;
    }
    return this.#expression(expression, { kind: "bool" });
  }

  /**
   * Convert a lowered value to the type its context wants.
   *
   * A widening is an explicit `Cast` in the MIR, never an assumption; a
   * narrowing is `GF0160`, because the truncation is invisible at the point it
   * costs you.
   */
  #coerce(at: ts.Node, value: Typed, expected: MachineType): Typed | undefined {
    if (sameType(value.type, expected)) return value;

    // The conversion site, and the only one. A class becomes a contract by
    // building `(itab, &object)` — a *borrow*, so the object stays owned by
    // whoever owned it and the pair is never destroyed.
    if (expected.kind === "interface" && value.type.kind === "class") {
      return this.#toInterface(at, value, expected);
    }
    // `xs` → `Reference<T[]>`: borrow the array rather than copy it. A borrow
    // and not a conversion, so the buffer stays the caller's and no element is
    // cloned — which is the whole reason to write the reference. Passing the
    // array itself is `std::vector<T>` by value: correct, and a whole buffer.
    if (
      expected.kind === "reference" &&
      expected.referent.kind === "array" &&
      value.type.kind === "array"
    ) {
      const place = this.#placeOfSubject(at, value);
      if (place === undefined) return undefined;
      const operand = this.#refTo(at, place, value.type);
      return value.temporary === undefined
        ? { operand, type: expected }
        : { operand, type: expected, borrowsTemporary: true };
    }
    if (expected.kind === "reference" && expected.referent.kind === "class") {
      return this.#toClassReference(at, value, expected.referent.name);
    }
    if (expected.kind === "class" && value.type.kind === "class") {
      return this.#slice(at, value, expected);
    }

    if (fits(value.type, expected)) {
      const kind = this.#castKind(at, value.type, expected);
      if (kind === undefined) return undefined;
      return this.#temporaryTyped(at, expected, {
        kind: "Cast",
        op: kind,
        operand: value.operand,
        to: this.#outer.tyOf(expected, at),
      });
    }

    const narrowing =
      value.type.kind === "scalar" && expected.kind === "scalar" && fits(expected, value.type);

    this.#outer.error(
      at,
      narrowing ? "GF0160" : "GF0161",
      narrowing
        ? `this is a \`${renderType(value.type)}\` and \`${renderType(expected)}\` ` +
            `is narrower, so the conversion can lose the value. Write ` +
            `\`nativeCast<${renderType(expected)}>(…)\` if that is what you mean.`
        : `this is a \`${renderType(value.type)}\`, which does not convert to ` +
            `\`${renderType(expected)}\` without losing values.`,
    );
    return undefined;
  }

  /**
   * `dog` → `Reference<Pet>`: build the `(itab, &dog)` pair.
   *
   * The itab is for the **static** class of the source. Converting a `Base` to
   * a contract yields a `Base`'s itab even when the object is really a
   * `Derived`, and dispatch still reaches the derived override — because the
   * itab holds `Base`'s *final overriders*, which is exactly where a virtual
   * call through a `Base` would have gone.
   *
   * The object has to be somewhere addressable, so a value that is still a
   * constant or a computed temporary is materialised first. Nothing here takes
   * ownership: `Reference<I>` is a borrow, and the object outliving it is the
   * programmer's business — the same deal `Reference<T>` has always made.
   */
  #toInterface(
    at: ts.Node,
    value: Typed,
    contract: Extract<MachineType, { kind: "interface" }>,
  ): Typed | undefined {
    if (value.type.kind !== "class") return undefined;
    if (!this.#outer.implement(value.type.name, contract, at)) return undefined;

    const interfaceId = this.#outer.interfaceId(contract.name);
    const classId = this.#outer.classId(value.type.name);
    if (interfaceId === undefined || classId === undefined) return undefined;

    const source = this.#placeOfSubject(at, value);
    if (source === undefined) return undefined;

    const local = this.#f.addLocal({
      ty: this.#outer.tyOf(contract, at),
      storage: "Temporary",
      span: this.#outer.span(at),
    });
    this.#push({ kind: "StorageLive", value: local });
    this.#push({
      kind: "Init",
      place: placeOf(local),
      rvalue: { kind: "MakeInterface", interface: interfaceId, class: classId, source },
    });
    // `Copy`, not `Move`: the pair is two borrowed words, trivially copied, and
    // reading it does not end anything.
    return { operand: { kind: "Copy", value: placeOf(local) }, type: contract };
  }

  /**
   * `wolf` → `Animal`, by value: **slice** it.
   *
   * REWRITE-PLAN §4.1 and §4.7. The destination takes the static type's fields
   * and the static type's vtable, so what arrives really is an `Animal` and
   * dispatches as one. The backend does the work — `copy_aggregate` reads the
   * *destination's* type — so all this has to do is give it a destination of
   * the right type.
   *
   * The copy is the caller's, and the caller destroys it (§4.5), which is what
   * registering it as a temporary arranges.
   */
  #slice(
    at: ts.Node,
    value: Typed,
    expected: Extract<MachineType, { kind: "class" }>,
  ): Typed | undefined {
    if (value.type.kind !== "class") return undefined;

    const info = this.#outer.classInfo(value.type.name);
    let base = info;
    while (base !== undefined && base.name !== expected.name) base = base.base;
    if (base === undefined) {
      // tsc rejects an unrelated class first; this is the check that keeps the
      // backend from being the one that notices if it ever does not.
      this.#outer.error(
        at,
        "GF0002",
        `\`${value.type.name}\` is not a \`${expected.name}\`, so there is no ` +
          "conversion between them.",
      );
      return undefined;
    }

    const source = this.#placeOfSubject(at, value);
    if (source === undefined) return undefined;

    const local = this.#f.addLocal({
      ty: this.#outer.tyOf(expected, at),
      storage: "Temporary",
      span: this.#outer.span(at),
    });
    this.#push({ kind: "StorageLive", value: local });
    this.#push({
      kind: "Init",
      place: placeOf(local),
      rvalue: { kind: "Use", value: { kind: "Copy", value: source } },
    });
    this.#temporaries.push(local);
    return { operand: { kind: "Copy", value: placeOf(local) }, type: expected, temporary: local };
  }

  /**
   * `dog` → `Reference<Animal>`: borrow the object rather than copy it.
   *
   * This is the whole reason `Reference<T>` is something you write. Passing a
   * `Dog` where an `Animal` is expected **copies and slices** it — the derived
   * part is gone and the vtable becomes `Animal`'s — which is right for a value
   * and almost never what was wanted for a parameter. A reference keeps the
   * dynamic type, so a virtual call through it finds the derived override.
   *
   * The upcast itself costs nothing: `ClassDef::fields` is flattened base-first,
   * so a `Base` is a byte-for-byte prefix of every `Derived` and the same
   * address serves both. Only the *type* changes.
   */
  #toClassReference(at: ts.Node, value: Typed, className: string): Typed | undefined {
    const type: MachineType = {
      kind: "reference",
      referent: { kind: "class", name: className },
    };

    // Already a reference: an upcast, and nothing but a retype.
    if (value.type.kind === "reference" && value.type.referent.kind === "class") {
      return { operand: value.operand, type };
    }
    if (value.type.kind !== "class") return undefined;

    const place = this.#placeOfSubject(at, value);
    if (place === undefined) return undefined;
    const operand = this.#refTo(at, place, value.type);
    // Borrowing a temporary is fine *here* — it lives to the end of the
    // enclosing full-expression, so a call completes inside its lifetime.
    // Only a binding would outlive it, and that is where this is checked.
    return value.temporary === undefined
      ? { operand, type }
      : { operand, type, borrowsTemporary: true };
  }

  #castKind(at: ts.Node, from: MachineType, to: MachineType): CastKind | undefined {
    if (from.kind === "bool" && isIntegerType(to)) return "BoolToInt";
    if (isIntegerType(from) && isIntegerType(to)) return "IntToInt";
    if (isIntegerType(from) && isFloatType(to)) return "IntToFloat";
    if (isFloatType(from) && isIntegerType(to)) return "FloatToInt";
    if (isFloatType(from) && isFloatType(to)) return "FloatToFloat";

    this.#outer.error(
      at,
      "GF0163",
      `there is no conversion from \`${renderType(from)}\` to \`${renderType(to)}\`.`,
    );
    return undefined;
  }

  /**
   * Lower an expression at its natural type.
   *
   * `expected` is a *hint*, used only where an expression has no width of its
   * own — a literal, or an expression built only from literals. Anything with a
   * width of its own is lowered at that width and converted afterwards by
   * {@link #coerce}, which is what makes a narrowing visible instead of silent.
   */
  #value(expression: ts.Expression, expected: MachineType | undefined): Typed | undefined {
    if (ts.isParenthesizedExpression(expression)) {
      return this.#value(expression.expression, expected);
    }

    const width = this.width(expression);
    if (width.kind === "error") return undefined;
    const natural = width.kind === "typed" ? width.type : expected;

    if (natural === undefined) {
      this.#outer.error(
        expression,
        "GF0161",
        "this expression is built only from literals, so it has no width, and " +
          "nothing here supplies one. Annotate the binding or convert with " +
          "`nativeCast`.",
      );
      return undefined;
    }

    if (ts.isNumericLiteral(expression)) {
      return this.#literal(expression, natural, false);
    }

    if (ts.isStringLiteralLike(expression)) {
      return {
        operand: {
          kind: "Const",
          value: this.#strConst(expression.text),
        },
        type: STRING,
      };
    }

    if (ts.isTemplateExpression(expression)) return this.#template(expression);
    if (ts.isPropertyAccessExpression(expression)) return this.#property(expression);
    if (ts.isObjectLiteralExpression(expression)) {
      return this.#objectLiteral(expression, natural);
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return this.#arrayLiteral(expression, natural);
    }
    if (ts.isElementAccessExpression(expression)) return this.#elementAccess(expression);

    if (expression.kind === ts.SyntaxKind.TrueKeyword) {
      return { operand: { kind: "Const", value: this.#boolConst(true) }, type: natural };
    }
    if (expression.kind === ts.SyntaxKind.FalseKeyword) {
      return { operand: { kind: "Const", value: this.#boolConst(false) }, type: natural };
    }

    if (ts.isIdentifier(expression)) {
      const binding = this.#scopes.lookup(expression.text);
      if (binding === undefined) return undefined;
      if (this.#readMoved(expression, binding.local, expression.text)) return undefined;
      // For a trivial type copy and move lower identically, and the frontend
      // still says which one it means. `Copy` is right here: reading a binding
      // does not end it.
      return { operand: { kind: "Copy", value: placeOf(binding.local) }, type: binding.type };
    }

    if (expression.kind === ts.SyntaxKind.ThisKeyword) return this.#thisTyped(expression);
    if (ts.isNewExpression(expression)) return this.#new(expression);
    if (ts.isConditionalExpression(expression)) return this.#conditional(expression, natural);
    if (ts.isPrefixUnaryExpression(expression)) return this.#unary(expression, natural);
    if (ts.isBinaryExpression(expression)) return this.#binary(expression, natural);
    if (ts.isCallExpression(expression)) return this.#call(expression, natural);

    this.#outer.unsupported(expression, describe(expression));
    return undefined;
  }

  #literal(
    literal: ts.NumericLiteral,
    type: MachineType,
    negated: boolean,
  ): Typed | undefined {
    if (type.kind !== "scalar") {
      this.#outer.error(
        literal,
        "GF0161",
        `a numeric literal cannot be a \`${renderType(type)}\`.`,
      );
      return undefined;
    }

    const ty = this.#outer.tyOf(type, literal);
    // The literal's *text*, with digit separators removed. `1_000` is ordinary
    // TypeScript, and neither `Number` nor `BigInt` will take the underscores.
    const text = literalDigits(literal.getText());

    if (rangeOf(type.name) === null) {
      const value = Number(text) * (negated ? -1 : 1);
      const bits =
        type.name === "f32"
          ? BigInt(new Uint32Array(new Float32Array([value]).buffer)[0]!)
          : new BigUint64Array(new Float64Array([value]).buffer)[0]!;
      return { operand: { kind: "Const", value: { kind: "Float", bits, ty } }, type };
    }

    // An integer width takes an integer literal, and nothing else. `1.5` is the
    // obvious case; `1e3` is the one worth a message of its own, because it is
    // exactly a thousand and is still refused — accepting it would be the
    // silent float-to-integer conversion the language rejects everywhere else.
    if (!isIntegerLiteral(text)) {
      this.#outer.error(
        literal,
        "GF0164",
        `\`${literal.getText()}\` is a floating-point literal and \`${type.name}\` ` +
          `holds integers. Write the integer, or convert with ` +
          `\`nativeCast<${type.name}>(…)\` where the truncation is meant.`,
      );
      return undefined;
    }

    const magnitude = BigInt(text);
    const check = checkLiteral(
      type.name,
      negated ? -magnitude : magnitude,
      hasExplicitRadix(text),
    );
    if (!check.ok || check.bits === undefined) {
      const range = check.range!;
      this.#outer.error(
        literal,
        "GF0164",
        `${negated ? "-" : ""}${magnitude} does not fit in \`${type.name}\`, ` +
          `whose range is ${range.min} to ${range.max}.`,
      );
      return undefined;
    }
    return { operand: { kind: "Const", value: { kind: "Int", bits: check.bits, ty } }, type };
  }

  /**
   * `` `a${x}b` `` — a chain of concatenations.
   *
   * Each interpolation is converted to a `string` first, by the same runtime
   * call `console.log` uses, so `console.log(x)` and ``console.log(`${x}`)``
   * mean the same thing rather than nearly the same thing.
   *
   * Every concatenation allocates, and every intermediate is a temporary that
   * dies at the end of the enclosing full-expression. That is the C++ rule and
   * it is why this produces no leaks despite allocating on every step.
   */
  #template(expression: ts.TemplateExpression): Typed | undefined {
    let result: Typed | undefined =
      expression.head.text.length === 0
        ? undefined
        : {
            operand: {
              kind: "Const",
              value: this.#strConst(expression.head.text),
            },
            type: STRING,
          };

    const append = (piece: Typed): void => {
      result =
        result === undefined
          ? piece
          : this.#temporaryTyped(expression, STRING, {
              kind: "Binary",
              op: "Add",
              // Borrows, not copies: concatenation reads its operands and
              // allocates a fresh result. Cloning them first allocates twice
              // and leaves the first pair to nobody.
              lhs: this.#forRead(result),
              rhs: this.#forRead(piece),
            });
    };

    for (const span of expression.templateSpans) {
      const value = this.#value(span.expression, undefined);
      if (value === undefined) return undefined;
      const text = this.#toStringValue(span.expression, value);
      if (text === undefined) return undefined;
      append(text);

      if (span.literal.text.length > 0) {
        append({
          operand: {
            kind: "Const",
            value: this.#strConst(span.literal.text),
          },
          type: STRING,
        });
      }
    }

    return (
      result ?? {
        operand: { kind: "Const", value: this.#strConst("") },
        type: STRING,
      }
    );
  }

  /**
   * Convert a value to a `string`, the way an interpolation converts it.
   *
   * The conversion is a real call to a real runtime function, declared as an
   * ordinary import. Nothing here is a special form the backend recognises.
   */
  #toStringValue(at: ts.Expression, value: Typed): Typed | undefined {
    if (value.type.kind === "string") return value;

    if (value.type.kind === "bool") {
      return this.#callRuntime(at, RUNTIME.fromBool, [value], STRING);
    }

    if (value.type.kind !== "scalar") {
      this.#outer.unsupported(at, `converting \`${renderType(value.type)}\` to a string`);
      return undefined;
    }

    // Widened to the runtime's parameter type first, so there is one conversion
    // function per signedness rather than one per width.
    const name = value.type.name;
    if (isFloatType(value.type)) {
      const widened = this.#convert(at, value, { kind: "scalar", name: "f64" });
      return widened && this.#callRuntime(at, RUNTIME.fromF64, [widened], STRING);
    }
    const signed = name.startsWith("i");
    const wide: MachineType = { kind: "scalar", name: signed ? "i64" : "u64" };
    const widened = this.#convert(at, value, wide);
    if (widened === undefined) return undefined;
    return this.#callRuntime(at, signed ? RUNTIME.fromI64 : RUNTIME.fromU64, [widened], STRING);
  }

  /** An explicit conversion, whether or not the language would allow it implicitly. */
  #convert(at: ts.Expression, value: Typed, to: MachineType): Typed | undefined {
    if (sameType(value.type, to)) return value;
    const kind = this.#castKind(at, value.type, to);
    if (kind === undefined) return undefined;
    return this.#temporaryTyped(at, to, {
      kind: "Cast",
      op: kind,
      operand: value.operand,
      to: this.#outer.tyOf(to, at),
    });
  }

  /** Call a runtime function and bind its result to a temporary. */
  #callRuntime(
    at: ts.Expression,
    name: string,
    args: Typed[],
    returns: MachineType,
  ): Typed | undefined {
    const id = this.#outer.runtimeFn(
      name,
      args.map((arg) => arg.type),
      returns,
      at,
    );

    const destination =
      returns.kind === "void"
        ? undefined
        : this.#f.addLocal({ ty: this.#outer.tyOf(returns, at), storage: "Temporary" });
    if (destination !== undefined) {
      this.#temporaries.push(destination);
      this.#push({ kind: "StorageLive", value: destination });
    }

    const next = this.#f.block();
    this.#seal({
      kind: "Call",
      callee: { kind: "Direct", value: { kind: "Extern", value: id } },
      args: args.map((arg) => this.#forRead(arg)),
      destination: { place: placeOf(destination ?? LocalId(0)), target: next },
      unwind: NO_UNWIND,
    });
    this.#current = next;

    if (destination === undefined) {
      return { operand: { kind: "Const", value: { kind: "Unit" } }, type: VOID };
    }
    return this.#fromCall(destination, returns);
  }

  /**
   * A call's result, as a temporary.
   *
   * The same treatment any other computed value gets: the result *is* the copy,
   * so it is borrowed rather than cloned at the point of use, and the enclosing
   * full-expression destroys it. Forgetting this is a leak on every call that
   * returns something owning, and it is invisible without the allocation
   * counter.
   */
  #fromCall(destination: LocalId, returns: MachineType): Typed {
    return {
      operand: {
        kind: this.#needsCallerCopy(returns) ? "Borrow" : "Copy",
        value: placeOf(destination),
      },
      type: returns,
      temporary: destination,
    };
  }

  /**
   * An object literal, constructed **into** its destination.
   *
   * The fields go straight into the place the value is being built in, rather
   * than into scratch storage that is then copied. REWRITE-PLAN §4.4 asks for
   * copy elision to be an explicit decision rather than something the backend
   * pattern-matches out afterwards, and `Init` of an `Aggregate` is that
   * decision written down.
   */
  #objectLiteral(
    expression: ts.ObjectLiteralExpression,
    natural: MachineType,
  ): Typed | undefined {
    if (natural.kind !== "struct") {
      this.#outer.error(
        expression,
        "GF0161",
        `an object literal cannot be a \`${renderType(natural)}\`.`,
      );
      return undefined;
    }

    // Field *order* is the layout, so the operands are collected in the
    // struct's declaration order rather than in the order the literal happens
    // to write them.
    const values: Operand[] = [];
    for (const field of natural.fields) {
      const property = expression.properties.find(
        (candidate) =>
          ts.isPropertyAssignment(candidate) &&
          candidate.name !== undefined &&
          candidate.name.getText() === field.name,
      );
      if (property === undefined || !ts.isPropertyAssignment(property)) {
        // tsc rejects a missing field, so reaching this means the two disagree.
        this.#outer.unsupported(expression, `an object literal without \`${field.name}\``);
        return undefined;
      }
      const value = this.#expressionTyped(property.initializer, field.type);
      if (value === undefined) return undefined;
      values.push(this.#forStorage(value));
    }

    return this.#temporaryTyped(expression, natural, {
      kind: "Aggregate",
      ty: this.#outer.tyOf(natural, expression),
      fields: values,
    });
  }

  /**
   * `[a, b, c]` — one heap buffer of exactly this length, elements inline.
   *
   * The same `Aggregate` node an object literal builds, because it is the same
   * operation: a sequence of values written into storage in order. What differs
   * is where the storage comes from, and the backend decides that from the type
   * — a struct's is the destination the caller already has, an array's is
   * allocated. Keeping one node means an element gets the same copy treatment a
   * field does, without a second implementation to keep in step.
   *
   * `[]` is not a special case here and does not allocate: the runtime hands
   * back a shared static empty, as an empty `std::vector` holds no buffer.
   */
  #arrayLiteral(
    expression: ts.ArrayLiteralExpression,
    natural: MachineType,
  ): Typed | undefined {
    if (natural.kind !== "array") {
      this.#outer.error(
        expression,
        "GF0161",
        `an array literal cannot be a \`${renderType(natural)}\`.`,
      );
      return undefined;
    }

    const values: Operand[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) {
        this.#outer.unsupported(element, "a spread element in an array literal");
        return undefined;
      }
      const value = this.#expressionTyped(element, natural.element);
      if (value === undefined) return undefined;
      values.push(this.#forStorage(value));
    }

    return this.#temporaryTyped(expression, natural, {
      kind: "Aggregate",
      ty: this.#outer.tyOf(natural, expression),
      fields: values,
    });
  }

  /**
   * `xs.push(v)` — grow by one, then store the element into the new slot.
   *
   * Two steps because they belong to two halves of the compiler. Making room
   * needs the element's stride and alignment, which only the backend knows, so
   * it is `ArrayPushSlot`. Storing the element is an ordinary `Init` through the
   * `Pointer<T>` that comes back — which means `push` copies or moves by exactly
   * the same rules as every other write, and a `string[]` deep-copies its
   * argument without this function knowing what a string is.
   */
  #arrayPush(
    expression: ts.CallExpression,
    array: Typed,
    element: MachineType,
  ): Typed | undefined {
    const argument = expression.arguments[0];
    if (expression.arguments.length !== 1 || argument === undefined) {
      this.#outer.error(expression, "GF0002", "`push` takes exactly one element.");
      return undefined;
    }
    const resolved = this.#asArray(expression, array);
    if (resolved === undefined) return undefined;
    const place = resolved.place;

    const value = this.#expressionTyped(argument, element);
    if (value === undefined) return undefined;

    const pointer: MachineType = { kind: "pointer", pointee: element };
    const slot = this.#f.addLocal({
      ty: this.#outer.tyOf(pointer, expression),
      storage: "Temporary",
      span: this.#outer.span(expression),
    });
    this.#push({ kind: "StorageLive", value: slot });
    this.#push({
      kind: "Init",
      place: placeOf(slot),
      rvalue: { kind: "ArrayPushSlot", value: place },
    });
    // `Init`, not `Assign`: the slot is fresh storage the runtime just made
    // room for, so there is no previous element in it to destroy.
    this.#push({
      kind: "Init",
      place: { local: slot, projection: [{ kind: "Deref" }] },
      rvalue: { kind: "Use", value: this.#forStorage(value) },
    });
    this.#push({ kind: "StorageDead", value: slot });
    return { operand: { kind: "Const", value: this.#boolConst(true) }, type: VOID };
  }

  /**
   * `xs.pop()` — take the last element out and shorten the array.
   *
   * A **move**, not a copy: the element is leaving the array, and there is
   * exactly one of it afterwards. Copying instead would allocate for no reason
   * and leave the array's own copy to be destroyed by the length change, which
   * nothing would do.
   *
   * Needs no node of its own — the element is read through an ordinary `Index`
   * projection, and shortening takes no stride, so it is a plain runtime call.
   */
  #arrayPop(
    expression: ts.CallExpression,
    array: Typed,
    element: MachineType,
  ): Typed | undefined {
    if (expression.arguments.length !== 0) {
      this.#outer.error(expression, "GF0002", "`pop` takes no arguments.");
      return undefined;
    }
    const resolved = this.#asArray(expression, array);
    if (resolved === undefined) return undefined;
    const place = resolved.place;

    // `length - 1`, in a local, because a projection indexes by local.
    const length = this.#temporaryTyped(expression, USIZE, { kind: "Len", value: place });
    if (length === undefined) return undefined;
    const last = this.#temporaryTyped(expression, USIZE, {
      kind: "Binary",
      op: "Sub",
      lhs: length.operand,
      rhs: {
        kind: "Const",
        value: { kind: "Int", bits: 1n, ty: this.#outer.tyOf(USIZE, expression) },
      },
    });
    if (last === undefined) return undefined;
    const index = this.#f.addLocal({
      ty: this.#outer.tyOf(USIZE, expression),
      storage: "Temporary",
      span: this.#outer.span(expression),
    });
    this.#push({ kind: "StorageLive", value: index });
    this.#push({
      kind: "Init",
      place: placeOf(index),
      rvalue: { kind: "Use", value: last.operand },
    });

    const slot = { local: place.local, projection: [...place.projection, { kind: "Index" as const, value: index }] };
    const taken = this.#temporaryTyped(expression, element, {
      kind: "Use",
      value: { kind: "Move", value: slot },
    });
    if (taken === undefined) return undefined;

    // After the element has been taken, never before: shortening first would
    // leave the last slot outside the array while it is still being read.
    this.#callRuntime(
      expression,
      RUNTIME.arrayPop,
      [{ operand: { kind: "Copy", value: place }, type: array.type }],
      VOID,
    );
    this.#push({ kind: "StorageDead", value: index });
    return taken;
  }

  /**
   * `fixedArray(N, fill)` — `N` elements, inline, every one a copy of `fill`.
   *
   * Zeroed first, then filled. The zeroing is not belt-and-braces: an element of
   * an owning type is constructed *into* the slot, and if the loop is cut short
   * — or `N` is zero — the destructor at scope exit runs over whatever was
   * there. On uninitialised stack that is a garbage pointer, which is exactly
   * the trap REWRITE-PLAN §10 names.
   *
   * The fill is a loop rather than `N` statements so that a large array costs
   * the same MIR as a small one.
   */
  #fixedArray(expression: ts.CallExpression, natural: MachineType): Typed | undefined {
    if (natural.kind !== "fixedArray") {
      this.#outer.error(
        expression,
        "GF0161",
        `\`fixedArray\` builds a \`FixedArray<T, N>\`, not a ` +
          `\`${renderType(natural)}\`.`,
      );
      return undefined;
    }
    const fillExpression = expression.arguments[1];
    if (expression.arguments.length !== 2 || fillExpression === undefined) {
      this.#outer.error(
        expression,
        "GF0001",
        "`fixedArray` takes a length and a fill value.",
      );
      return undefined;
    }

    const ty = this.#outer.tyOf(natural, expression);
    const array = this.#f.addLocal({ ty, storage: "Temporary" });
    this.#temporaries.push(array);
    this.#push({ kind: "StorageLive", value: array });
    this.#push({ kind: "Init", place: placeOf(array), rvalue: { kind: "Default" } });

    if (natural.length > 0) {
      const fill = this.#expressionTyped(fillExpression, natural.element);
      if (fill === undefined) return undefined;

      const counter = this.#f.addLocal({
        ty: this.#outer.tyOf(USIZE, expression),
        storage: "Owned",
      });
      const test = this.#f.addLocal({
        ty: this.#boolTy(),
        storage: "Temporary",
      });
      const usizeTy = this.#outer.tyOf(USIZE, expression);
      const limit: Operand = {
        kind: "Const",
        value: { kind: "Int", bits: BigInt(natural.length), ty: usizeTy },
      };
      const one: Operand = {
        kind: "Const",
        value: { kind: "Int", bits: 1n, ty: usizeTy },
      };
      const zero: Operand = {
        kind: "Const",
        value: { kind: "Int", bits: 0n, ty: usizeTy },
      };

      const head = this.#f.block();
      const body = this.#f.block();
      const exit = this.#f.block();

      this.#push({ kind: "StorageLive", value: counter });
      this.#push({ kind: "Init", place: placeOf(counter), rvalue: { kind: "Use", value: zero } });
      this.#seal({ kind: "Goto", value: head });

      this.#current = head;
      this.#push({ kind: "StorageLive", value: test });
      this.#push({
        kind: "Init",
        place: placeOf(test),
        rvalue: {
          kind: "Binary",
          op: "Lt",
          lhs: { kind: "Copy", value: placeOf(counter) },
          rhs: limit,
        },
      });
      this.#seal({
        kind: "Branch",
        cond: { kind: "Copy", value: placeOf(test) },
        thenBlock: body,
        elseBlock: exit,
      });

      this.#current = body;
      // `Init`, not `Assign`: the slot was zeroed and holds nothing, so there
      // is nothing to destroy first.
      //
      // And `Copy`, not the usual move-out-of-a-temporary: the loop runs `N`
      // times and each element needs its own value. Moving would put the fill
      // in the first element and leave every other one holding the empty value
      // the move left behind.
      this.#push({
        kind: "Init",
        place: { local: array, projection: [{ kind: "Index", value: counter }] },
        rvalue: { kind: "Use", value: this.#repeatable(fill) },
      });
      this.#push({
        kind: "Assign",
        place: placeOf(counter),
        rvalue: {
          kind: "Binary",
          op: "Add",
          lhs: { kind: "Copy", value: placeOf(counter) },
          rhs: one,
        },
      });
      this.#seal({ kind: "Goto", value: head });

      this.#current = exit;
      this.#push({ kind: "StorageDead", value: test });
      this.#push({ kind: "StorageDead", value: counter });
    }

    return {
      operand: { kind: "Borrow", value: placeOf(array) },
      type: natural,
      temporary: array,
    };
  }

  /** `xs[i]` — an element, by address. */
  #elementAccess(expression: ts.ElementAccessExpression): Typed | undefined {
    const target = this.#elementPlace(expression);
    if (target === undefined) return undefined;
    return { operand: { kind: "Copy", value: target.place }, type: target.element };
  }

  /**
   * The place `xs[i]` denotes.
   *
   * A computed index is materialised into a local first, which is what keeps
   * `Projection` from referring back to `Operand` — and is also where a bounds
   * check will go when `checked` grows one.
   */
  #elementPlace(
    expression: ts.ElementAccessExpression,
  ): { place: Place; element: MachineType } | undefined {
    const subject = this.#value(expression.expression, undefined);
    if (subject === undefined) return undefined;

    // An array first, so that a `Reference<T[]>` gets the `Deref` that reaches
    // its elements rather than being indexed as though it were the handle.
    const array = this.#asArray(expression, subject);
    const element = array?.element ?? elementTypeOf(subject.type);
    if (element === undefined) {
      this.#outer.unsupported(expression, `indexing a \`${renderType(subject.type)}\``);
      return undefined;
    }

    const base = array?.place ?? this.#placeOfSubject(expression, subject);
    if (base === undefined) return undefined;

    const argument = expression.argumentExpression;
    // A literal subscript folds into the projection, so a constant index costs
    // no arithmetic at all.
    if (ts.isNumericLiteral(argument) && !/[.eE]/.test(argument.getText())) {
      return {
        place: {
          local: base.local,
          projection: [...base.projection, { kind: "ConstIndex", value: BigInt(argument.getText()) }],
        },
        element,
      };
    }

    const index = this.#expressionTyped(argument, USIZE);
    if (index === undefined) return undefined;
    const slot = this.#f.addLocal({
      ty: this.#outer.tyOf(USIZE, expression),
      storage: "Temporary",
    });
    this.#temporaries.push(slot);
    this.#push({ kind: "StorageLive", value: slot });
    this.#push({
      kind: "Init",
      place: placeOf(slot),
      rvalue: { kind: "Use", value: index.operand },
    });
    return {
      place: {
        local: base.local,
        projection: [...base.projection, { kind: "Index", value: slot }],
      },
      element,
    };
  }

  /** `s.length` on a string, or a field of a struct. */
  #property(expression: ts.PropertyAccessExpression): Typed | undefined {
    // A fixed array's length is in its type, so it is a constant rather than a
    // load — which is the whole difference between it and `T[]`.
    if (expression.name.text === "length") {
      const width = this.width(expression.expression);
      if (width.kind === "typed" && width.type.kind === "fixedArray") {
        return {
          operand: {
            kind: "Const",
            value: {
              kind: "Int",
              bits: BigInt(width.type.length),
              ty: this.#outer.tyOf(USIZE, expression),
            },
          },
          type: USIZE,
        };
      }
    }

    const subject = this.#value(expression.expression, undefined);
    if (subject === undefined) return undefined;

    const asClass = this.#asClass(subject);
    if (asClass !== undefined) {
      const field = this.#fieldOf(asClass.info, expression.name.text);
      if (field === undefined) {
        this.#outer.unsupported(
          expression,
          `\`${asClass.info.name}.${expression.name.text}\``,
        );
        return undefined;
      }
      return {
        operand: {
          kind: "Copy",
          value: {
            local: asClass.place.local,
            projection: [...asClass.place.projection, { kind: "Field", value: FieldId(field.index) }],
          },
        },
        type: field.type,
      };
    }

    if (subject.type.kind === "struct") {
      const index = this.#fieldIndex(subject.type, expression.name.text);
      const field = subject.type.fields[index];
      if (field === undefined) {
        this.#outer.unsupported(expression, `the field \`${expression.name.text}\``);
        return undefined;
      }
      const place = this.#placeOfSubject(expression, subject);
      if (place === undefined) return undefined;
      return {
        operand: {
          kind: "Copy",
          value: { local: place.local, projection: [...place.projection, { kind: "Field", value: FieldId(index) }] },
        },
        type: field.type,
      };
    }

    if (expression.name.text === "length") {
      // An array — possibly behind a reference — reads its length from the
      // handle, so the place is the one `#asArray` resolves.
      const array = this.#asArray(expression, subject);
      if (array !== undefined) {
        return this.#temporaryTyped(expression, USIZE, { kind: "Len", value: array.place });
      }
      if (subject.type.kind === "string" || subject.type.kind === "cstring") {
        const read = this.#forRead(subject);
        if (read.kind === "Const") {
          this.#outer.unsupported(expression, "`length` of a literal");
          return undefined;
        }
        return this.#temporaryTyped(expression, USIZE, { kind: "Len", value: read.value });
      }
    }

    this.#outer.unsupported(expression, "this property access");
    return undefined;
  }

  /**
   * The place a lowered value occupies, for projecting into.
   *
   * A field access needs an address, and a constant has none — which is why an
   * aggregate literal is materialised into a temporary before anything reaches
   * into it.
   */
  #placeOfSubject(at: ts.Node, subject: Typed): Place | undefined {
    if (subject.operand.kind === "Const") {
      this.#outer.unsupported(at, "reaching into a constant");
      return undefined;
    }
    return subject.operand.value;
  }

  #unary(expression: ts.PrefixUnaryExpression, natural: MachineType): Typed | undefined {
    const operand = expression.operand;

    if (expression.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = this.#condition(operand);
      if (inner === undefined) return undefined;
      return this.#temporaryTyped(expression, { kind: "bool" }, {
        kind: "Unary",
        op: "Not",
        operand: inner,
      });
    }

    if (expression.operator === ts.SyntaxKind.PlusToken) {
      return this.#value(operand, natural);
    }

    if (expression.operator === ts.SyntaxKind.MinusToken) {
      // The unsigned rule comes *first*, before the literal fold. Fold first
      // and `-1` becomes `255`, which is in range for a `u8` and walks straight
      // past the range check — which is the whole reason GF0165 exists
      // (REWRITE-PLAN §7).
      if (natural.kind === "scalar" && rangeOf(natural.name)?.min === 0n) {
        this.#outer.error(
          expression,
          "GF0165",
          `unary minus has no meaning on \`${natural.name}\`, which is unsigned. ` +
            "Nothing it could produce is representable.",
        );
        return undefined;
      }
      // Then fold the sign into the literal, and range-check the result: `-128`
      // is a valid `i8` and `128` is not, so checking before folding would make
      // the lower bound of every signed width unwritable (REWRITE-PLAN §10).
      if (ts.isNumericLiteral(operand)) return this.#literal(operand, natural, true);

      const inner = this.#expression(operand, natural);
      if (inner === undefined) return undefined;
      return this.#temporaryTyped(expression, natural, {
        kind: "Unary",
        op: "Neg",
        operand: inner,
      });
    }

    if (expression.operator === ts.SyntaxKind.TildeToken) {
      if (natural.kind === "scalar" && rangeOf(natural.name) === null) {
        this.#outer.error(
          expression,
          "GF0162",
          `\`~\` is defined on integers; this operand is \`${natural.name}\`.`,
        );
        return undefined;
      }
      const inner = this.#expression(operand, natural);
      if (inner === undefined) return undefined;
      return this.#temporaryTyped(expression, natural, {
        kind: "Unary",
        op: "BitNot",
        operand: inner,
      });
    }

    this.#outer.unsupported(expression, "this unary operator");
    return undefined;
  }

  #binary(expression: ts.BinaryExpression, natural: MachineType): Typed | undefined {
    const nullTest = this.#nullTestOf(expression);
    if (nullTest !== undefined) return this.#nullTest(expression, nullTest);

    const kind = expression.operatorToken.kind;
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
      return this.#shortCircuit(expression, kind === ts.SyntaxKind.AmpersandAmpersandToken);
    }

    const operator = OPERATOR_TOKENS[kind];
    if (operator === undefined) return undefined;
    const info = OPERATORS[operator];

    // The type the operands are worked at. For a comparison that is not the
    // result type, so it has to come from the operands themselves.
    const operandType = info.comparison
      ? this.#operandType(expression)
      : info.shift
        ? natural
        : natural;
    if (operandType === undefined) return undefined;

    const lhsTyped = this.#expressionTyped(expression.left, operandType);
    if (lhsTyped === undefined) return undefined;
    const lhs = this.#forRead(lhsTyped);

    let rhs: Operand | undefined;
    if (info.shift) {
      // The count is *converted* to the value's type, not promoted to a common
      // type with it. A `u8` shifted by an `i64` is still a `u8` shift.
      rhs = this.#shiftCount(expression.right, operandType);
    } else {
      const rhsTyped = this.#expressionTyped(expression.right, operandType);
      rhs = rhsTyped === undefined ? undefined : this.#forRead(rhsTyped);
    }
    if (rhs === undefined) return undefined;

    const result = info.comparison ? ({ kind: "bool" } as MachineType) : operandType;
    return this.#temporaryTyped(expression, result, {
      kind: "Binary",
      op: MIR_OPS[operator],
      lhs,
      rhs,
    });
  }

  /** The type a comparison's operands are compared at. */
  #operandType(expression: ts.BinaryExpression): MachineType | undefined {
    const left = this.width(expression.left);
    const right = this.width(expression.right);
    if (left.kind === "error" || right.kind === "error") return undefined;
    if (left.kind === "typed" && right.kind === "typed") {
      const common = commonType(left.type, right.type);
      if (common !== null) return common;
      return undefined;
    }
    if (left.kind === "typed") return left.type;
    if (right.kind === "typed") return right.type;

    this.#outer.error(
      expression,
      "GF0161",
      "these operands have no fixed width to compare at — both are built only " +
        "from literals. Annotate one of them so the comparison happens at a " +
        "written type rather than a guessed one.",
    );
    return undefined;
  }

  #shiftCount(expression: ts.Expression, valueType: MachineType): Operand | undefined {
    const width = this.width(expression);
    if (width.kind === "error") return undefined;
    // A literal count simply takes the value's type; anything else is
    // converted to it, narrowing included, because a shift count is a count
    // rather than a value being preserved.
    if (width.kind === "poly" || sameType(width.type, valueType)) {
      return this.#expression(expression, valueType);
    }

    const value = this.#value(expression, valueType);
    if (value === undefined) return undefined;
    const kind = this.#castKind(expression, value.type, valueType);
    if (kind === undefined) return undefined;
    return this.#temporary(expression, valueType, {
      kind: "Cast",
      op: kind,
      operand: value.operand,
      to: this.#outer.tyOf(valueType, expression),
    });
  }

  /**
   * `c ? a : b`.
   *
   * Control flow, exactly like `&&` and `||`: only one arm runs, so only one
   * arm's code may execute, and that is a branch rather than an operator. The
   * MIR has no ternary node for the same reason it has no `BinOp::And`.
   *
   * Each arm releases **its own** temporaries before the join. C++ keeps a
   * temporary alive to the end of the enclosing full-expression, and the
   * difference is unobservable here: the arm's value has already been copied
   * into the result by then, and a temporary that was *moved* into the result
   * has had its handle nulled, so releasing it is a no-op. Doing it per-arm
   * avoids a temporary that is live on one path and not the other, which is
   * otherwise a drop flag for no benefit.
   */
  #conditional(
    expression: ts.ConditionalExpression,
    natural: MachineType,
  ): Typed | undefined {
    const result = this.#f.addLocal({
      ty: this.#outer.tyOf(natural, expression),
      storage: "Temporary",
      span: this.#outer.span(expression),
    });

    const mark = this.#temporaries.length;
    const cond = this.#condition(expression.condition);
    if (cond === undefined) return undefined;

    const thenBlock = this.#f.block();
    const elseBlock = this.#f.block();
    const joinBlock = this.#f.block();

    this.#push({ kind: "StorageLive", value: result });
    this.#branchEndingTemporaries(cond, mark, thenBlock, elseBlock);

    for (const [block, arm] of [
      [thenBlock, expression.whenTrue],
      [elseBlock, expression.whenFalse],
    ] as const) {
      this.#current = block;
      const armMark = this.#temporaries.length;
      const value = this.#expressionTyped(arm, natural);
      if (value === undefined) return undefined;
      this.#push({
        kind: "Init",
        place: placeOf(result),
        rvalue: { kind: "Use", value: this.#forStorage(value) },
      });
      this.#endTemporaries(armMark);
      this.#seal({ kind: "Goto", value: joinBlock });
    }

    this.#current = joinBlock;
    this.#temporaries.push(result);
    return { operand: { kind: "Copy", value: placeOf(result) }, type: natural, temporary: result };
  }

  /**
   * `&&` and `||` are control flow, not operators.
   *
   * They short-circuit, so the right-hand side runs only on one path. That is a
   * branch, and a branch belongs in the CFG — which is why the MIR has no
   * `BinOp::And`.
   */
  #shortCircuit(expression: ts.BinaryExpression, isAnd: boolean): Typed | undefined {
    const bool: MachineType = { kind: "bool" };
    const result = this.#f.addLocal({
      ty: this.#outer.tyOf(bool, expression),
      storage: "Temporary",
    });

    const left = this.#condition(expression.left);
    if (left === undefined) return undefined;

    const rightBlock = this.#f.block();
    const shortBlock = this.#f.block();
    const joinBlock = this.#f.block();

    this.#push({ kind: "StorageLive", value: result });
    this.#seal({
      kind: "Branch",
      cond: left,
      thenBlock: isAnd ? rightBlock : shortBlock,
      elseBlock: isAnd ? shortBlock : rightBlock,
    });

    this.#current = rightBlock;
    const right = this.#condition(expression.right);
    if (right === undefined) return undefined;
    this.#push({ kind: "Init", place: placeOf(result), rvalue: { kind: "Use", value: right } });
    this.#seal({ kind: "Goto", value: joinBlock });

    this.#current = shortBlock;
    this.#push({
      kind: "Init",
      place: placeOf(result),
      rvalue: { kind: "Use", value: { kind: "Const", value: this.#boolConst(!isAnd) } },
    });
    this.#seal({ kind: "Goto", value: joinBlock });

    this.#current = joinBlock;
    return { operand: { kind: "Copy", value: placeOf(result) }, type: bool };
  }

  #call(expression: ts.CallExpression, natural: MachineType): Typed | undefined {
    if (expression.expression.kind === ts.SyntaxKind.SuperKeyword) {
      return this.#superCall(expression);
    }
    if (ts.isPropertyAccessExpression(expression.expression)) {
      const method = this.#methodCall(expression, expression.expression);
      if (method !== "not-a-method") return method;
      return this.#console(expression);
    }
    if (!ts.isIdentifier(expression.expression)) return undefined;
    const name = expression.expression.text;

    if (name === NATIVE_CAST) return this.#nativeCast(expression, natural);
    if (name === MOVE) return this.#move(expression);
    if (name === FIXED_ARRAY) return this.#fixedArray(expression, natural);
    if (name === TRY_CAST) return this.#tryCast(expression);
    if (name === CSTRING) return this.#cstring(expression);
    if (name === CSTRING_FREE) return this.#cstringFree(expression);

    // Resolved through tsc's symbol, not by name: an imported function is the
    // same symbol as its declaration however it is spelled at the call site,
    // and two same-named privates in different files are different symbols.
    const target = this.#outer.resolveCallee(expression.expression);
    if (target === undefined) return undefined;
    if (expression.arguments.length !== target.signature.params.length) {
      // tsc has already rejected a genuine arity mismatch, so reaching this
      // means the two disagree, which is a compiler bug rather than a user one.
      this.#outer.unsupported(expression, "a call whose arity tsc and the lowerer disagree on");
      return undefined;
    }

    const args: Operand[] = [];
    for (const [index, argument] of expression.arguments.entries()) {
      const value = this.#expressionTyped(argument, target.signature.params[index]!.type);
      if (value === undefined) return undefined;
      args.push(this.#forArgument(argument, value));
    }

    const returns = target.signature.returns;
    const destination =
      returns.kind === "void"
        ? undefined
        : this.#f.addLocal({
            ty: this.#outer.tyOf(returns, expression),
            storage: "Temporary",
          });
    if (destination !== undefined) {
      this.#temporaries.push(destination);
      this.#push({ kind: "StorageLive", value: destination });
    }

    const next = this.#f.block();
    this.#seal({
      kind: "Call",
      callee: {
        kind: "Direct",
        value:
          target.kind === "defined"
            ? { kind: "Local", value: target.id }
            : { kind: "Extern", value: this.#outer.externIdOf(target) },
      },
      args,
      destination: { place: placeOf(destination ?? LocalId(0)), target: next },
      unwind: NO_UNWIND,
    });
    this.#current = next;

    if (destination === undefined) return undefined;
    return this.#fromCall(destination, returns);
  }

  /**
   * `obj.m(a)` — a **virtual** call.
   *
   * Every method dispatches through the vtable, because the receiver's dynamic
   * type is only its static type when the receiver is a value, and a
   * `Reference<Base>` is exactly the case that is not. Two loads and an
   * indirect call: the same cost a C++ virtual call pays, and the slot is a
   * compile-time constant.
   *
   * Returns the sentinel `"not-a-method"` rather than `undefined` when the
   * receiver is not a class at all, so the caller can go on to try `console`
   * without a spurious diagnostic having been raised.
   */
  #methodCall(
    expression: ts.CallExpression,
    access: ts.PropertyAccessExpression,
  ): Typed | undefined | "not-a-method" {
    if (access.expression.kind === ts.SyntaxKind.SuperKeyword) {
      return this.#superMethodCall(expression, access);
    }

    // `xs.push(v)` and `xs.pop()`, before the class and contract paths for the
    // same reason the width pass takes them first: an array is neither, and
    // these two methods are the compiler's rather than any declaration's.
    const element = this.#arrayElementAt(access);
    if (element !== undefined) {
      const array = this.#value(access.expression, undefined);
      if (array === undefined) return undefined;
      switch (access.name.text) {
        case "push":
          return this.#arrayPush(expression, array, element);
        case "pop":
          return this.#arrayPop(expression, array, element);
        default:
          this.#outer.unsupported(expression, `\`${access.name.text}\` on an array`);
          return undefined;
      }
    }

    const contract = this.#contractAt(access.expression);
    if (contract !== undefined) return this.#interfaceCall(expression, access, contract);

    // Asked of tsc rather than of the width pass, because the width pass
    // *reports*: `console.log` is a property access too, and running it over
    // `console` would raise a diagnostic about a name that does not resolve
    // before this could decide the call was not a method call at all.
    const className = this.#outer.classNameAt(access.expression);
    if (className === undefined) return "not-a-method";

    const info = this.#outer.classInfo(className);
    const method = info?.methods.get(access.name.text);
    if (info === undefined || method === undefined) return "not-a-method";

    const subject = this.#value(access.expression, undefined);
    if (subject === undefined) return undefined;
    const asClass = this.#asClass(subject);
    if (asClass === undefined) {
      this.#outer.unsupported(access, "a method call on this receiver");
      return undefined;
    }

    const record = this.#outer.fn(method.symbol);
    if (record === undefined || record.kind !== "defined") {
      this.#outer.unsupported(expression, `a call to \`${method.symbol}\``);
      return undefined;
    }

    const args = this.#classCallArgs(
      expression,
      info,
      method.symbol,
      expression.arguments,
      this.#refTo(access, asClass.place, { kind: "class", name: className }),
    );
    if (args === undefined || args === null) return undefined;

    const returns = record.signature.returns;
    const destination =
      returns.kind === "void"
        ? undefined
        : this.#f.addLocal({
            ty: this.#outer.tyOf(returns, expression),
            storage: "Temporary",
          });
    if (destination !== undefined) {
      this.#temporaries.push(destination);
      this.#push({ kind: "StorageLive", value: destination });
    }

    const next = this.#f.block();
    this.#seal({
      kind: "Call",
      callee: { kind: "Virtual", slot: method.slot, sig: record.sig },
      args,
      destination: { place: placeOf(destination ?? LocalId(0)), target: next },
      unwind: NO_UNWIND,
    });
    this.#current = next;

    if (destination === undefined) return undefined;
    return this.#fromCall(destination, returns);
  }

  /**
   * `pet === null` or `pet !== null`, where `pet` is a contract reference.
   *
   * Returns the non-null side and whether the test is for equality, or
   * `undefined` when this is an ordinary comparison. Recognised on both sides,
   * because `null !== pet` is the same question.
   */
  #nullTestOf(
    expression: ts.BinaryExpression,
  ): { subject: ts.Expression; equals: boolean } | undefined {
    const kind = expression.operatorToken.kind;
    const equals =
      kind === ts.SyntaxKind.EqualsEqualsToken ||
      kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const differs =
      kind === ts.SyntaxKind.ExclamationEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (!equals && !differs) return undefined;

    const isNull = (node: ts.Expression): boolean =>
      node.kind === ts.SyntaxKind.NullKeyword;
    const subject = isNull(expression.right)
      ? expression.left
      : isNull(expression.left)
        ? expression.right
        : undefined;
    if (subject === undefined) return undefined;
    // A contract reference is a pair, and a class reference is one word. Both
    // can be null; they are tested differently.
    if (this.#contractAt(subject) !== undefined) return { subject, equals };
    const type = this.#outer.checker.getNonNullableType(
      this.#outer.checker.getTypeAtLocation(subject),
    );
    const referent = referentOf(this.#outer.checker, type);
    if (referent !== null && classNameOf(referent) !== null) {
      return { subject, equals };
    }
    // A `CString` is one machine word and is the type a C function most often
    // returns null from — `getenv`, `SDL_GetError`, half of libc. Declaring one
    // `CString | null` and being made to check it is the whole benefit of the
    // nullable spelling, and it is worth nothing if the check does not lower.
    if (isCStringType(this.#outer.checker, type)) {
      return { subject, equals };
    }
    return undefined;
  }

  /**
   * Lower it: read the pair's itab word and compare it against zero.
   *
   * There is no null *constant* to compare against, and there does not need to
   * be — `Reference<I> | null` is the same sixteen bytes as `Reference<I>`,
   * with a zero itab meaning "no". So nullability never became a second
   * representation, and it never reaches the backend as one.
   */
  #nullTest(
    expression: ts.BinaryExpression,
    test: { subject: ts.Expression; equals: boolean },
  ): Typed | undefined {
    const value = this.#value(test.subject, undefined);
    if (value === undefined) return undefined;
    const place = this.#placeOfSubject(test.subject, value);
    if (place === undefined) return undefined;

    const bool: MachineType = { kind: "bool" };
    // A class reference and a `CString` are each a single word, so they compare
    // against a null constant like any other address. A contract reference is a
    // pair, and what is null is its itab word — a different read, hence a
    // different node.
    if (value.type.kind === "reference" || value.type.kind === "cstring") {
      return this.#temporaryTyped(expression, bool, {
        kind: "Binary",
        op: test.equals ? "Eq" : "Ne",
        lhs: { kind: "Copy", value: place },
        rhs: {
          kind: "Const",
          value: { kind: "Null", value: this.#outer.tyOf(value.type, expression) },
        },
      });
    }
    const isNull = this.#temporaryTyped(expression, bool, {
      kind: "InterfaceIsNull",
      value: place,
    });
    if (test.equals || isNull === undefined) return isNull;
    return this.#temporaryTyped(expression, bool, {
      kind: "Unary",
      op: "Not",
      operand: isNull.operand,
    });
  }

  /**
   * `cstring(s)` — borrow a `string`'s bytes as a raw `const char *`.
   *
   * No allocation and no conversion: a Goblin `string` is already
   * nul-terminated, so this hands back the same pointer with a different type.
   * What changes is who is responsible for it, and there are two answers:
   *
   * * **Borrowed** — the ordinary case. The `string` still owns the bytes and
   *   still releases them at the end of its scope, so the `CString` is valid
   *   for exactly as long as the `string` is. Borrowing a *temporary* is
   *   `GF0234`: that one dies at the end of the statement, and the borrow could
   *   not outlive it by a line.
   * * **`cstring(move(s))`** — the compiler stops tracking the bytes entirely.
   *   Nothing releases them. That is a leak in most programs and exactly right
   *   in one: handing a buffer to a C library that will free it. This language
   *   is unsafe on purpose, and `move` is how the intent gets written down.
   */
  #cstring(expression: ts.CallExpression): Typed | undefined {
    const argument = expression.arguments[0];
    if (expression.arguments.length !== 1 || argument === undefined) {
      this.#outer.error(expression, "GF0002", "`cstring` takes exactly one `string`.");
      return undefined;
    }

    const value = this.#value(argument, STRING);
    if (value === undefined) return undefined;
    if (value.type.kind !== "string") {
      this.#outer.error(
        argument,
        "GF0002",
        `\`cstring\` borrows a \`string\`'s bytes, and this is a ` +
          `\`${renderType(value.type)}\`.`,
      );
      return undefined;
    }

    // A `Move` operand means the source has been made dead and nothing will
    // release it — so a temporary is fine, because its drop is gone too.
    const moving = value.operand.kind === "Move";
    if (!moving && value.temporary !== undefined) {
      this.#outer.error(
        argument,
        "GF0234",
        "nothing owns this string, so it is released at the end of this " +
          "statement and the `CString` would point at freed bytes. Bind it to a " +
          "name first — or write `cstring(move(…))` if you meant to take the " +
          "bytes out of the compiler's hands, which makes releasing them yours.",
      );
      return undefined;
    }

    // `Borrow`, never `Copy`: reading a `string` with `Copy` applies its copy
    // operation and allocates a second buffer that nothing would free. The
    // machine value is the pointer, and the pointer is all this needs.
    const operand: Operand = moving ? value.operand : this.#forRead(value);
    return this.#temporaryTyped(expression, CSTRING_TYPE, {
      kind: "Cast",
      op: "PtrToPtr",
      operand,
      to: this.#outer.tyOf(CSTRING_TYPE, expression),
    });
  }

  /**
   * `cstring_free(c)` — release a `CString` through Goblin's own deallocator.
   *
   * An intrinsic rather than a method on `CString`, and that is the design
   * rather than a shortcut. A `.free()` would have to pick one deallocator, and
   * there is no right one to pick: an SDL string needs `SDL_free`, a `strdup`
   * needs `free`, and only a moved Goblin string needs this one. Releasing a
   * `CString` is always "call the free that came with it" — the rule C has
   * always had, and a named function per allocator is how C says it.
   */
  #cstringFree(expression: ts.CallExpression): Typed | undefined {
    const argument = expression.arguments[0];
    if (expression.arguments.length !== 1 || argument === undefined) {
      this.#outer.error(expression, "GF0002", "`cstring_free` takes exactly one `CString`.");
      return undefined;
    }
    const value = this.#expressionTyped(argument, CSTRING_TYPE);
    if (value === undefined) return undefined;
    if (value.type.kind !== "cstring") {
      this.#outer.error(
        argument,
        "GF0002",
        `\`cstring_free\` releases a \`CString\`, and this is a ` +
          `\`${renderType(value.type)}\`. A \`string\` releases itself.`,
      );
      return undefined;
    }
    return this.#callRuntime(expression, RUNTIME.stringFree, [value], VOID);
  }

  /** The contract `tryCast<T>(…)` was asked for, or `undefined`. */
  #tryCastTarget(expression: ts.CallExpression): MachineType | undefined {
    const argument = expression.typeArguments?.[0];
    if (expression.typeArguments?.length !== 1 || argument === undefined) {
      this.#outer.error(
        expression,
        "GF0002",
        "`tryCast` needs exactly one type argument: `tryCast<Pet>(value)`.",
      );
      return undefined;
    }
    // `tryCast<Pet>(…)`, not `tryCast<Reference<Pet>>(…)` — the type argument
    // names the thing being asked about, and `Reference` is what comes back.
    // So a bare contract is resolved here rather than through `erase`, which
    // (rightly) refuses one used as a type.
    const type = this.#outer.checker.getTypeFromTypeNode(argument);
    let target: MachineType | undefined;
    try {
      target = contractOf(this.#outer.checker, type) ?? undefined;
    } catch (error) {
      if (error instanceof ErasureError) {
        this.#outer.error(argument, error.code, error.message);
        return undefined;
      }
      throw error;
    }
    target ??= this.#outer.erase(argument, type);
    if (target === undefined) return undefined;
    // A contract, or a class. Same question, two mechanisms: search the
    // dynamic type's itab table, or walk its descriptor's base chain.
    if (target.kind === "interface") return target;
    if (target.kind === "class") {
      return { kind: "reference", referent: target };
    }
    this.#outer.error(
      argument,
      "GF0002",
      `\`tryCast\` asks whether a value is really some class or contract. ` +
        `\`${renderType(target)}\` is neither, and for the twelve widths the ` +
        "answer is decided at compile time — `nativeCast` is the conversion " +
        "you want there.",
    );
    return undefined;
  }

  /**
   * `tryCast<Pet>(animal)` — the dynamic half of interface dispatch.
   *
   * Unlike a static conversion there is no class here, because the static type
   * is precisely what failed to answer the question. The object's vtable
   * pointer leads to its *dynamic* type descriptor, and the runtime searches
   * that descriptor's itab table.
   *
   * The result is an ordinary local, which is what makes this cheaper than a
   * type guard would have been: no rebinding, no narrowed scope, nothing
   * flow-sensitive. tsc's `strictNullChecks` does the rest, and it does it
   * better than a guard — `tryCast<Pet>(x).feed()` is rejected outright rather
   * than merely discouraged.
   */
  #tryCast(expression: ts.CallExpression): Typed | undefined {
    const contract = this.#tryCastTarget(expression);
    if (contract === undefined) return undefined;

    const argument = expression.arguments[0];
    if (expression.arguments.length !== 1 || argument === undefined) {
      this.#outer.error(expression, "GF0002", "`tryCast` takes exactly one value.");
      return undefined;
    }

    const value = this.#value(argument, undefined);
    if (value === undefined) return undefined;
    const asClass = this.#asClass(value);
    if (asClass === undefined) {
      this.#outer.unsupported(
        argument,
        "`tryCast` of anything but a class value or a reference to one",
      );
      return undefined;
    }

    // Interning the type is what declares the interface, so asking for the
    // type is what makes the id exist.
    const ty = this.#outer.tyOf(contract, expression);

    let rvalue: Rvalue;
    if (contract.kind === "interface") {
      const resolved = this.#outer.interfaceId(contract.name);
      if (resolved === undefined) return undefined;
      rvalue = { kind: "TryInterface", interface: resolved, source: asClass.place };
    } else if (contract.kind === "reference" && contract.referent.kind === "class") {
      const resolved = this.#outer.classId(contract.referent.name);
      if (resolved === undefined) return undefined;
      rvalue = { kind: "TryClass", class: resolved, source: asClass.place };
    } else {
      return undefined;
    }

    const local = this.#f.addLocal({
      ty,
      storage: "Temporary",
      span: this.#outer.span(expression),
    });
    this.#push({ kind: "StorageLive", value: local });
    this.#push({ kind: "Init", place: placeOf(local), rvalue });
    return { operand: { kind: "Copy", value: placeOf(local) }, type: contract };
  }

  /**
   * The contract an expression already holds, or `undefined`.
   *
   * Reports nothing, for the same reason `classNameAt` reports nothing: this
   * decides *whether* a call is interface dispatch, before anything commits to
   * lowering it that way.
   */
  #contractAt(
    expression: ts.Expression,
  ): Extract<MachineType, { kind: "interface" }> | undefined {
    const width = this.#widths.get(expression);
    if (width?.kind === "typed" && width.type.kind === "interface") return width.type;

    // Stripped of `| null` first. Before the check that consumes it, a
    // `tryCast` result is a union, and a union's property list is only what its
    // members have in common — which for `Reference<Pet> | null` is nothing, so
    // the brand would be invisible.
    const type = this.#outer.checker.getNonNullableType(
      this.#outer.checker.getTypeAtLocation(expression),
    );
    const referent = referentOf(this.#outer.checker, type);
    if (referent === null) return undefined;
    try {
      const contract = contractOf(this.#outer.checker, referent);
      return contract?.kind === "interface" ? contract : undefined;
    } catch {
      // A malformed contract. Whatever is wrong with it is reported by the
      // ordinary erasure path, which has a node to attach it to.
      return undefined;
    }
  }

  /**
   * `p.feed()` where `p` is a `Reference<I>` — dispatch through the itab.
   *
   * Two loads and an indirect call, exactly like a virtual call, and the slot
   * is a compile-time constant. The receiver operand is the *pair*; the backend
   * takes the itab and the object out of it and passes the object as `this`, so
   * the callee is an ordinary method that knows nothing about interfaces.
   */
  #interfaceCall(
    expression: ts.CallExpression,
    access: ts.PropertyAccessExpression,
    contract: Extract<MachineType, { kind: "interface" }>,
  ): Typed | undefined {
    const slot = contract.methods.findIndex((method) => method.name === access.name.text);
    const method = contract.methods[slot];
    if (method === undefined) {
      this.#outer.unsupported(access, `\`${contract.name}.${access.name.text}()\``);
      return undefined;
    }

    const receiver = this.#value(access.expression, contract);
    if (receiver === undefined) return undefined;

    if (expression.arguments.length !== method.params.length) {
      this.#outer.error(
        expression,
        "GF0002",
        `\`${contract.name}.${method.name}\` takes ${method.params.length} ` +
          `argument${method.params.length === 1 ? "" : "s"}, and ` +
          `${expression.arguments.length} ${
            expression.arguments.length === 1 ? "was" : "were"
          } supplied.`,
      );
      return undefined;
    }

    const args: Operand[] = [this.#forRead(receiver)];
    for (const [index, argument] of expression.arguments.entries()) {
      const want = method.params[index]!;
      const value = this.#expressionTyped(argument, want);
      if (value === undefined) return undefined;
      args.push(this.#forArgument(argument, value));
    }

    // The signature the *interface* declares, not any class's: at the call site
    // the class is unknown, which is the whole point of dispatching.
    const receiverTy = this.#outer.mir.ty({
      kind: "Pointer",
      value: this.#outer.mir.ty({ kind: "Void" }),
    });
    const sig = this.#outer.mir.sig({
      params: [
        { ty: receiverTy, name: null },
        ...method.params.map((param) => ({
          ty: this.#outer.tyOf(param, expression),
          name: null,
        })),
      ],
      ret: this.#outer.tyOf(method.returns, expression),
      abi: "Internal",
    });

    const returns = method.returns;
    const destination =
      returns.kind === "void"
        ? undefined
        : this.#f.addLocal({
            ty: this.#outer.tyOf(returns, expression),
            storage: "Temporary",
          });
    if (destination !== undefined) {
      this.#temporaries.push(destination);
      this.#push({ kind: "StorageLive", value: destination });
    }

    const next = this.#f.block();
    this.#seal({
      kind: "Call",
      callee: { kind: "Interface", slot, sig },
      args,
      destination: { place: placeOf(destination ?? LocalId(0)), target: next },
      unwind: NO_UNWIND,
    });
    this.#current = next;

    if (destination === undefined) return undefined;
    return this.#fromCall(destination, returns);
  }

  /**
   * `super.m(a)` — the base's implementation, called **directly**.
   *
   * The direct call is not an optimisation, it is the only thing that
   * terminates. A virtual call here would load the receiver's vtable, find the
   * *derived* override, and re-enter the very method doing the `super` call —
   * `Cat.speak` calling `super.speak()` would be `Cat.speak` calling itself
   * until the stack ran out. `super` names a body, not a slot.
   *
   * Which body: the base's **final overrider** for that name as of the base,
   * so a three-deep chain where the middle class overrides reaches the middle
   * one and not the root's.
   */
  #superMethodCall(
    expression: ts.CallExpression,
    access: ts.PropertyAccessExpression,
  ): Typed | undefined {
    const self = this.#self;
    if (self === undefined) {
      this.#outer.error(
        access,
        "GF0002",
        "`super` is only meaningful inside a method or a constructor.",
      );
      return undefined;
    }
    const base = self.base;
    if (base === undefined) {
      this.#outer.error(
        access,
        "GF0002",
        `\`${self.name}\` extends nothing, so there is no \`super\` to call.`,
      );
      return undefined;
    }
    const method = base.methods.get(access.name.text);
    if (method === undefined) {
      this.#outer.error(
        access,
        "GF0002",
        `\`${base.name}\` has no method \`${access.name.text}\`.`,
      );
      return undefined;
    }
    const record = this.#outer.fn(method.symbol);
    if (record === undefined || record.kind !== "defined") {
      this.#outer.unsupported(expression, `a call to \`${method.symbol}\``);
      return undefined;
    }

    const binding = this.#scopes.lookup("this");
    if (binding === undefined) {
      this.#outer.error(access, "GF0002", "`super` needs a `this` to call through.");
      return undefined;
    }

    // `this` is already a `Reference<Self>`, and a `Reference<Derived>` is a
    // valid `Reference<Base>` because the base is a layout prefix — which is
    // the whole reason fields are flattened base-first.
    const args = this.#classCallArgs(
      expression,
      base,
      method.symbol,
      expression.arguments,
      { kind: "Copy", value: placeOf(binding.local) },
    );
    if (args === undefined || args === null) return undefined;

    const returns = record.signature.returns;
    const destination =
      returns.kind === "void"
        ? undefined
        : this.#f.addLocal({
            ty: this.#outer.tyOf(returns, expression),
            storage: "Temporary",
          });
    if (destination !== undefined) {
      this.#temporaries.push(destination);
      this.#push({ kind: "StorageLive", value: destination });
    }

    this.#callDirect(record.id, args, destination);
    if (destination === undefined) return undefined;
    return this.#fromCall(destination, returns);
  }

  /**
   * `super(a, b)` — the base constructor, called directly.
   *
   * Direct and not virtual: a constructor is never overridden, and the base
   * part of the object is being built rather than dispatched on. The vtable
   * pointer is not touched, because `Default` already installed the
   * most-derived one — see the note in DECISIONS on construction-time virtual
   * calls.
   */
  #superCall(expression: ts.CallExpression): Typed | undefined {
    const self = this.#self;
    if (self === undefined || !this.#inConstructor) {
      this.#outer.error(
        expression,
        "GF0002",
        "`super(…)` is only meaningful inside a constructor.",
      );
      return undefined;
    }
    const base = self.base;
    if (base === undefined) {
      this.#outer.error(
        expression,
        "GF0002",
        `\`${self.name}\` extends nothing, so there is no \`super\` to call.`,
      );
      return undefined;
    }
    const receiver = this.#thisTyped(expression);
    if (receiver === undefined) return undefined;
    const binding = this.#scopes.lookup("this")!;

    const args = this.#classCallArgs(
      expression,
      base,
      base.constructorSymbol,
      expression.arguments,
      { kind: "Copy", value: placeOf(binding.local) },
    );
    if (args === undefined) return undefined;
    if (args === null) {
      if (expression.arguments.length > 0) {
        this.#outer.error(
          expression,
          "GF0002",
          `\`${base.name}\` declares no constructor, so \`super\` takes no arguments.`,
        );
        return undefined;
      }
      // The base has nothing to construct, but this class may still have field
      // initialisers waiting behind the `super()` that is written here.
      this.#emitPendingInitialisers();
      return undefined;
    }

    const record = this.#outer.fn(base.constructorSymbol!);
    if (record === undefined || record.kind !== "defined") return undefined;
    this.#callDirect(record.id, args, undefined);
    // The base subobject is complete, which is exactly when C++ runs this
    // class's default member initialisers — before the constructor body.
    this.#emitPendingInitialisers();
    return undefined;
  }

  /**
   * `console.log(x)` and its four siblings.
   *
   * The argument is converted to a `string` the same way an interpolation
   * converts it, so `console.log(x)` and ``console.log(`${x}`)`` genuinely mean
   * the same thing. The converted string is a temporary and dies with the
   * statement, which is what keeps printing in a loop from leaking.
   */
  #console(expression: ts.CallExpression): Typed | undefined {
    const access = expression.expression as ts.PropertyAccessExpression;
    const stream = CONSOLE_METHODS[access.name.text];
    if (stream === undefined) {
      this.#outer.unsupported(expression, "this call target");
      return undefined;
    }

    const argument = expression.arguments[0];
    if (expression.arguments.length !== 1 || argument === undefined) {
      this.#outer.unsupported(expression, "`console` with anything but one argument");
      return undefined;
    }

    const value = this.#value(argument, undefined);
    if (value === undefined) return undefined;
    const text = this.#toStringValue(argument, value);
    if (text === undefined) return undefined;

    return this.#callRuntime(
      expression,
      stream === "out" ? RUNTIME.print : RUNTIME.eprint,
      [text],
      VOID,
    );
  }

  /**
   * `move(x)` — hand ownership somewhere else instead of copying.
   *
   * Only a named local can be moved from: moving out of a temporary is what
   * already happens, and moving out of a field would leave a hole in something
   * still alive, which needs the partial-initialisation tracking that arrives
   * with aggregates.
   */
  #move(expression: ts.CallExpression): Typed | undefined {
    const argument = expression.arguments[0];
    if (argument === undefined) return undefined;

    if (!ts.isIdentifier(argument)) {
      this.#outer.unsupported(argument, "moving out of anything but a local");
      return undefined;
    }
    const binding = this.#scopes.lookup(argument.text);
    if (binding === undefined) {
      this.#outer.unsupported(argument, `the name \`${argument.text}\``);
      return undefined;
    }
    if (this.#readMoved(argument, binding.local, argument.text)) return undefined;

    // Moving out of a by-value parameter is a double free, and it is worth
    // being precise about why, because C++ permits the same-looking line.
    //
    // REWRITE-PLAN §11.4 puts destruction of a by-value argument on the
    // *caller*. In C++ that is safe to move out of, because the parameter
    // object *is* the thing the caller destroys — `std::move` empties the very
    // object whose destructor will run. Here an owning value travels as a
    // one-word handle in a register (§4.5), so the callee's copy of the handle
    // is a different local: nulling it does nothing to the caller's temporary,
    // and both would release the same buffer.
    //
    // Found by the C++ oracle rather than by reading, which is the entire
    // reason the oracle exists.
    if (this.#isOwningParameter(binding)) {
      this.#outer.error(
        argument,
        "GF0236",
        `\`${argument.text}\` is a by-value parameter, and the caller releases it ` +
          "when the call ends — so moving out of it here would free the same " +
          "buffer twice. Copy it instead (assigning it is a copy), or take a " +
          `\`Reference<${renderType(binding.type)}>\` if the caller should keep ` +
          "ownership and this should not.",
      );
      return undefined;
    }

    this.#moved.set(binding.local, argument.text);
    return { operand: { kind: "Move", value: placeOf(binding.local) }, type: binding.type };
  }

  /**
   * Whether a binding is one of this function's owning by-value parameters.
   *
   * Parameters are locals `1..=n`, in order — the one place in this compiler
   * where a local's *index* carries meaning, and it comes from the MIR's own
   * definition of a function rather than from a convention invented here.
   */
  #isOwningParameter(binding: Binding): boolean {
    if (!this.#owns(binding.type)) return false;
    const params = this.#f.raw.locals.length === 0 ? 0 : this.#paramCount();
    return binding.local >= 1 && binding.local <= params;
  }

  #paramCount(): number {
    return this.#outer.mir.paramCount(this.#f.raw.sig);
  }

  /**
   * Report a read of a moved-from value.
   *
   * Not flow-sensitive, and deliberately so for now: a move is seen for the
   * rest of the function once it has happened, so a move under an `if` is
   * reported after the `if` even where the branch might not have run. An
   * assignment to the binding clears the mark, which is what makes the
   * conservative direction liveable — a `let` moved out of inside a loop and
   * refilled before the next pass is the ordinary shape, not an exception.
   *
   * The cost of the other direction is bounded anyway: a move nulls its source,
   * so a read this misses finds an empty value rather than freed memory. A
   * wrong answer, never corruption.
   */
  #readMoved(at: ts.Node, local: LocalId, name: string): boolean {
    const moved = this.#moved.get(local);
    if (moved === undefined) return false;
    this.#outer.error(
      at,
      "GF0235",
      `\`${name}\` was moved from, so it no longer holds a value. ` +
        `Bind the result of the \`move\` to a name and read that instead.`,
    );
    return true;
  }

  /**
   * `nativeCast<T>(value)` — the written form of a conversion.
   *
   * This is the only way to narrow, and the only way to perform a conversion
   * that could lose a value. Everything it does is something the language
   * refuses to do on its own, which is why it has to be written.
   */
  #nativeCast(expression: ts.CallExpression, target: MachineType): Typed | undefined {
    const argument = expression.arguments[0];
    if (expression.arguments.length !== 1 || argument === undefined) {
      this.#outer.error(
        expression,
        "GF0163",
        "`nativeCast` takes exactly one value to convert.",
      );
      return undefined;
    }

    const width = this.width(argument);
    if (width.kind === "error") return undefined;
    // Converting a literal is a no-op the language would have done anyway, so
    // the literal is simply range-checked at the target width.
    //
    // Unless it is a *fractional* literal being converted to an integer width,
    // which is the one case where there is a real conversion to do:
    // `nativeCast<i32>(1.5)` is C++'s `static_cast<int>(1.5)` and means one.
    // Range-checking `1.5` at `i32` would reject it (`GF0164`) for being
    // written as a float — which is the right answer where the cast is absent
    // and the wrong one here, because the cast is how truncation is asked for.
    if (width.kind === "poly") {
      if (isIntegerType(target) && fractionalLiteralIn(argument)) {
        const asFloat: MachineType = { kind: "scalar", name: "f64" };
        const value = this.#value(argument, asFloat);
        if (value === undefined) return undefined;
        return this.#temporaryTyped(expression, target, {
          kind: "Cast",
          op: "FloatToInt",
          operand: value.operand,
          to: this.#outer.tyOf(target, expression),
        });
      }
      const value = this.#value(argument, target);
      return value === undefined ? undefined : { operand: value.operand, type: target };
    }

    const value = this.#value(argument, width.type);
    if (value === undefined) return undefined;
    if (sameType(value.type, target)) return { operand: value.operand, type: target };

    const kind = this.#castKind(expression, value.type, target);
    if (kind === undefined) return undefined;
    return this.#temporaryTyped(expression, target, {
      kind: "Cast",
      op: kind,
      operand: value.operand,
      to: this.#outer.tyOf(target, expression),
    });
  }

  // -- plumbing ------------------------------------------------------------

  /** The `bool` type id, interned once. */
  #boolTy(): TyId {
    return this.#outer.mir.ty({ kind: "Bool" });
  }

  #boolConst(value: boolean) {
    return { kind: "Bool", value, ty: this.#boolTy() } as const;
  }

  #strConst(text: string) {
    return {
      kind: "Str",
      text: this.#outer.mir.sym(text),
      ty: this.#outer.mir.ty({ kind: "Str" }),
    } as const;
  }

  #temporary(node: ts.Node, type: MachineType, rvalue: Rvalue): Operand {
    return this.#temporaryTyped(node, type, rvalue).operand;
  }

  /** Put a computed value into a temporary and hand back a reference to it. */
  #temporaryTyped(node: ts.Node, type: MachineType, rvalue: Rvalue): Typed {
    const local = this.#f.addLocal({
      ty: this.#outer.tyOf(type, node),
      // Unnamed, produced by an expression, destroyed at the end of the
      // enclosing full-expression rather than at scope exit — which is why it
      // is tracked here and not in a scope (REWRITE-PLAN §4.2, §4.4).
      storage: "Temporary",
    });
    this.#temporaries.push(local);
    this.#push({ kind: "StorageLive", value: local });
    this.#push({ kind: "Init", place: placeOf(local), rvalue });
    // `Borrow` rather than `Copy`: the temporary *is* the value, and cloning it
    // at the point of use would allocate a second time and leak the first.
    // Whoever consumes it decides whether to move out of it instead.
    return {
      operand: {
        kind: this.#needsCallerCopy(type) ? "Borrow" : "Copy",
        value: placeOf(local),
      },
      type,
      temporary: local,
    };
  }

  /**
   * The operand form of a value being *stored* somewhere that will own it.
   *
   * A temporary is moved: it is already the copy, and cloning it would allocate
   * twice and leave the first allocation to the full-expression to clean up.
   * Anything else is copied, because it belongs to somebody who still wants it.
   */
  #forStorage(value: Typed): Operand {
    if (value.temporary !== undefined && this.#needsCallerCopy(value.type)) {
      return { kind: "Move", value: placeOf(value.temporary) };
    }
    return value.operand;
  }

  /**
   * The operand form of a value that is only going to be **read**.
   *
   * Concatenation, comparison, `length` and `console.log` all read their
   * operands and none of them takes ownership, so none of them needs a copy.
   * Cloning for these was the second leak the allocation counter found, and it
   * is invisible from the program's output — every one of them printed exactly
   * the right thing while allocating twice as much as it freed.
   *
   * This is *not* how a by-value argument to a user function works: see
   * {@link #forArgument}.
   */
  #forRead(value: Typed): Operand {
    if (!this.#needsCallerCopy(value.type)) return value.operand;
    if (value.operand.kind === "Const") return value.operand;
    return { kind: "Borrow", value: value.operand.value };
  }

  /**
   * The operand form of a value that will be read **more than once**.
   *
   * Always a `Copy` of a place, so each use applies the type's copy operation
   * and gets its own value. The usual move-out-of-a-temporary optimisation is
   * exactly wrong here: it is correct precisely because a temporary is used
   * once, and this is the case where it is not.
   */
  #repeatable(value: Typed): Operand {
    if (value.temporary !== undefined) {
      return { kind: "Copy", value: placeOf(value.temporary) };
    }
    if (value.operand.kind === "Const") return value.operand;
    return { kind: "Copy", value: value.operand.value };
  }

  /**
   * The operand form of a by-value call argument.
   *
   * REWRITE-PLAN §4.5: the caller makes the copy and the caller destroys it.
   * So an owning argument is materialised into a temporary — which the
   * full-expression will drop — and passed as a borrow of that temporary.
   */
  #forArgument(at: ts.Node, value: Typed): Operand {
    if (!this.#needsCallerCopy(value.type)) return value.operand;
    if (value.temporary !== undefined) {
      return { kind: "Borrow", value: placeOf(value.temporary) };
    }
    // A named local: the caller makes the copy that *is* the argument, so that
    // the callee's parameter is a borrow of something the callee cannot outlive
    // and the caller cannot have taken away.
    const copy = this.#temporaryTyped(at, value.type, { kind: "Use", value: value.operand });
    return copy.operand;
  }

  #push(statement: Parameters<FunctionBuilder["push"]>[1]): void {
    if (this.#current === undefined) return;
    this.#f.push(this.#current, statement);
  }

  #seal(terminator: Terminator): void {
    if (this.#current === undefined) return;
    this.#f.seal(this.#current, terminator);
    this.#current = undefined;
  }
}

// ---------------------------------------------------------------------------

function placeOf(local: LocalId): Place {
  return { local, projection: [] };
}

/** The element type of anything that can be indexed. */
function elementTypeOf(type: MachineType): MachineType | undefined {
  switch (type.kind) {
    case "fixedArray":
    case "array":
      return type.element;
    // `p[i]` is `*(p + i)`, as in C.
    case "pointer":
      return type.pointee;
    default:
      return undefined;
  }
}

function describe(node: ts.Node): string {
  const name = ts.SyntaxKind[node.kind];
  return `a ${name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`;
}

/**
 * Whether an expression built only from literals contains a fractional one.
 *
 * Such an expression has no width of its own and takes one from its context,
 * so a single `1.5` anywhere inside it makes `f64` the only context that can
 * hold the written value — which is what `nativeCast` needs to know before it
 * range-checks the thing at an integer width.
 */
function fractionalLiteralIn(expression: ts.Node): boolean {
  if (ts.isNumericLiteral(expression)) return !isIntegerLiteral(expression.getText());
  return expression.getChildren().some((child) => fractionalLiteralIn(child));
}
