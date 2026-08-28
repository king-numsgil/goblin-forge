/**
 * The block cursor, and the primitives everything above it builds with.
 *
 * Almost half of all cross-layer calls in lowering land here — `push`, `seal`,
 * a temporary, and the four rules for turning a lowered value into an operand.
 * They are gathered rather than scattered because they are the *only* things
 * that touch the builder directly; a layer above that wants to emit an
 * instruction goes through one of these, so there is one place where the
 * current block can be left unset and one place that knows what to do about it.
 *
 * REWRITE-PLAN §4.4 is why the temporary list is here too: a temporary dies at
 * the end of the full-expression that created it, in reverse order, and that is
 * a property of emission rather than of any one expression form.
 */

import {
    type BlockId,
    type CastKind,
    type FuncId,
    type FunctionBuilder,
    LocalId,
    type Operand,
    type Place,
    type Rvalue,
    type Terminator,
    type TyId,
} from "@goblin-forge/backend";
import type { MachineType, Substitution } from "@goblin-forge/checker";
import ts from "typescript";
import type { ClassInfo } from "../classes.ts";
import { NO_UNWIND } from "./tables.ts";
import { type Typed, USIZE, VOID } from "./types.ts";
import { Scopes } from "./scopes.ts";
import { placeOf } from "./util.ts";
import type { Lowerer } from "./module.ts";

export abstract class Emitter {
    protected readonly outer: Lowerer;
    protected readonly f: FunctionBuilder;
    protected readonly scopes: Scopes;

    /**
     * Temporaries created by the full-expression currently being lowered, in
     * order of creation. REWRITE-PLAN §4.4 adopts C++'s rule verbatim: a
     * temporary dies at the end of the full-expression that made it, in reverse
     * order of creation.
     */
    protected readonly temporaries: LocalId[] = [];
    protected current: BlockId | undefined;

    /** The class whose member is being lowered, when one is. */
    protected self: ClassInfo | undefined;
    protected inConstructor = false;

    /**
     * What this body's type parameters are bound to, when it is one
     * instantiation of a generic. Empty for every ordinary function.
     *
     * Set once, at construction, and never changed: a body is lowered once per
     * instantiation, with a `BodyLowerer` of its own, so there is no point at
     * which the answer could differ part-way through. That is the whole reason
     * this is a field rather than something pushed and popped on the
     * {@link Lowerer} — `liftClosure` runs while the enclosing body is
     * mid-lowering, so a stack would have a re-entrant case on the first day.
     */
    protected readonly bindings: Substitution;

    constructor(outer: Lowerer, f: FunctionBuilder, scopes: Scopes, bindings: Substitution) {
        this.outer = outer;
        this.f = f;
        this.scopes = scopes;
        this.bindings = bindings;
    }

    /**
     * Erase a type under this body's substitution.
     *
     * Every erasure in the body chain goes through here rather than through
     * `this.outer.erase`, so that the substitution cannot be left off at one
     * site out of thirty. Inside a generic that would not fail loudly — it
     * would erase `T` as "nothing says what it is", at whichever expression the
     * missed site happened to cover.
     */
    protected erase(at: ts.Node, type: ts.Type): MachineType | undefined {
        return this.outer.erase(at, type, this.bindings);
    }

    /** {@link Lowerer.tryErase}, under this body's substitution. */
    protected tryErase(expression: ts.Expression): MachineType | undefined {
        return this.outer.tryErase(expression, this.bindings);
    }

    setClassContext(info: ClassInfo, inConstructor: boolean): void {
        this.self = info;
        this.inConstructor = inConstructor;
    }

    /**
     * What the layers below require from the whole.
     *
     * These are the calls that run *upwards* — a width query reaching for the
     * value it would lower to, an intrinsic reaching for the coercion rules.
     * Declaring them here is what makes the layering checkable: a file below
     * this line may only call what this list names, and adding to the list is a
     * deliberate act rather than a reflex.
     */
    protected abstract value(expression: ts.Expression, expected: MachineType | undefined): Typed | undefined;

    protected abstract expressionTyped(expression: ts.Expression, expected: MachineType): Typed | undefined;

    protected abstract coerce(at: ts.Node, value: Typed, expected: MachineType): Typed | undefined;

    protected abstract castKind(at: ts.Node, from: MachineType, to: MachineType): CastKind | undefined;

    protected abstract asClass(subject: Typed): { info: ClassInfo; place: Place } | undefined;

    protected abstract classCallArgs(
        at: ts.Node,
        info: ClassInfo,
        symbol: string | undefined,
        args: readonly ts.Expression[],
        receiver: Operand,
    ): Operand[] | undefined | null;

    protected abstract emitCall(
        at: ts.Node,
        callee: Extract<Terminator, { kind: "Call" }>["callee"],
        args: Operand[],
        returns: MachineType,
    ): Typed | undefined;

    protected abstract needsCallerCopy(type: MachineType): boolean;

    protected abstract nullTestOf(
        expression: ts.BinaryExpression,
    ): { subject: ts.Expression; equals: boolean } | undefined;

    protected abstract placeOfSubject(at: ts.Node, subject: Typed): Place | undefined;

    protected abstract contractAt(
        expression: ts.Expression,
    ): Extract<MachineType, { kind: "interface" }> | undefined;

    protected abstract tryCastTarget(expression: ts.CallExpression): MachineType | undefined;

    protected push(statement: Parameters<FunctionBuilder["push"]>[1]): void {
        if (this.current === undefined) {
            return;
        }
        this.f.push(this.current, statement);
    }

    protected seal(terminator: Terminator): void {
        if (this.current === undefined) {
            return;
        }
        this.f.seal(this.current, terminator);
        this.current = undefined;
    }

    protected temporary(node: ts.Node, type: MachineType, rvalue: Rvalue): Operand {
        return this.temporaryTyped(node, type, rvalue).operand;
    }

    /** Put a computed value into a temporary and hand back a reference to it. */
    protected temporaryTyped(node: ts.Node, type: MachineType, rvalue: Rvalue): Typed {
        const local = this.f.addLocal({
            ty: this.outer.tyOf(type, node),
            // Unnamed, produced by an expression, destroyed at the end of the
            // enclosing full-expression rather than at scope exit — which is why it
            // is tracked here and not in a scope (REWRITE-PLAN §4.2, §4.4).
            storage: "Temporary",
        });
        this.temporaries.push(local);
        this.push({kind: "StorageLive", value: local});
        this.push({kind: "Init", place: placeOf(local), rvalue});
        // `Borrow` rather than `Copy`: the temporary *is* the value, and cloning it
        // at the point of use would allocate a second time and leak the first.
        // Whoever consumes it decides whether to move out of it instead.
        return {
            operand: {
                kind: this.needsCallerCopy(type) ? "Borrow" : "Copy",
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
    protected forStorage(value: Typed): Operand {
        if (value.temporary !== undefined && this.needsCallerCopy(value.type)) {
            return {kind: "Move", value: placeOf(value.temporary)};
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
    protected forRead(value: Typed): Operand {
        if (!this.needsCallerCopy(value.type)) {
            return value.operand;
        }
        if (value.operand.kind === "Const") {
            return value.operand;
        }
        return {kind: "Borrow", value: value.operand.value};
    }

    /**
     * The operand form of a value that will be read **more than once**.
     *
     * Always a `Copy` of a place, so each use applies the type's copy operation
     * and gets its own value. The usual move-out-of-a-temporary optimisation is
     * exactly wrong here: it is correct precisely because a temporary is used
     * once, and this is the case where it is not.
     */
    protected repeatable(value: Typed): Operand {
        if (value.temporary !== undefined) {
            return {kind: "Copy", value: placeOf(value.temporary)};
        }
        if (value.operand.kind === "Const") {
            return value.operand;
        }
        return {kind: "Copy", value: value.operand.value};
    }

    /**
     * The operand form of a by-value call argument.
     *
     * REWRITE-PLAN §4.5: the caller makes the copy and the caller destroys it.
     * So an owning argument is materialised into a temporary — which the
     * full-expression will drop — and passed as a borrow of that temporary.
     */
    protected forArgument(at: ts.Node, value: Typed): Operand {
        if (!this.needsCallerCopy(value.type)) {
            return value.operand;
        }
        if (value.temporary !== undefined) {
            return {kind: "Borrow", value: placeOf(value.temporary)};
        }
        // A named local: the caller makes the copy that *is* the argument, so that
        // the callee's parameter is a borrow of something the callee cannot outlive
        // and the caller cannot have taken away.
        const copy = this.temporaryTyped(at, value.type, {kind: "Use", value: value.operand});
        return copy.operand;
    }

    /** The `bool` type id, interned once. */
    protected boolTy(): TyId {
        return this.outer.mir.ty({kind: "Bool"});
    }

    protected boolConst(value: boolean) {
        return {kind: "Bool", value, ty: this.boolTy()} as const;
    }

    protected strConst(text: string) {
        return {
            kind: "Str",
            text: this.outer.mir.sym(text),
            ty: this.outer.mir.ty({kind: "Str"}),
        } as const;
    }

    /** Call a runtime function and bind its result to a temporary. */
    protected callRuntime(
        at: ts.Expression,
        name: string,
        args: Typed[],
        returns: MachineType,
    ): Typed | undefined {
        const id = this.outer.runtimeFn(
            name,
            args.map((arg) => arg.type),
            returns,
            at,
        );

        const destination =
            returns.kind === "void"
                ? undefined
                : this.f.addLocal({ty: this.outer.tyOf(returns, at), storage: "Temporary"});
        if (destination !== undefined) {
            this.temporaries.push(destination);
            this.push({kind: "StorageLive", value: destination});
        }

        const next = this.f.block();
        this.seal({
            kind: "Call",
            callee: {kind: "Direct", value: {kind: "Extern", value: id}},
            args: args.map((arg) => this.forRead(arg)),
            destination: {place: placeOf(destination ?? LocalId(0)), target: next},
            unwind: NO_UNWIND,
        });
        this.current = next;

        if (destination === undefined) {
            return {operand: {kind: "Const", value: {kind: "Unit"}}, type: VOID};
        }
        return this.fromCall(destination, returns);
    }

    /** Call a `void` runtime function that takes nothing, purely for its effect. */
    protected callRuntimeVoid(at: ts.Node, name: string): void {
        const id = this.outer.runtimeFn(name, [], VOID, at);
        const next = this.f.block();
        this.seal({
            kind: "Call",
            callee: {kind: "Direct", value: {kind: "Extern", value: id}},
            args: [],
            destination: {place: placeOf(LocalId(0)), target: next},
            unwind: NO_UNWIND,
        });
        this.current = next;
    }

    /**
     * `&place`, as an operand.
     *
     * A reference is one machine word and a `Borrow`, so it needs a local to live
     * in but never needs releasing. Reading it back with `Copy` is right: a
     * reference is trivially copied, and copying one does not end the original.
     */
    protected refTo(at: ts.Node, place: Place, referent: MachineType): Operand {
        const type: MachineType = {kind: "reference", referent};
        const local = this.f.addLocal({
            ty: this.outer.tyOf(type, at),
            storage: "Temporary",
            span: this.outer.span(at),
        });
        this.push({kind: "StorageLive", value: local});
        this.push({kind: "Init", place: placeOf(local), rvalue: {kind: "Ref", value: place}});
        return {kind: "Copy", value: placeOf(local)};
    }

    /** A call whose result is discarded, or lands in a fresh temporary. */
    protected callDirect(id: FuncId, args: Operand[], destination: LocalId | undefined): void {
        const block = this.current;
        if (block === undefined) {
            return;
        }
        const next = this.f.block();
        const place = placeOf(destination ?? LocalId(0));
        this.f.seal(block, {
            kind: "Call",
            callee: {kind: "Direct", value: {kind: "Local", value: id}},
            args,
            destination: {place, target: next},
            unwind: {kind: "Unreachable"},
        });
        this.current = next;
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
    protected fromCall(destination: LocalId, returns: MachineType): Typed {
        return {
            operand: {
                kind: this.needsCallerCopy(returns) ? "Borrow" : "Copy",
                value: placeOf(destination),
            },
            type: returns,
            temporary: destination,
        };
    }

    /**
     * `for (i = 0; i < limit; i++) { … }`, in blocks.
     *
     * Both halves of `new T[n]` / `delete[]` need one, and so does
     * {@link #fixedArray}, which predates this and builds its own. The counter is
     * an `Owned` local rather than a temporary because it lives across the back
     * edge: a temporary is released at the end of the statement that made it, and
     * this one is still being read on the next iteration.
     */
    protected countedLoop(at: ts.Node, limit: Operand, body: (counter: LocalId) => void): void {
        const usizeTy = this.outer.tyOf(USIZE, at);
        const counter = this.f.addLocal({ty: usizeTy, storage: "Owned"});
        const test = this.f.addLocal({ty: this.boolTy(), storage: "Temporary"});

        const head = this.f.block();
        const inside = this.f.block();
        const exit = this.f.block();

        this.push({kind: "StorageLive", value: counter});
        this.push({
            kind: "Init",
            place: placeOf(counter),
            rvalue: {kind: "Use", value: {kind: "Const", value: {kind: "Int", bits: 0n, ty: usizeTy}}},
        });
        this.seal({kind: "Goto", value: head});

        this.current = head;
        this.push({kind: "StorageLive", value: test});
        this.push({
            kind: "Init",
            place: placeOf(test),
            rvalue: {
                kind: "Binary",
                op: "Lt",
                lhs: {kind: "Copy", value: placeOf(counter)},
                rhs: limit,
            },
        });
        this.seal({
            kind: "Branch",
            cond: {kind: "Copy", value: placeOf(test)},
            thenBlock: inside,
            elseBlock: exit,
        });

        this.current = inside;
        body(counter);
        this.push({
            kind: "Assign",
            place: placeOf(counter),
            rvalue: {
                kind: "Binary",
                op: "Add",
                lhs: {kind: "Copy", value: placeOf(counter)},
                rhs: {kind: "Const", value: {kind: "Int", bits: 1n, ty: usizeTy}},
            },
        });
        this.seal({kind: "Goto", value: head});

        this.current = exit;
        this.push({kind: "StorageDead", value: test});
        this.push({kind: "StorageDead", value: counter});
    }

    protected endTemporaries(mark: number): void {
        for (let index = this.temporaries.length - 1; index >= mark; index -= 1) {
            this.push({kind: "StorageDead", value: this.temporaries[index]!});
        }
        this.temporaries.length = mark;
    }

    /**
     * Run `body` as one full-expression, ending any temporaries it creates.
     *
     * REWRITE-PLAN §4.4 takes C++'s rule verbatim, because it is well understood
     * and it is what people will expect.
     */
    protected fullExpression<T>(body: () => T): T {
        const mark = this.temporaries.length;
        const result = body();
        this.endTemporaries(mark);
        return result;
    }
}
