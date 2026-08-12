/**
 * Finding classes, flattening them, and assigning vtable slots.
 *
 * This is the analysis half of milestone 8, kept apart from `lower.ts` because
 * it produces plain data and answers questions that have nothing to do with
 * building MIR: what does this class inherit, which of its methods override
 * something, and which slot does each one get.
 *
 * The two flattening rules, which everything downstream depends on:
 *
 * * **Fields are flattened, base classes' first.** A `FieldId` then means the
 *   same thing whatever the static type is, and a `Base` is a byte-for-byte
 *   prefix of every `Derived`, so an upcast is a no-op (REWRITE-PLAN §5).
 * * **Vtable slots are flattened the same way**, with slot 0 reserved for the
 *   destructor. An override reuses its base's slot; a new method appends. A
 *   `Derived` vtable is therefore a prefix-compatible extension of its `Base`,
 *   which is what makes a call through a `Base` reference find the final
 *   overrider (REWRITE-PLAN §4.1).
 *
 * Slots are per *class*, never per name across the module. v1 numbered them by
 * name so that an interface could dispatch without a side table; that is a
 * closed-world trick and REWRITE-PLAN §3 lists it as one of the two things a
 * library boundary breaks on day one.
 */

import ts from "typescript";

import type { MachineType } from "@goblin-forge/checker";

/** A field, after flattening. */
export interface ClassField {
  readonly name: string;
  readonly type: MachineType;
  readonly declaration: ts.PropertyDeclaration;
  /** The class that declared it, which is not always the one that has it. */
  readonly owner: string;
}

/** A method, with the slot it dispatches through. */
export interface ClassMethod {
  readonly name: string;
  readonly slot: number;
  readonly declaration: ts.MethodDeclaration;
  /** The class whose body runs — the final overrider as of this class. */
  readonly owner: string;
  /** The symbol its function is emitted under. */
  readonly symbol: string;
}

export interface ClassInfo {
  readonly node: ts.ClassDeclaration;
  readonly name: string;
  readonly base: ClassInfo | undefined;
  /** Flattened, base classes' fields first. */
  readonly fields: readonly ClassField[];
  /** Where this class's own fields start in {@link ClassInfo.fields}. */
  readonly ownFieldsAt: number;
  /**
   * Every virtual slot in order, holding this class's final overrider. Index 0
   * is the destructor and is not in {@link ClassInfo.methods}.
   */
  readonly slots: readonly string[];
  /** Every method callable on this class, own and inherited, by name. */
  readonly methods: ReadonlyMap<string, ClassMethod>;
  readonly ctor: ts.ConstructorDeclaration | undefined;
  /** `Class$drop`, the compiler-generated destructor. */
  readonly destructorSymbol: string;
  /** `Class$new`, or `undefined` when the class declares no constructor. */
  readonly constructorSymbol: string | undefined;
  /** Interfaces named in an `implements` clause, by name. */
  readonly declaredInterfaces: readonly string[];
}

export interface ClassReport {
  /** A construct that is meant to work and does not yet. */
  unsupported(node: ts.Node, what: string): void;
  /** A construct that is not part of the language. */
  refuse(node: ts.Node, message: string): void;
  /** Erase a type, or report and return `undefined`. */
  erase(at: ts.Node, type: ts.Type): MachineType | undefined;
}

/**
 * Every class in the program, **base classes before the classes that derive
 * from them**.
 *
 * That order is not a nicety: flattening a derived class reads its base's
 * already-flattened tables, so a derived class analysed first would inherit an
 * empty one and lay its fields on top of its base's.
 */
export function collectClasses(
  program: ts.Program,
  checker: ts.TypeChecker,
  report: ClassReport,
): Map<string, ClassInfo> {
  const declarations = new Map<string, ts.ClassDeclaration>();
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || program.isSourceFileFromExternalLibrary(source)) continue;
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      if (statement.name === undefined) {
        report.unsupported(statement, "an anonymous class");
        continue;
      }
      // Two classes with the same name in different modules are legal
      // TypeScript, and this compiler cannot lower them: a class's name is what
      // its vtable, its type descriptor and its methods are emitted under, so
      // two of them collide at the linker with no file and no line — the shape
      // of failure REWRITE-PLAN §8 exists to prevent.
      //
      // Rejected rather than qualified, deliberately. Qualifying is the right
      // fix and is not free: a class would need a *symbol* distinct from its
      // *name*, so that a descriptor still carries the readable one for
      // `instanceof` and diagnostics. That is a wire-format change, and this
      // restriction is cheap to lift once it is wanted.
      const existing = declarations.get(statement.name.text);
      if (existing !== undefined) {
        report.refuse(
          statement,
          `there is already a class called \`${statement.name.text}\`, in ` +
            `${existing.getSourceFile().fileName}. Class names are global to a ` +
            "build, because a class is emitted under its name. Rename one of them.",
        );
        continue;
      }
      declarations.set(statement.name.text, statement);
    }
  }

  const result = new Map<string, ClassInfo>();
  const inProgress = new Set<string>();

  const analyse = (name: string): ClassInfo | undefined => {
    const existing = result.get(name);
    if (existing !== undefined) return existing;
    const node = declarations.get(name);
    if (node === undefined) return undefined;

    // tsc rejects a cyclic `extends` on its own, but this runs before its
    // diagnostics are necessarily fatal and a cycle here is an infinite loop
    // rather than an error message.
    if (inProgress.has(name)) {
      report.refuse(node, `\`${name}\` extends itself.`);
      return undefined;
    }
    inProgress.add(name);
    const info = build(node, name, analyse, checker, report);
    inProgress.delete(name);

    if (info !== undefined) result.set(name, info);
    return info;
  };

  for (const name of declarations.keys()) analyse(name);
  return result;
}

function build(
  node: ts.ClassDeclaration,
  name: string,
  analyse: (name: string) => ClassInfo | undefined,
  checker: ts.TypeChecker,
  report: ClassReport,
): ClassInfo | undefined {
  if (node.typeParameters && node.typeParameters.length > 0) {
    // REWRITE-PLAN §11.7 is open. Until it is answered this is a gap in the
    // implementation rather than a rule about the language.
    report.unsupported(node.typeParameters[0]!, "a generic class");
    return undefined;
  }

  const base = baseOf(node, analyse, report);
  if (base === null) return undefined;

  // `implements` is erased by tsc — it is a shape assertion and nothing more —
  // but the heritage clause is still in the AST, so it costs nothing to read.
  //
  // It is deliberately *not* required for a conversion: DECISIONS §11.2 makes a
  // static conversion structural, matching TypeScript. What declaring it will
  // buy is being findable by a **dynamic** cast, which needs the itab reachable
  // from the class's type descriptor and therefore needs to be known at the
  // class's own declaration. Recorded now so that arrives without a change of
  // shape here.
  const declaredInterfaces: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const expression of clause.types) {
      if (!ts.isIdentifier(expression.expression)) {
        report.unsupported(expression, "an expression in an `implements` clause");
        return undefined;
      }
      declaredInterfaces.push(expression.expression.text);
    }
  }

  // -- fields ---------------------------------------------------------------
  const fields: ClassField[] = base ? [...base.fields] : [];
  const ownFieldsAt = fields.length;
  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    if (!ts.isIdentifier(member.name)) {
      report.unsupported(member, "a computed or non-identifier field name");
      return undefined;
    }
    if (member.questionToken) {
      report.refuse(
        member,
        `\`${name}.${member.name.text}\` is optional. There is no \`undefined\` ` +
          "here for it to be, and no space in the layout for it not to be.",
      );
      return undefined;
    }
    if (isStatic(member)) {
      report.unsupported(member, "a static field");
      return undefined;
    }
    const type = report.erase(member, checker.getTypeAtLocation(member));
    if (type === undefined) return undefined;
    if (fields.some((field) => field.name === (member.name as ts.Identifier).text)) {
      report.refuse(
        member,
        `\`${name}.${member.name.text}\` shadows a field of the same name in a ` +
          "base class. The base's field would still be there, unreachable and " +
          "still destroyed — so this is rejected rather than laid out twice.",
      );
      return undefined;
    }
    fields.push({ name: member.name.text, type, declaration: member, owner: name });
  }

  // -- vtable ---------------------------------------------------------------
  //
  // Slot 0 is always the destructor. Everything else is inherited in the base's
  // order, then extended: an override writes over the slot it inherited, a new
  // method appends one.
  const destructorSymbol = `${name}$drop`;
  const slots: string[] = base ? [...base.slots] : [destructorSymbol];
  slots[0] = destructorSymbol;

  const methods = new Map<string, ClassMethod>();
  if (base) {
    for (const [methodName, method] of base.methods) methods.set(methodName, method);
  }

  for (const member of node.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!ts.isIdentifier(member.name)) {
      report.unsupported(member, "a computed or non-identifier method name");
      return undefined;
    }
    if (isStatic(member)) {
      report.unsupported(member, "a static method");
      return undefined;
    }
    if (member.body === undefined) {
      report.unsupported(member, "a method with no body");
      return undefined;
    }
    if (member.typeParameters && member.typeParameters.length > 0) {
      report.unsupported(member.typeParameters[0]!, "a generic method");
      return undefined;
    }

    const methodName = member.name.text;
    const symbol = `${name}$${methodName}`;
    const inherited = methods.get(methodName);
    // An override keeps the slot it inherited, which is exactly what makes a
    // call through a base reference reach this body.
    const slot = inherited?.slot ?? slots.length;
    if (inherited === undefined) slots.push(symbol);
    else slots[slot] = symbol;
    methods.set(methodName, { name: methodName, slot, declaration: member, owner: name, symbol });
  }

  // -- the constructor ------------------------------------------------------
  const constructors = node.members.filter(ts.isConstructorDeclaration);
  if (constructors.length > 1) {
    report.unsupported(constructors[1]!, "an overloaded constructor");
    return undefined;
  }
  const ctor = constructors[0];
  if (ctor !== undefined && ctor.body === undefined) {
    report.unsupported(ctor, "a constructor with no body");
    return undefined;
  }

  for (const member of node.members) {
    if (
      ts.isPropertyDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isConstructorDeclaration(member) ||
      member.kind === ts.SyntaxKind.SemicolonClassElement
    ) {
      continue;
    }
    report.unsupported(member, describeMember(member));
    return undefined;
  }

  return {
    node,
    name,
    base: base ?? undefined,
    fields,
    ownFieldsAt,
    slots,
    methods,
    ctor,
    destructorSymbol,
    constructorSymbol: ctor === undefined ? undefined : `${name}$new`,
    declaredInterfaces,
  };
}

/**
 * The base class, or `undefined` for a root, or `null` when something is wrong
 * and has already been reported.
 */
function baseOf(
  node: ts.ClassDeclaration,
  analyse: (name: string) => ClassInfo | undefined,
  report: ClassReport,
): ClassInfo | undefined | null {
  const clause = node.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
  if (clause === undefined) return undefined;
  const [expression, ...rest] = clause.types;
  if (expression === undefined) return undefined;
  if (rest.length > 0) {
    report.refuse(rest[0]!, "a class extends at most one class.");
    return null;
  }
  if (!ts.isIdentifier(expression.expression)) {
    report.unsupported(expression, "an expression in an `extends` clause");
    return null;
  }
  const base = analyse(expression.expression.text);
  if (base === undefined) {
    report.unsupported(expression, `\`${expression.expression.text}\` as a base class`);
    return null;
  }
  return base;
}

function isStatic(member: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(member) &&
    (ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
  );
}

function describeMember(member: ts.ClassElement): string {
  if (ts.isGetAccessor(member)) return "a getter";
  if (ts.isSetAccessor(member)) return "a setter";
  if (ts.isIndexSignatureDeclaration(member)) return "an index signature";
  if (ts.isClassStaticBlockDeclaration(member)) return "a static block";
  return "this class member";
}
