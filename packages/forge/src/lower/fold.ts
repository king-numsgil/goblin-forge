/**
 * Constant folding for a module-level `const`.
 *
 * GLOBALS-PLAN. The rule is C++'s: a global's value has to be resolvable at
 * compile time, because there is no code that runs before `main` for an
 * initialiser to run in. So this is not an optimisation — a program either folds
 * or is refused, and `GF0007` is the refusal.
 *
 * **The walk is over the type, not over the expression.** A struct's leaves come
 * out in the struct's field order and a fixed array's in index order, whatever
 * order the literal was written in, and the count is right by construction. The
 * backend consumes the leaves against the same type from the other side
 * (`crates/goblin-codegen/src/llvm/global.rs`), so the two agree because neither
 * one describes the shape — the type does.
 *
 * **Two answers, not one.** A fold produces leaves *and*, when the frontend
 * actually holds the number, a scalar value. `sizeOf<T>()` is the case that
 * separates them: it is a leaf the backend resolves, and there is no number here
 * for `A + 1` to add to. So a global initialised with one may be read whole and
 * may not be used in arithmetic, and that falls out of the shape rather than
 * being a rule anybody wrote.
 */

import type { Const, GlobalInit, TyId } from "@goblin-forge/backend";
import { type MachineType, rangeOf, renderType } from "@goblin-forge/checker";
import ts from "typescript";

/** A value the folder holds, as opposed to one only the backend can resolve. */
export type Folded =
    | { readonly kind: "int"; readonly bits: bigint; readonly type: MachineType }
    | { readonly kind: "float"; readonly value: number; readonly type: MachineType }
    | { readonly kind: "bool"; readonly value: boolean };

/** What a global's initialiser came to. */
export interface FoldedInit {
    readonly leaves: readonly GlobalInit[];
    /**
     * The value, when it is a scalar the frontend holds. Absent for an aggregate
     * and for anything the backend resolves, which is what stops
     * `sizeOf<T>() * 2` without a rule of its own.
     */
    readonly scalar?: Folded;
}

/** What the folder needs from the lowerer, without needing the lowerer. */
export interface FoldContext {
    /** The MIR type id for a machine type, for a `sizeOf` leaf. */
    tyOf(type: MachineType, at: ts.Node): TyId;

    /** `E.Member`, or `undefined` if this is not one. */
    enumMemberAt(expression: ts.PropertyAccessExpression): ts.EnumMember | undefined;

    /** A name that resolves to another module-level constant of this module. */
    globalAt(expression: ts.Identifier): FoldedInit | "not-a-global" | "forward" | "imported";

    /** Whether a name is one of the prelude's own, rather than the program's. */
    prelude(name: ts.Identifier): boolean;

    /** The lowerer's erasure, so a failure is reported the way it is elsewhere. */
    erase(at: ts.Node, type: ts.Type): MachineType | undefined;

    /**
     * Whether this expression's type is one of `std/linalg`'s.
     *
     * Asked rather than inferred from the shape, because `new X(1, 2, 3)` at a
     * three-field struct and `X.zero()` at any struct would both fold happily and
     * one of them would be somebody's own class with a `zero` static — folded to
     * zeroes without running it.
     */
    linalg(expression: ts.Expression): boolean;

    /**
     * The `Const::Func` for a name that means a declared function, if it does.
     *
     * A code address is decided by the linker rather than by the program, which is
     * exactly what a constant may hold: `fixedArrayOf(onKey, onMouse)` is C's
     * `void (*fns[])(…)`. Resolved through the lowerer because the `FuncId` is
     * its to hand out, which is also why constants are folded after the functions
     * are declared.
     */
    functionAddress(expression: ts.Expression, type: MachineType): Const | undefined;

    /** A `string` literal's text, interned into the module's string table. */
    stringConstant(text: string, at: ts.Node): Const;

    readonly checker: ts.TypeChecker;

    error(node: ts.Node, code: string, message: string): void;
}

/**
 * The struct fields a machine type has, in layout order, or `undefined`.
 *
 * Kept as a parameter rather than derived here because the lowerer already knows
 * how to ask: the folder never re-derives a type's shape.
 */
export type FieldsOf = (
    type: MachineType,
) => readonly { readonly name: string; readonly type: MachineType }[] | undefined;

export class ConstantFolder {
    readonly #context: FoldContext;
    readonly #fieldsOf: FieldsOf;

    constructor(context: FoldContext, fieldsOf: FieldsOf) {
        this.#context = context;
        this.#fieldsOf = fieldsOf;
    }

    /**
     * Fold `expression` as a value of `type`, or report why it cannot be.
     *
     * The type comes first in every decision, which is what makes the leaf count
     * agree with the backend's walk.
     */
    fold(expression: ts.Expression, type: MachineType): FoldedInit | undefined {
        const inner = unwrap(expression);

        // `zeroed<T>()` is one leaf whatever `T` is, which is the cheap spelling
        // for a table that starts empty — and the only spelling for one, since
        // `Zero` covers a whole subtree.
        if (this.#isZeroed(inner)) {
            return {leaves: [{kind: "Zero"}]};
        }

        switch (type.kind) {
            case "struct":
                return this.#structure(inner, type);
            case "fixedArray":
                return this.#fixedArray(inner, type);
            case "array":
                return this.#array(inner, type);
            case "string":
                return this.#string(inner);
            case "scalar":
            case "bool":
            case "pointer":
            case "fnptr":
                return this.#scalar(inner, type);
            default:
                // Reached only if the caller did not check the type first, which
                // `GF0008` is for.
                this.#refuse(
                    inner,
                    "GF0008",
                    `a module-level constant cannot be a \`${renderType(type)}\`.`,
                );
                return undefined;
        }
    }

    /** `{ x: 1, y: 2 }` — the fields in the *struct's* order, not the literal's. */
    #structure(expression: ts.Expression, type: MachineType): FoldedInit | undefined {
        const fields = this.#fieldsOf(type);
        if (fields === undefined) {
            this.#refuse(
                expression,
                "GF0008",
                `a module-level constant cannot be a \`${renderType(type)}\`.`,
            );
            return undefined;
        }
        // `new dvec3(0, 1, 0)` — a `std/linalg` value, component by component. The
        // type is a struct of scalars, so folding it is the field walk below with a
        // constructor's arguments in place of an object literal's properties.
        if (ts.isNewExpression(expression) && this.#context.linalg(expression)) {
            return this.#positional(
                expression,
                fields,
                expression.arguments ?? ts.factory.createNodeArray(),
                type,
            );
        }
        // `dvec3.zero()`, `dmat4.zero()` — every byte zero, which is one leaf. The
        // other factories are calls with values to work out (`identity`, `splat`,
        // `fromRotation`), and none of them folds yet.
        if (
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression) &&
            expression.expression.name.text === "zero" &&
            expression.arguments.length === 0 &&
            this.#context.linalg(expression)
        ) {
            return {leaves: [{kind: "Zero"}]};
        }
        if (!ts.isObjectLiteralExpression(expression)) {
            const linalg = this.#context.linalg(expression)
                ? ` A \`${renderType(type)}\` is written with one argument per component ` +
                  "— `new dvec3(0, 1, 0)` — or as `.zero()`."
                : "";
            this.#refuse(
                expression,
                "GF0007",
                `this is the value of a module-level \`${renderType(type)}\`, so it has ` +
                "to be written out as an object literal — that is what makes it " +
                `resolvable without running anything.${linalg}`,
            );
            return undefined;
        }

        const written = new Map<string, ts.Expression>();
        for (const property of expression.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
                this.#refuse(
                    property,
                    "GF0007",
                    "a module-level constant's fields are written as `name: value`; a " +
                    "shorthand, a spread or a computed name is not something this can " +
                    "resolve at compile time.",
                );
                return undefined;
            }
            written.set(property.name.text, property.initializer);
        }

        const leaves: GlobalInit[] = [];
        for (const field of fields) {
            const value = written.get(field.name);
            if (value === undefined) {
                // tsc has already refused a missing field, so this is a shape it
                // let through — an optional one, most likely.
                this.#refuse(
                    expression,
                    "GF0007",
                    `\`${field.name}\` has no value here, and a module-level constant ` +
                    "has no constructor to supply one.",
                );
                return undefined;
            }
            const folded = this.fold(value, field.type);
            if (folded === undefined) {
                return undefined;
            }
            leaves.push(...folded.leaves);
        }
        return {leaves};
    }

    /**
     * A `string` constant: the literal's text, interned.
     *
     * One word pointing at bytes the runtime lays out with `owned = 0`, so nothing
     * releases it and nothing has to be told not to. Concatenation does not fold —
     * `"a" + "b"` would have to intern a string this compiler made up, which is a
     * different thing from recording one the program wrote.
     */
    #string(expression: ts.Expression): FoldedInit | undefined {
        if (!ts.isStringLiteral(expression) && !ts.isNoSubstitutionTemplateLiteral(expression)) {
            this.#refuse(
                expression,
                "GF0007",
                "a module-level `string` has to be a literal. Nothing here can build one " +
                "at compile time: concatenation, `substring` and the rest all allocate, " +
                "and there is nowhere for that to happen before `main`.",
            );
            return undefined;
        }
        return {
            leaves: [
                {
                    kind: "Scalar",
                    value: this.#context.stringConstant(expression.text, expression),
                },
            ],
        };
    }

    /**
     * A `readonly T[]` constant: a count, then the elements.
     *
     * The count is a leaf because the *type* does not carry one — that is the whole
     * difference between a `T[]` and a `FixedArray<T, N>`, and it is why this is the
     * one position where the leaves say how many of them there are.
     */
    #array(
        expression: ts.Expression,
        type: Extract<MachineType, { kind: "array" }>,
    ): FoldedInit | undefined {
        if (!ts.isArrayLiteralExpression(expression)) {
            this.#refuse(
                expression,
                "GF0007",
                `this is the value of a module-level \`${renderType(type)}\`, so it has to ` +
                "be written out as an array literal.",
            );
            return undefined;
        }
        // An empty one is a `Zero`: zeroed bytes are a null handle, and the runtime
        // reads a null handle as an empty array. So it costs no object at all.
        if (expression.elements.length === 0) {
            return {leaves: [{kind: "Zero"}]};
        }

        const leaves: GlobalInit[] = [{kind: "Array", value: BigInt(expression.elements.length)}];
        for (const element of expression.elements) {
            if (ts.isSpreadElement(element)) {
                this.#refuse(element, "GF0007", "a spread does not fold.");
                return undefined;
            }
            const folded = this.fold(element, type.element);
            if (folded === undefined) {
                return undefined;
            }
            leaves.push(...folded.leaves);
        }
        return {leaves};
    }

    /** Values in order against fields in order: a constructor's arguments. */
    #positional(
        at: ts.Node,
        fields: readonly { readonly name: string; readonly type: MachineType }[],
        values: readonly ts.Expression[],
        type: MachineType,
    ): FoldedInit | undefined {
        if (values.length !== fields.length) {
            this.#refuse(
                at,
                "GF0007",
                `a \`${renderType(type)}\` has ${fields.length} components and ` +
                `${values.length} were written.`,
            );
            return undefined;
        }
        const leaves: GlobalInit[] = [];
        for (const [index, field] of fields.entries()) {
            const folded = this.fold(values[index]!, field.type);
            if (folded === undefined) {
                return undefined;
            }
            leaves.push(...folded.leaves);
        }
        return {leaves};
    }

    /** `fixedArray(n, fill)` and `fixedArrayOf(a, b, c)`, folded element-wise. */
    #fixedArray(
        expression: ts.Expression,
        type: Extract<MachineType, { kind: "fixedArray" }>,
    ): FoldedInit | undefined {
        if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
            this.#refuse(
                expression,
                "GF0007",
                `this is the value of a module-level \`${renderType(type)}\`, so it has ` +
                "to be `fixedArrayOf(…)`, `fixedArray(n, fill)` or `zeroed<…>()` — each " +
                "of which is resolvable without running anything.",
            );
            return undefined;
        }
        const callee = expression.expression;
        if (!this.#context.prelude(callee)) {
            this.#refuse(
                expression,
                "GF0007",
                `\`${callee.text}\` is a call, and a module-level constant's value ` +
                "cannot come from one: nothing runs before `main`.",
            );
            return undefined;
        }

        if (callee.text === "fixedArrayOf") {
            if (expression.arguments.length !== type.length) {
                // tsc has already matched the count, so reaching this means the
                // annotation and the argument list disagreed in a way it allowed.
                this.#refuse(
                    expression,
                    "GF0007",
                    `this holds ${type.length} elements and ${expression.arguments.length} ` +
                    "were written.",
                );
                return undefined;
            }
            const leaves: GlobalInit[] = [];
            for (const argument of expression.arguments) {
                const folded = this.fold(argument, type.element);
                if (folded === undefined) {
                    return undefined;
                }
                leaves.push(...folded.leaves);
            }
            return {leaves};
        }

        if (callee.text === "fixedArray") {
            const fill = expression.arguments[1];
            if (fill === undefined) {
                this.#refuse(expression, "GF0007", "`fixedArray` takes a length and a fill.");
                return undefined;
            }
            const folded = this.fold(fill, type.element);
            if (folded === undefined) {
                return undefined;
            }
            // A zero fill is one leaf however long the array is, which is what
            // keeps a 4096-element table cheap on the wire. Anything else is
            // repeated, because there is no leaf that means "and again".
            if (folded.leaves.length === 1 && isZeroLeaf(folded.leaves[0]!)) {
                return {leaves: [{kind: "Zero"}]};
            }
            const leaves: GlobalInit[] = [];
            for (let index = 0; index < type.length; index += 1) {
                leaves.push(...folded.leaves);
            }
            return {leaves};
        }

        this.#refuse(
            expression,
            "GF0007",
            `\`${callee.text}\` is not something this can resolve at compile time.`,
        );
        return undefined;
    }

    /** One scalar position: a number, a bool, an enum member, `sizeOf`, or null. */
    #scalar(expression: ts.Expression, type: MachineType): FoldedInit | undefined {
        if (type.kind === "pointer" || type.kind === "fnptr") {
            if (expression.kind === ts.SyntaxKind.NullKeyword) {
                return {
                    leaves: [
                        {kind: "Scalar", value: {kind: "Null", value: this.#ty(type, expression)}},
                    ],
                };
            }
            // A *function's* address is decided by the linker, not by the program,
            // so it is exactly the kind of thing a constant can hold. Every other
            // address is worked out while the program runs.
            const address = this.#context.functionAddress(expression, type);
            if (address !== undefined) {
                return {leaves: [{kind: "Scalar", value: address}]};
            }
            this.#refuse(
                expression,
                "GF0007",
                type.kind === "fnptr"
                    ? `a module-level \`${renderType(type)}\` has to name a function or be ` +
                      "`null`: a closure captures, and there is no frame here to capture from."
                    : `a module-level \`${renderType(type)}\` can only be \`null\`: every ` +
                      "other address is worked out while the program runs.",
            );
            return undefined;
        }

        // `sizeOf<T>()` and `alignOf<T>()`: leaves the *backend* resolves, because
        // the frontend has no layout. Which is also why neither may appear inside
        // arithmetic — see `#arithmetic`.
        const layout = this.#layoutQuery(expression);
        if (layout !== undefined) {
            return layout === "reported" ? undefined : {leaves: [layout]};
        }

        const value = this.#value(expression, type);
        if (value === undefined) {
            return undefined;
        }
        const leaf = this.#leafOf(value, type, expression);
        return leaf === undefined ? undefined : {leaves: [leaf], scalar: value};
    }

    /** A scalar the frontend can evaluate, or `undefined` with a diagnostic. */
    #value(expression: ts.Expression, type: MachineType): Folded | undefined {
        const inner = unwrap(expression);

        if (inner.kind === ts.SyntaxKind.TrueKeyword) {
            return {kind: "bool", value: true};
        }
        if (inner.kind === ts.SyntaxKind.FalseKeyword) {
            return {kind: "bool", value: false};
        }
        if (ts.isNumericLiteral(inner)) {
            return this.#number(inner.text, type, inner);
        }
        if (ts.isPrefixUnaryExpression(inner)) {
            return this.#unary(inner, type);
        }
        if (ts.isBinaryExpression(inner)) {
            return this.#arithmetic(inner, type);
        }
        // `E.High` — a constant, folded here exactly as it is folded at a use site.
        if (ts.isPropertyAccessExpression(inner)) {
            const member = this.#context.enumMemberAt(inner);
            if (member !== undefined) {
                const constant = this.#context.checker.getConstantValue(member);
                if (typeof constant === "number") {
                    return {kind: "int", bits: BigInt(constant), type};
                }
            }
        }
        if (ts.isIdentifier(inner)) {
            return this.#name(inner, type);
        }
        // A `sizeOf` is a perfectly good *whole* initialiser and is handled in
        // `#scalar`; reaching it here means it is inside something else, and the
        // reason it cannot be is worth saying rather than leaving to the general
        // refusal below.
        if (this.#isLayoutQuery(inner)) {
            this.#refuse(
                inner,
                "GF0007",
                "a layout is resolved by the backend, which is the only half of this " +
                "compiler that lays types out — so there is no number here for the rest " +
                "of the expression to be worked out with. `sizeOf<T>()` on its own is " +
                "the whole value of a constant, or it is nothing.",
            );
            return undefined;
        }

        this.#refuse(
            inner,
            "GF0007",
            "a module-level constant's value has to be known at compile time, and this " +
            "is not: there is no code that runs before `main` for it to be worked out " +
            "in. Literals, enum members, arithmetic over them, `sizeOf`/`alignOf`, and " +
            "other module-level constants of this module are what fold.",
        );
        return undefined;
    }

    /**
     * Another module-level constant, read by name.
     *
     * The value rather than the address: this is a compile-time dependency and
     * nothing about it survives to run time, so declaration order does not matter
     * and there is no initialisation sequence to get wrong.
     */
    #name(expression: ts.Identifier, type: MachineType): Folded | undefined {
        const global = this.#context.globalAt(expression);
        if (global === "not-a-global") {
            this.#refuse(
                expression,
                "GF0007",
                `\`${expression.text}\` is not a module-level constant of this module, so ` +
                "its value is not something this can know at compile time.",
            );
            return undefined;
        }
        if (global === "imported") {
            this.#refuse(
                expression,
                "GF0007",
                `\`${expression.text}\` is imported, so what this module has is a symbol ` +
                "the linker resolves rather than a value — and folding needs the value. " +
                "Write the number here, or move the constant that needs it into the " +
                "module that defines this one.",
            );
            return undefined;
        }
        if (global === "forward") {
            // Declaration order does not matter for a function and must not here,
            // so this is the cycle check's business rather than an ordering rule.
            return undefined;
        }
        if (global.scalar === undefined) {
            this.#refuse(
                expression,
                "GF0007",
                `\`${expression.text}\` is not a number this compiler holds — it is an ` +
                "aggregate, or a `sizeOf` the backend resolves — so it can be copied " +
                "whole and not used in arithmetic.",
            );
            return undefined;
        }
        return retype(global.scalar, type);
    }

    #unary(
        expression: ts.PrefixUnaryExpression,
        type: MachineType,
    ): Folded | undefined {
        if (expression.operator === ts.SyntaxKind.PlusToken) {
            return this.#value(expression.operand, type);
        }
        if (expression.operator === ts.SyntaxKind.ExclamationToken) {
            const inner = this.#value(expression.operand, type);
            if (inner === undefined) {
                return undefined;
            }
            if (inner.kind !== "bool") {
                this.#refuse(expression, "GF0007", "`!` needs a `boolean`.");
                return undefined;
            }
            return {kind: "bool", value: !inner.value};
        }
        if (expression.operator === ts.SyntaxKind.TildeToken) {
            const inner = this.#value(expression.operand, type);
            if (inner === undefined || inner.kind !== "int") {
                this.#refuse(expression, "GF0007", "`~` needs an integer.");
                return undefined;
            }
            return {kind: "int", bits: ~inner.bits, type};
        }
        if (expression.operator !== ts.SyntaxKind.MinusToken) {
            this.#refuse(expression, "GF0007", "this operator does not fold.");
            return undefined;
        }
        // Unsigned first, before the fold, for `GF0165`'s reason: fold first and
        // `-1` becomes `255`, which is in range for a `u8` and walks past the
        // range check.
        if (type.kind === "scalar" && rangeOf(type.name)?.min === 0n) {
            this.#refuse(
                expression,
                "GF0007",
                `unary minus has no meaning on \`${type.name}\`, which is unsigned.`,
            );
            return undefined;
        }
        const inner = this.#value(expression.operand, type);
        if (inner === undefined) {
            return undefined;
        }
        if (inner.kind === "int") {
            return {kind: "int", bits: -inner.bits, type};
        }
        if (inner.kind === "float") {
            return {kind: "float", value: -inner.value, type};
        }
        this.#refuse(expression, "GF0007", "unary minus needs a number.");
        return undefined;
    }

    /** `2 * 3`, `1 << 12` — over values this compiler holds, and nothing else. */
    #arithmetic(expression: ts.BinaryExpression, type: MachineType): Folded | undefined {
        const left = this.#value(expression.left, type);
        const right = this.#value(expression.right, type);
        if (left === undefined || right === undefined) {
            return undefined;
        }
        const operator = expression.operatorToken.kind;

        if (left.kind === "int" && right.kind === "int") {
            const folded = integerOp(operator, left.bits, right.bits);
            if (folded === "divide-by-zero") {
                this.#refuse(
                    expression,
                    "GF0007",
                    "this divides by zero, which has no value to fold to.",
                );
                return undefined;
            }
            if (folded === undefined) {
                this.#refuse(
                    expression,
                    "GF0007",
                    `\`${ts.tokenToString(operator)}\` does not fold over integers here.`,
                );
                return undefined;
            }
            return {kind: "int", bits: folded, type};
        }

        const a = asNumber(left);
        const b = asNumber(right);
        if (a !== undefined && b !== undefined) {
            const folded = floatOp(operator, a, b);
            if (folded === undefined) {
                this.#refuse(
                    expression,
                    "GF0007",
                    `\`${ts.tokenToString(operator)}\` does not fold over floats.`,
                );
                return undefined;
            }
            return {kind: "float", value: folded, type};
        }

        this.#refuse(
            expression,
            "GF0007",
            "these are not two numbers this compiler holds, so there is nothing to " +
            "work out here at compile time.",
        );
        return undefined;
    }

    /** `sizeOf<T>()` / `alignOf<T>()`, as the leaf the backend resolves. */
    #layoutQuery(expression: ts.Expression): GlobalInit | "reported" | undefined {
        if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
            return undefined;
        }
        const name = expression.expression.text;
        if (name !== "sizeOf" && name !== "alignOf") {
            return undefined;
        }
        if (!this.#context.prelude(expression.expression)) {
            return undefined;
        }
        const argument = expression.typeArguments?.[0];
        if (argument === undefined) {
            this.#refuse(
                expression,
                "GF0007",
                `\`${name}\` needs the type written out: \`${name}<i32>()\`.`,
            );
            return "reported";
        }
        const type = this.#context.checker.getTypeAtLocation(argument);
        const erased = this.#erase(argument, type);
        if (erased === undefined) {
            return "reported";
        }
        const ty = this.#ty(erased, argument);
        return name === "sizeOf" ? {kind: "SizeOf", value: ty} : {kind: "AlignOf", value: ty};
    }

    #erase(at: ts.Node, type: ts.Type): MachineType | undefined {
        return this.#context.erase(at, type);
    }

    #leafOf(value: Folded, type: MachineType, at: ts.Node): GlobalInit | undefined {
        const ty = this.#ty(type, at);
        if (value.kind === "bool") {
            return {kind: "Scalar", value: {kind: "Bool", value: value.value, ty}};
        }
        if (value.kind === "int") {
            if (type.kind === "scalar" && isFloatName(type.name)) {
                return {
                    kind: "Scalar",
                    value: {kind: "Float", bits: floatBits(Number(value.bits), type.name), ty},
                };
            }
            const range = type.kind === "scalar" ? rangeOf(type.name) : undefined;
            if (range != null && (value.bits < range.min || value.bits > range.max)) {
                this.#refuse(
                    at,
                    "GF0007",
                    `${value.bits} does not fit in a \`${renderType(type)}\`.`,
                );
                return undefined;
            }
            return {kind: "Scalar", value: {kind: "Int", bits: mask(value.bits), ty}};
        }
        if (type.kind !== "scalar" || !isFloatName(type.name)) {
            this.#refuse(
                at,
                "GF0007",
                `${value.value} is fractional and a \`${renderType(type)}\` cannot hold it.`,
            );
            return undefined;
        }
        return {
            kind: "Scalar",
            value: {kind: "Float", bits: floatBits(value.value, type.name), ty},
        };
    }

    /**
     * A numeric literal, at the width it is going to be held at.
     *
     * **An integer literal folds as a float when the type is one**, and that is
     * not a nicety: `3 / 2` at `f64` is `1.5` when the program computes it, because
     * the width pass gives both literals `f64` from the context. Folding them as
     * integers would make the same expression `1` — a constant that disagrees with
     * the identical expression written inside a function, which is the worst
     * possible way for a folder to be wrong.
     */
    #number(text: string, type: MachineType, at: ts.Node): Folded | undefined {
        const cleaned = text.replaceAll("_", "");
        const float = type.kind === "scalar" && isFloatName(type.name);
        if (!float && (/^0[xXoObB]/.test(cleaned) || !/[.eE]/.test(cleaned))) {
            try {
                return {kind: "int", bits: BigInt(cleaned), type};
            } catch {
                this.#refuse(at, "GF0007", `\`${text}\` is not a number this can read.`);
                return undefined;
            }
        }
        return {kind: "float", value: Number(cleaned), type};
    }

    #isLayoutQuery(expression: ts.Expression): boolean {
        return (
            ts.isCallExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            (expression.expression.text === "sizeOf" ||
                expression.expression.text === "alignOf") &&
            this.#context.prelude(expression.expression)
        );
    }

    #isZeroed(expression: ts.Expression): boolean {
        return (
            ts.isCallExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            expression.expression.text === "zeroed" &&
            this.#context.prelude(expression.expression)
        );
    }

    #ty(type: MachineType, at: ts.Node): TyId {
        return this.#context.tyOf(type, at);
    }

    #refuse(node: ts.Node, code: string, message: string): void {
        this.#context.error(node, code, message);
    }
}

/** Parentheses and `as` are not values; they are punctuation. */
function unwrap(expression: ts.Expression): ts.Expression {
    let inner = expression;
    while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner)) {
        inner = inner.expression;
    }
    return inner;
}

function isZeroLeaf(leaf: GlobalInit): boolean {
    if (leaf.kind === "Zero") {
        return true;
    }
    if (leaf.kind !== "Scalar") {
        return false;
    }
    const value = leaf.value;
    return (
        (value.kind === "Int" && value.bits === 0n) ||
        (value.kind === "Float" && value.bits === 0n) ||
        (value.kind === "Bool" && !value.value)
    );
}

function isFloatName(name: string): boolean {
    return name === "f32" || name === "f64";
}

/** Little-endian IEEE bits, which is what the MIR carries so NaNs survive. */
function floatBits(value: number, name: string): bigint {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    if (name === "f32") {
        view.setFloat32(0, value, true);
        return BigInt(view.getUint32(0, true));
    }
    view.setFloat64(0, value, true);
    return view.getBigUint64(0, true);
}

/** A negative literal as the 64-bit pattern the MIR carries. */
function mask(bits: bigint): bigint {
    return bits < 0n ? (1n << 64n) + bits : bits;
}

function asNumber(value: Folded): number | undefined {
    if (value.kind === "int") {
        return Number(value.bits);
    }
    if (value.kind === "float") {
        return value.value;
    }
    return undefined;
}

function retype(value: Folded, type: MachineType): Folded {
    if (value.kind === "bool") {
        return value;
    }
    return {...value, type};
}

function integerOp(
    operator: ts.SyntaxKind,
    left: bigint,
    right: bigint,
): bigint | undefined | "divide-by-zero" {
    switch (operator) {
        case ts.SyntaxKind.PlusToken:
            return left + right;
        case ts.SyntaxKind.MinusToken:
            return left - right;
        case ts.SyntaxKind.AsteriskToken:
            return left * right;
        case ts.SyntaxKind.SlashToken:
            // Truncating, which is what the machine does for integers.
            return right === 0n ? "divide-by-zero" : left / right;
        case ts.SyntaxKind.PercentToken:
            return right === 0n ? "divide-by-zero" : left % right;
        case ts.SyntaxKind.AmpersandToken:
            return left & right;
        case ts.SyntaxKind.BarToken:
            return left | right;
        case ts.SyntaxKind.CaretToken:
            return left ^ right;
        case ts.SyntaxKind.LessThanLessThanToken:
            return left << right;
        case ts.SyntaxKind.GreaterThanGreaterThanToken:
            return left >> right;
        default:
            return undefined;
    }
}

function floatOp(operator: ts.SyntaxKind, left: number, right: number): number | undefined {
    switch (operator) {
        case ts.SyntaxKind.PlusToken:
            return left + right;
        case ts.SyntaxKind.MinusToken:
            return left - right;
        case ts.SyntaxKind.AsteriskToken:
            return left * right;
        case ts.SyntaxKind.SlashToken:
            return left / right;
        default:
            return undefined;
    }
}
