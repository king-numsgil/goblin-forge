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

import type { MachineType } from "@goblin-forge/checker";
import ts from "typescript";

/** A field, after flattening. */
export interface ClassField {
    readonly name: string;
    readonly type: MachineType;
    /**
     * A `ParameterDeclaration` when this is a **parameter property** —
     * `constructor(private x: i32)`, which declares a field and a parameter with
     * one piece of syntax. The two are the same field either way; only where the
     * initial value comes from differs, and that is the constructor's business
     * rather than the layout's.
     */
    readonly declaration: ts.PropertyDeclaration | ts.ParameterDeclaration;
    /** The class that declared it, which is not always the one that has it. */
    readonly owner: string;
}

/**
 * A `static` method: a free function that happens to be written inside a class.
 *
 * No receiver, no vtable slot, no dispatch — the class name is a namespace and
 * nothing more, which is exactly why one can be taken as a function pointer
 * where an instance method cannot. An instance method needs a `this` that a
 * `(a: i32) => i32` has nowhere to put.
 */
export interface StaticMethod {
    readonly name: string;
    readonly declaration: ts.MethodDeclaration | ts.AccessorDeclaration;
    /** The symbol its function is emitted under: `Class$name`. */
    readonly symbol: string;
    /**
     * The class that declared it.
     *
     * A static is *inherited* by name — `Derived.helper()` resolves to
     * `Base.helper` — but emitted once, where it was written. Comparing the owner
     * is how the emit loop knows which; comparing the symbol against
     * `` `${name}$${method.name}` `` did the same job until static accessors
     * arrived with symbols that never take that shape.
     */
    readonly owner: string;
}

/**
 * What a method's body is written as.
 *
 * An accessor is a method wearing property syntax: `get name()` takes no
 * arguments and returns, `set name(v)` takes one and returns nothing. They get
 * vtable slots like any other method, because `override get` has to dispatch.
 */
export type MethodBody =
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration;

/** A method, with the slot it dispatches through. */
export interface ClassMethod {
    readonly name: string;
    readonly slot: number;
    readonly declaration: MethodBody;
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
    /**
     * `get name()` and `set name(v)`, own and inherited.
     *
     * Apart from {@link ClassInfo.methods} because they are reached by *property*
     * syntax, and apart from each other because a name may have one, the other or
     * both — and when it has both they are two functions with two slots, not one
     * thing with two halves.
     */
    readonly getters: ReadonlyMap<string, ClassMethod>;
    readonly setters: ReadonlyMap<string, ClassMethod>;
    /**
     * Every `static` method, own and inherited, by name.
     *
     * Apart from {@link ClassInfo.methods} because they are a different thing
     * wearing the same syntax: no receiver, no slot, and therefore no override.
     */
    readonly statics: ReadonlyMap<string, StaticMethod>;
    /**
     * `static get x()` and `static set x(v)`, own and inherited.
     *
     * Two maps because `get x` and `set x` are two functions, and apart from
     * {@link ClassInfo.getters} because a static accessor has no receiver to
     * dispatch on — it is a static method that happens to be reached with
     * property syntax.
     */
    readonly staticGetters: ReadonlyMap<string, StaticMethod>;
    readonly staticSetters: ReadonlyMap<string, StaticMethod>;
    /**
     * The fields this class declared as `constructor(private x: i32)`.
     *
     * Own only, never inherited: the base's are assigned by the base's own
     * constructor, which runs first.
     */
    readonly parameterProperties: readonly ClassField[];
    readonly ctor: ts.ConstructorDeclaration | undefined;
    /**
     * Whether this class has a constructor to run, declared or generated.
     *
     * A field initialiser is a constructor's work — C++ calls one a *default
     * member initialiser* and runs it as part of construction — so a class with
     * initialisers and no `constructor` still needs a `Class$new` for them to run
     * in. So does a class that has neither but derives from one that does,
     * because something has to call the base's.
     */
    readonly needsConstructor: boolean;
    /**
     * This class's own fields that were declared with `= …`, in declaration
     * order, which is the order C++ runs them in.
     */
    readonly initialisedFields: readonly ClassField[];
    /** `Class$drop`, the compiler-generated destructor. */
    readonly destructorSymbol: string;
    /** `Class$new`, or `undefined` when there is no construction to do. */
    readonly constructorSymbol: string | undefined;
    /** Interfaces named in an `implements` clause, by name. */
    readonly declaredInterfaces: readonly string[];
}

/**
 * Names a class may not use, because `Pointer<T>` already does.
 *
 * `Pointer<T>` is `T & CorePointer<T>`, so a class declaring `free` or
 * `address` ends up with a member that can never be reached through a pointer
 * to it — the pointer's own wins, silently. tsc cannot help: the intersection
 * is perfectly well typed, and picking one side of it is exactly what an
 * intersection means.
 *
 * So it is refused at the *declaration*, where the name is, rather than left to
 * surface as a call that mysteriously does something else. `tests/classes.test.ts`
 * checks this list against the prelude's own `CorePointer<T>`, so the two cannot
 * drift.
 */
export const RESERVED_ON_POINTER: readonly string[] = [
    "address",
    "deref",
    "erase",
    "free",
    "freeArray",
    "offset",
    "reify",
];

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
        if (source.isDeclarationFile || program.isSourceFileFromExternalLibrary(source)) {
            continue;
        }
        for (const statement of source.statements) {
            if (!ts.isClassDeclaration(statement)) {
                continue;
            }
            // A `declare class` is an opaque handle, not a class this build lays
            // out: there are no bodies to emit and no field offsets anything here
            // could know. `types.ts` erases it to `{ kind: "opaque" }`, and
            // analysing it as a class would only produce diagnostics about members
            // that were never meant to be lowered — `private _opaque: never` being
            // exactly the idiom people write.
            if ((ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Ambient) !== 0) {
                continue;
            }
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
        if (existing !== undefined) {
            return existing;
        }
        const node = declarations.get(name);
        if (node === undefined) {
            return undefined;
        }

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

        if (info !== undefined) {
            result.set(name, info);
        }
        return info;
    };

    for (const name of declarations.keys()) {
        analyse(name);
    }
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
    if (base === null) {
        return undefined;
    }

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
        if (clause.token !== ts.SyntaxKind.ImplementsKeyword) {
            continue;
        }
        for (const expression of clause.types) {
            if (!ts.isIdentifier(expression.expression)) {
                report.unsupported(expression, "an expression in an `implements` clause");
                return undefined;
            }
            declaredInterfaces.push(expression.expression.text);
        }
    }

    // Reserved names, checked once over every instance member rather than at
    // each of the four places one can be declared. Statics are exempt: they live
    // on the class, and `Pointer<T>` is a pointer to an *instance*.
    for (const member of node.members) {
        if (isStatic(member) || member.name === undefined || !ts.isIdentifier(member.name)) {
            continue;
        }
        if (!RESERVED_ON_POINTER.includes(member.name.text)) {
            continue;
        }
        if (
            !ts.isPropertyDeclaration(member) &&
            !ts.isMethodDeclaration(member) &&
            !ts.isGetAccessorDeclaration(member) &&
            !ts.isSetAccessorDeclaration(member)
        ) {
            continue;
        }
        report.refuse(
            member,
            `\`${member.name.text}\` is reserved: every \`Pointer<T>\` has one, and ` +
            `\`Pointer<${name}>\` is \`${name}\` and the pointer's members together. ` +
            `A \`${name}.${member.name.text}\` would be unreachable through a pointer ` +
            "— the pointer's own would answer instead, and tsc would not say so " +
            "because an intersection picking one side is exactly what it means. " +
            `The reserved names are ${RESERVED_ON_POINTER.join(", ")}.`,
        );
        return undefined;
    }

    // -- fields ---------------------------------------------------------------
    const fields: ClassField[] = base ? [...base.fields] : [];
    const ownFieldsAt = fields.length;
    for (const member of node.members) {
        // A parameter property declares a field where the constructor is written,
        // so it takes its layout position from there. Fields are laid out in
        // declaration order and never reordered, and this is the order they were
        // declared in.
        if (ts.isConstructorDeclaration(member)) {
            for (const parameter of member.parameters) {
                if (parameter.modifiers === undefined || parameter.modifiers.length === 0) {
                    continue;
                }
                if (!ts.isIdentifier(parameter.name)) {
                    report.unsupported(parameter, "a destructured parameter property");
                    return undefined;
                }
                const type = report.erase(parameter, checker.getTypeAtLocation(parameter));
                if (type === undefined) {
                    return undefined;
                }
                const parameterName = parameter.name.text;
                if (RESERVED_ON_POINTER.includes(parameterName)) {
                    report.refuse(
                        parameter,
                        `\`${parameterName}\` is reserved: every \`Pointer<T>\` has one, so a ` +
                        `\`${name}.${parameterName}\` would be unreachable through a pointer. ` +
                        `The reserved names are ${RESERVED_ON_POINTER.join(", ")}.`,
                    );
                    return undefined;
                }
                if (fields.some((field) => field.name === parameterName)) {
                    report.refuse(
                        parameter,
                        `\`${name}.${parameterName}\` is declared twice — once as a parameter ` +
                        "property and once as a field or in a base class. One name is one " +
                        "field, and laying it out twice would destroy it twice.",
                    );
                    return undefined;
                }
                fields.push({name: parameterName, type, declaration: parameter, owner: name});
            }
            continue;
        }
        if (!ts.isPropertyDeclaration(member)) {
            continue;
        }
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
        if (type === undefined) {
            return undefined;
        }
        if (fields.some((field) => field.name === (member.name as ts.Identifier).text)) {
            report.refuse(
                member,
                `\`${name}.${member.name.text}\` shadows a field of the same name in a ` +
                "base class. The base's field would still be there, unreachable and " +
                "still destroyed — so this is rejected rather than laid out twice.",
            );
            return undefined;
        }
        fields.push({name: member.name.text, type, declaration: member, owner: name});
    }

    // -- vtable ---------------------------------------------------------------
    //
    // Slot 0 is always the destructor. Everything else is inherited in the base's
    // order, then extended: an override writes over the slot it inherited, a new
    // method appends one.
    const destructorSymbol = `${name}$drop`;
    const slots: string[] = base ? [...base.slots] : [destructorSymbol];
    slots[0] = destructorSymbol;

    const statics = new Map<string, StaticMethod>();
    const staticGetters = new Map<string, StaticMethod>();
    const staticSetters = new Map<string, StaticMethod>();
    const methods = new Map<string, ClassMethod>();
    const getters = new Map<string, ClassMethod>();
    const setters = new Map<string, ClassMethod>();
    if (base) {
        for (const [accessor, method] of base.getters) {
            getters.set(accessor, method);
        }
        for (const [accessor, method] of base.setters) {
            setters.set(accessor, method);
        }
    }
    if (base) {
        // Inherited, because `Derived.helper()` resolves to `Base.helper` in
        // TypeScript. There is no overriding to do — the name is looked up at
        // compile time and there is no receiver to dispatch on.
        for (const [staticName, method] of base.statics) {
            statics.set(staticName, method);
        }
        for (const [accessor, method] of base.staticGetters) {
            staticGetters.set(accessor, method);
        }
        for (const [accessor, method] of base.staticSetters) {
            staticSetters.set(accessor, method);
        }
    }
    if (base) {
        for (const [methodName, method] of base.methods) {
            methods.set(methodName, method);
        }
    }

    for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) {
            continue;
        }
        if (!ts.isIdentifier(member.name)) {
            report.unsupported(member, "a computed or non-identifier method name");
            return undefined;
        }
        if (member.body === undefined) {
            report.unsupported(member, "a method with no body");
            return undefined;
        }
        // A `static` method is a free function in a namespace: no receiver, no
        // slot, no dispatch. Collected apart from the vtable for that reason —
        // giving one a slot would mean an object could override it, and there is
        // no object.
        if (isStatic(member)) {
            if (member.typeParameters && member.typeParameters.length > 0) {
                report.unsupported(member.typeParameters[0]!, "a generic method");
                return undefined;
            }
            statics.set(member.name.text, {
                name: member.name.text,
                declaration: member,
                symbol: `${name}$${member.name.text}`,
                owner: name,
            });
            continue;
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
        if (inherited === undefined) {
            slots.push(symbol);
        } else {
            slots[slot] = symbol;
        }
        methods.set(methodName, {name: methodName, slot, declaration: member, owner: name, symbol});
    }

    // Accessors, after the methods so that slot numbering is stable in the order
    // members are declared in — an accessor is a method with property syntax, and
    // gets a slot like one so that `override get` dispatches.
    for (const member of node.members) {
        const isGetter = ts.isGetAccessorDeclaration(member);
        if (!isGetter && !ts.isSetAccessorDeclaration(member)) {
            continue;
        }
        if (!ts.isIdentifier(member.name)) {
            report.unsupported(member, "a computed or non-identifier accessor name");
            return undefined;
        }
        if (member.body === undefined) {
            report.unsupported(member, "an accessor with no body");
            return undefined;
        }
        // A `static get x()` is a static *method* wearing property syntax: no
        // receiver, no slot, and therefore no override. Collected apart from the
        // instance accessors for exactly the reason statics are collected apart
        // from methods.
        if (isStatic(member)) {
            const table = isGetter ? staticGetters : staticSetters;
            table.set(member.name.text, {
                name: member.name.text,
                declaration: member,
                // `static$` in the middle, so a static accessor can never collide with
                // an instance one, nor with a static method of the same name.
                symbol: `${name}$static$${isGetter ? "get" : "set"}$${member.name.text}`,
                owner: name,
            });
            continue;
        }

        const accessor = member.name.text;
        if (fields.some((field) => field.name === accessor)) {
            report.refuse(
                member,
                `\`${name}.${accessor}\` is both a field and an accessor. One name is ` +
                "one thing: the field would be unreachable, and every read of it would " +
                "call the accessor instead.",
            );
            return undefined;
        }

        // Two namespaces, because `get x` and `set x` are two functions. Prefixed
        // so they cannot collide with a method called `x` either.
        const table = isGetter ? getters : setters;
        const symbol = `${name}$${isGetter ? "get" : "set"}$${accessor}`;
        const inherited = table.get(accessor);
        const slot = inherited?.slot ?? slots.length;
        if (inherited === undefined) {
            slots.push(symbol);
        } else {
            slots[slot] = symbol;
        }
        table.set(accessor, {name: accessor, slot, declaration: member, owner: name, symbol});
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
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member) ||
            member.kind === ts.SyntaxKind.SemicolonClassElement
        ) {
            continue;
        }
        report.unsupported(member, describeMember(member));
        return undefined;
    }

    // A field initialiser is construction, so a class that has one needs a
    // constructor whether or not it declares one — and so does a class whose base
    // needs one, because something has to call it.
    const own = fields.slice(ownFieldsAt);
    // A parameter property is excluded: its value comes from the parameter, not
    // from an initialiser, and a `ParameterDeclaration`'s `initializer` is a
    // *default argument* — a different thing entirely, and one `#classFnParams`
    // refuses anyway.
    const initialisedFields = own.filter(
        (field) =>
            ts.isPropertyDeclaration(field.declaration) && field.declaration.initializer !== undefined,
    );
    const parameterProperties = own.filter((field) => ts.isParameter(field.declaration));
    const needsConstructor =
        ctor !== undefined || initialisedFields.length > 0 || (base?.needsConstructor ?? false);

    return {
        node,
        name,
        base: base ?? undefined,
        fields,
        ownFieldsAt,
        slots,
        methods,
        getters,
        setters,
        statics,
        staticGetters,
        staticSetters,
        parameterProperties,
        ctor,
        needsConstructor,
        initialisedFields,
        destructorSymbol,
        constructorSymbol: needsConstructor ? `${name}$new` : undefined,
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
    if (clause === undefined) {
        return undefined;
    }
    const [expression, ...rest] = clause.types;
    if (expression === undefined) {
        return undefined;
    }
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
    if (ts.isGetAccessor(member)) {
        return "a getter";
    }
    if (ts.isSetAccessor(member)) {
        return "a setter";
    }
    if (ts.isIndexSignatureDeclaration(member)) {
        return "an index signature";
    }
    if (ts.isClassStaticBlockDeclaration(member)) {
        return "a static block";
    }
    return "this class member";
}
