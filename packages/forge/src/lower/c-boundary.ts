/**
 * Where a value crosses to C, and back.
 *
 * `cstring` and the string conversions, `reify<U>()`, and `cast`. Grouped
 * because they share one hazard: on the far side of any of them the value model
 * stops applying, so each is the last point at which this compiler can say no —
 * and `POINTER-ERASURE.md` is the record of getting that wrong the obvious way.
 */

import type { Operand, Rvalue } from "@goblin-forge/backend";
import {
    contractOf,
    ErasureError,
    isIntegerType,
    type MachineType,
    referentOf,
    renderType,
    sameType,
} from "@goblin-forge/checker";
import ts from "typescript";
import { RUNTIME, STRING_FROM_BYTES, STRING_FROM_CSTRING } from "./tables.ts";
import { CSTRING_TYPE, STRING, type Typed, typed, USIZE, VOID } from "./types.ts";
import { fractionalLiteralIn, placeOf } from "./util.ts";
import { LinalgLowerer } from "./linalg.ts";

export abstract class BoundaryLowerer extends LinalgLowerer {
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
    protected cstring(expression: ts.CallExpression): Typed | undefined {
        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(expression, "GF0002", "`cstring` takes exactly one `string`.");
            return undefined;
        }

        const value = this.value(argument, STRING);
        if (value === undefined) {
            return undefined;
        }
        if (value.type.kind !== "string") {
            this.outer.error(
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
            this.outer.error(
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
        const operand: Operand = moving ? value.operand : this.forRead(value);
        return this.temporaryTyped(expression, CSTRING_TYPE, {
            kind: "Cast",
            op: "PtrToPtr",
            operand,
            to: this.outer.tyOf(CSTRING_TYPE, expression),
        });
    }

    /**
     * `cstringFree(c)` — release a `CString` through Goblin's own deallocator.
     *
     * An intrinsic rather than a method on `CString`, and that is the design
     * rather than a shortcut. A `.free()` would have to pick one deallocator, and
     * there is no right one to pick: an SDL string needs `SDL_free`, a `strdup`
     * needs `free`, and only a moved Goblin string needs this one. Releasing a
     * `CString` is always "call the free that came with it" — the rule C has
     * always had, and a named function per allocator is how C says it.
     */
    protected cstringFree(expression: ts.CallExpression): Typed | undefined {
        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(expression, "GF0002", "`cstringFree` takes exactly one `CString`.");
            return undefined;
        }
        const value = this.expressionTyped(argument, CSTRING_TYPE);
        if (value === undefined) {
            return undefined;
        }
        if (value.type.kind !== "cstring") {
            this.outer.error(
                argument,
                "GF0002",
                `\`cstringFree\` releases a \`CString\`, and this is a ` +
                `\`${renderType(value.type)}\`. A \`string\` releases itself.`,
            );
            return undefined;
        }
        return this.callRuntime(expression, RUNTIME.stringFree, [value], VOID);
    }

    /**
     * `stringFromCString(p)` — copy NUL-terminated bytes into a managed `string`.
     *
     * The direction that has to allocate, and the asymmetry is the point:
     * {@link #cstring} hands the same pointer back because a Goblin `string` is
     * already a valid `const char *`, while going the other way needs a length
     * header that a `CString` has nowhere to have kept.
     *
     * The result is an ordinary owned temporary, so binding it makes the binding's
     * scope responsible and dropping it on the floor releases it at the end of the
     * statement. Nothing is done to the pointer; whoever allocated it still owns
     * it, which is exactly the C rule and exactly why this copies.
     */
    protected stringFromCString(expression: ts.CallExpression): Typed | undefined {
        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(
                expression,
                "GF0002",
                "`stringFromCString` takes exactly one `CString` or `Pointer<u8>`.",
            );
            return undefined;
        }
        const value = this.#bytesArgument(argument, STRING_FROM_CSTRING);
        if (value === undefined) {
            return undefined;
        }
        return this.callRuntime(expression, RUNTIME.fromCString, [value], STRING);
    }

    /**
     * The pointer argument of a "read these bytes" intrinsic.
     *
     * A `CString`, a `Pointer<u8>`, or a fixed array — which decays here exactly
     * as it would at any other pointer parameter. The decay has to be asked for
     * rather than inherited, because an intrinsic's argument never meets the
     * declared parameter type that {@link #coerce} would have converted against:
     * these are lowered at their natural type and inspected.
     */
    #bytesArgument(argument: ts.Expression, what: string): Typed | undefined {
        const value = this.value(argument, CSTRING_TYPE);
        if (value === undefined) {
            return undefined;
        }
        if (value.type.kind === "fixedArray") {
            return this.coerce(argument, value, {
                kind: "pointer",
                pointee: value.type.element,
            });
        }
        // A `Pointer<u8>` as well as a `CString`, because that is what the
        // declaration says and because `argv`'s entries arrive as one.
        if (value.type.kind !== "cstring" && value.type.kind !== "pointer") {
            this.outer.error(
                argument,
                "GF0002",
                `\`${what}\` reads a \`CString\`, a \`Pointer<u8>\` or a fixed array of ` +
                `bytes, and this is a \`${renderType(value.type)}\`.`,
            );
            return undefined;
        }
        return value;
    }

    /**
     * `stringFromBytes(p, n)` — copy `n` bytes into a managed `string`.
     *
     * {@link #stringFromCString} without the scan, and the one to reach for at a
     * C boundary, because the length usually arrived in the same call as the
     * pointer — `SDL_LoadFile_IO(io, size, …)` hands over both. Scanning there is
     * a second pass over bytes already measured, and it is *wrong* rather than
     * merely wasteful for data that contains a zero: the string would stop at it.
     *
     * The copy is the same copy, so the result is an owned temporary and the
     * bytes stay whoever's they were.
     */
    protected stringFromBytes(expression: ts.CallExpression): Typed | undefined {
        const [pointer, length] = expression.arguments;
        if (expression.arguments.length !== 2 || pointer === undefined || length === undefined) {
            this.outer.error(
                expression,
                "GF0002",
                "`stringFromBytes` takes a `Pointer<u8>` and a length.",
            );
            return undefined;
        }
        const value = this.#bytesArgument(pointer, STRING_FROM_BYTES);
        if (value === undefined) {
            return undefined;
        }
        const count = this.expressionTyped(length, USIZE);
        if (count === undefined) {
            return undefined;
        }
        return this.callRuntime(expression, RUNTIME.fromBytes, [value, count], STRING);
    }

    /** The contract `tryCast<T>(…)` was asked for, or `undefined`. */
    protected override tryCastTarget(expression: ts.CallExpression): MachineType | undefined {
        const argument = expression.typeArguments?.[0];
        if (expression.typeArguments?.length !== 1 || argument === undefined) {
            this.outer.error(
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
        const type = this.outer.checker.getTypeFromTypeNode(argument);
        let target: MachineType | undefined;
        try {
            target = contractOf(this.outer.checker, type) ?? undefined;
        } catch (error) {
            if (error instanceof ErasureError) {
                this.outer.error(argument, error.code, error.message);
                return undefined;
            }
            throw error;
        }
        target ??= this.outer.erase(argument, type);
        if (target === undefined) {
            return undefined;
        }
        // A contract, or a class. Same question, two mechanisms: search the
        // dynamic type's itab table, or walk its descriptor's base chain.
        if (target.kind === "interface") {
            return target;
        }
        if (target.kind === "class") {
            return {kind: "reference", referent: target};
        }
        this.outer.error(
            argument,
            "GF0002",
            `\`tryCast\` asks whether a value is really some class or contract. ` +
            `\`${renderType(target)}\` is neither, and for the twelve widths the ` +
            "answer is decided at compile time — `cast` is the conversion " +
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
    protected tryCast(expression: ts.CallExpression): Typed | undefined {
        const contract = this.tryCastTarget(expression);
        if (contract === undefined) {
            return undefined;
        }

        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(expression, "GF0002", "`tryCast` takes exactly one value.");
            return undefined;
        }

        const value = this.value(argument, undefined);
        if (value === undefined) {
            return undefined;
        }
        const asClass = this.asClass(value);
        if (asClass === undefined) {
            this.outer.unsupported(
                argument,
                "`tryCast` of anything but a class value or a reference to one",
            );
            return undefined;
        }

        // Interning the type is what declares the interface, so asking for the
        // type is what makes the id exist.
        const ty = this.outer.tyOf(contract, expression);

        let rvalue: Rvalue;
        if (contract.kind === "interface") {
            const resolved = this.outer.interfaceId(contract.name);
            if (resolved === undefined) {
                return undefined;
            }
            rvalue = {kind: "TryInterface", interface: resolved, source: asClass.place};
        } else if (contract.kind === "reference" && contract.referent.kind === "class") {
            const resolved = this.outer.classId(contract.referent.name);
            if (resolved === undefined) {
                return undefined;
            }
            rvalue = {kind: "TryClass", class: resolved, source: asClass.place};
        } else {
            return undefined;
        }

        const local = this.f.addLocal({
            ty,
            storage: "Temporary",
            span: this.outer.span(expression),
        });
        this.push({kind: "StorageLive", value: local});
        this.push({kind: "Init", place: placeOf(local), rvalue});
        return {operand: {kind: "Copy", value: placeOf(local)}, type: contract};
    }

    /**
     * The contract an expression already holds, or `undefined`.
     *
     * Reports nothing, for the same reason `classNameAt` reports nothing: this
     * decides *whether* a call is interface dispatch, before anything commits to
     * lowering it that way.
     */
    protected override contractAt(
        expression: ts.Expression,
    ): Extract<MachineType, { kind: "interface" }> | undefined {
        const width = this.widths.get(expression);
        if (width?.kind === "typed" && width.type.kind === "interface") {
            return width.type;
        }

        // Stripped of `| null` first. Before the check that consumes it, a
        // `tryCast` result is a union, and a union's property list is only what its
        // members have in common — which for `Reference<Pet> | null` is nothing, so
        // the brand would be invisible.
        const type = this.outer.checker.getNonNullableType(
            this.outer.checker.getTypeAtLocation(expression),
        );
        const referent = referentOf(this.outer.checker, type);
        if (referent === null) {
            return undefined;
        }
        try {
            const contract = contractOf(this.outer.checker, referent);
            return contract?.kind === "interface" ? contract : undefined;
        } catch {
            // A malformed contract. Whatever is wrong with it is reported by the
            // ordinary erasure path, which has a node to attach it to.
            return undefined;
        }
    }

    /**
     * `cast<T>(value)` — the written form of a conversion.
     *
     * This is the only way to narrow, and the only way to perform a conversion
     * that could lose a value. Everything it does is something the language
     * refuses to do on its own, which is why it has to be written.
     */
    protected cast(expression: ts.CallExpression, target: MachineType): Typed | undefined {
        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(
                expression,
                "GF0163",
                "`cast` takes exactly one value to convert.",
            );
            return undefined;
        }

        const width = this.width(argument);
        if (width.kind === "error") {
            return undefined;
        }
        // Converting a literal is a no-op the language would have done anyway, so
        // the literal is simply range-checked at the target width.
        //
        // Unless it is a *fractional* literal being converted to an integer width,
        // which is the one case where there is a real conversion to do:
        // `cast<i32>(1.5)` is C++'s `static_cast<int>(1.5)` and means one.
        // Range-checking `1.5` at `i32` would reject it (`GF0164`) for being
        // written as a float — which is the right answer where the cast is absent
        // and the wrong one here, because the cast is how truncation is asked for.
        if (width.kind === "poly") {
            if (isIntegerType(target) && fractionalLiteralIn(argument)) {
                const asFloat: MachineType = {kind: "scalar", name: "f64"};
                const value = this.value(argument, asFloat);
                if (value === undefined) {
                    return undefined;
                }
                return this.temporaryTyped(expression, target, {
                    kind: "Cast",
                    op: "FloatToInt",
                    operand: value.operand,
                    to: this.outer.tyOf(target, expression),
                });
            }
            const value = this.value(argument, target);
            return value === undefined ? undefined : {operand: value.operand, type: target};
        }

        const value = this.value(argument, width.type);
        if (value === undefined) {
            return undefined;
        }
        if (sameType(value.type, target)) {
            return {operand: value.operand, type: target};
        }

        const kind = this.castKind(expression, value.type, target);
        if (kind === undefined) {
            return undefined;
        }
        return this.temporaryTyped(expression, target, {
            kind: "Cast",
            op: kind,
            operand: value.operand,
            to: this.outer.tyOf(target, expression),
        });
    }
}
