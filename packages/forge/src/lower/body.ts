/**
 * Function-body lowering: statements and expressions, to basic blocks.
 *
 * The two-pass split over expressions — {@link WidthPass.width} bottom-up, then
 * `value` here top-down with the expected type known — is described in
 * `../lower.ts`, and is the reason a literal is range-checked against the width
 * it is actually becoming rather than one guessed for it.
 *
 * This is the end of the chain, so it is also where the rest of it lands: the
 * `protected override` members below are what `emit.ts` declares abstract, and
 * moving one out of this file means moving that declaration too.
 */

import {
    type BlockId,
    type CastKind,
    FieldId,
    type FunctionBuilder,
    LocalId,
    type Operand,
    type Place,
    type Terminator,
    type TyId,
} from "@goblin-forge/backend";
import {
    checkLiteral,
    classNameOf,
    commonType,
    fits,
    hasExplicitRadix,
    isCStringType,
    isFloatType,
    isIntegerLiteral,
    isIntegerType,
    isMachineComparable,
    isPointerType,
    layoutKey,
    literalDigits,
    type MachineType,
    type Substitution,
    type Operator,
    OPERATORS,
    rangeOf,
    referentOf,
    renderType,
    sameType,
} from "@goblin-forge/checker";
import ts from "typescript";
import type { ClassInfo, ClassMethod, MethodTemplate } from "../classes.ts";
import {
    ALLOC,
    ALLOC_ARRAY,
    COMPOUND_TOKENS,
    CONSOLE_METHODS,
    CSTRING,
    CSTRING_FREE,
    FIXED_ARRAY,
    MIR_OPS,
    MOVE,
    NATIVE_ALIGN_OF,
    NATIVE_CAST,
    NATIVE_SIZE_OF,
    NATIVE_ZEROED,
    NO_UNWIND,
    OPERATOR_TOKENS,
    POINTER_ADDRESS,
    POINTER_METHODS,
    RUNTIME,
    STRING_FROM_BYTES,
    STRING_FROM_CSTRING,
    TRY_CAST,
} from "./tables.ts";
import { type FnRecord, ISIZE, STRING, type Typed, typed, USIZE, VOID } from "./types.ts";
import { type Binding, bindingPlace, isCapture, type LoopFrame, type Scope, Scopes } from "./scopes.ts";
import {
    behindOneIndirection,
    describe,
    elementTypeOf,
    hasNullValue,
    needsDrop,
    nullAdvice,
    placeOf,
} from "./util.ts";
import type { Lowerer } from "./module.ts";
import { BoundaryLowerer } from "./c-boundary.ts";
import { isCallArgument } from "./closures.ts";

export class BodyLowerer extends BoundaryLowerer {
    readonly #returns: MachineType;
    readonly #loops: LoopFrame[] = [];

    /** Locals that have been moved from, and the name they were moved under. */
    readonly #moved = new Map<LocalId, string>();

    /**
     * The class whose field initialisers are waiting for a `super()` to finish.
     *
     * Cleared as soon as they are emitted, so a second `super()` — which tsc
     * rejects anyway — could not run them twice.
     */
    #pendingInitialisers: ClassInfo | undefined;

    constructor(
        outer: Lowerer,
        f: FunctionBuilder,
        scopes: Scopes,
        returns: MachineType,
        bindings: Substitution,
    ) {
        super(outer, f, scopes, bindings);
        this.#returns = returns;
    }

    /**
     * A lifted closure body, which differs from {@link run} in two ways.
     *
     * It takes a **concise body**: `(x) => x * 2` has an expression where a
     * function declaration has a block, and that expression is the return value
     * rather than a statement. tsc allows it and it is the spelling every
     * iterator callback is written in, so refusing it would make the feature
     * unusable in the shape it exists for.
     *
     * And it gives the environment pointer its type back, in the entry block
     * before the first statement. Parameter 1 is a `Pointer<unknown>`, because
     * every closure reaching a given `LocalFn<F>` has an environment of a
     * different shape and the parameter's type cannot depend on which one
     * arrived; the cast here is the `reify<T>()` that makes its fields
     * addressable, and it is emitted rather than assumed for the same reason
     * REWRITE-PLAN §10 gives: nothing is ever retyped in place.
     *
     * `env` is absent for a closure that captures nothing, which then has no
     * environment at all and never loads one.
     */
    runClosure(
        body: ts.ConciseBody,
        env: { local: LocalId; parameter: LocalId; ty: TyId } | undefined,
    ): void {
        this.current = this.f.block();
        if (env !== undefined) {
            this.push({kind: "StorageLive", value: env.local});
            this.push({
                kind: "Init",
                place: placeOf(env.local),
                rvalue: {
                    kind: "Cast",
                    op: "PtrToPtr",
                    operand: {kind: "Copy", value: placeOf(env.parameter)},
                    to: env.ty,
                },
            });
        }

        if (ts.isBlock(body)) {
            this.#block(body);
        } else if (this.#returns.kind === "void") {
            // `(x) => push(x)` — tsc allows a concise body whose value is discarded
            // when the closure returns `void`, and the value really is discarded.
            // Not routed through `#expressionStatement`: there is no statement node
            // here, and synthesising one would put a node with no position where
            // every diagnostic reads one.
            this.fullExpression(() => {
                this.#expressionValue(body);
            });
        } else {
            const mark = this.temporaries.length;
            const value = this.#returnValue(body);
            if (value !== undefined) {
                this.push({kind: "Init", place: placeOf(LocalId(0)), rvalue: {kind: "Use", value}});
            }
            this.endTemporaries(mark);
            for (const scope of this.scopes.all()) {
                this.#endScope(scope);
            }
            this.seal({kind: "Return"});
        }

        if (this.current !== undefined) {
            this.seal({kind: "Return"});
        }
    }

    run(
        body: ts.Block,
        isEntry = false,
        entryArgs?: { name: string; type: MachineType },
    ): void {
        this.current = this.f.block();
        // The runtime's one initialisation point, before the program's first
        // statement. An ordinary `extern "C"` call like every other runtime call —
        // it shows up in a MIR dump, which is where you want to see it, and it is
        // linked because it is *called* rather than because a platform happened to
        // pull in a constructor.
        if (isEntry) {
            this.callRuntimeVoid(body, RUNTIME.init);
        }
        if (entryArgs !== undefined) {
            this.#bindEntryArgs(body, entryArgs);
        }
        this.#block(body);
        // Falling off the end of a `void` function is a return. tsc has already
        // rejected falling off the end of one that returns a value.
        if (this.current !== undefined) {
            this.seal({kind: "Return"});
        }
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
        this.current = this.f.block();

        if (body === undefined) {
            // Generated. tsc is not here to insist on `super()`, so the base call is
            // written out rather than waited for.
            if (info.base?.needsConstructor === true) {
                this.#callBaseConstructor(info, info.node);
            }
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

        if (this.current !== undefined) {
            this.seal({kind: "Return"});
        }
    }

    /**
     * Resolve a subject to the class it is, seeing through one `Reference<T>`.
     *
     * A method's `this` is a `Reference<Self>`, and a local holding an object is
     * the object; a field access has to work on both without the caller caring
     * which it has. Seeing through the reference here is what `Projection::Deref`
     * exists for — nothing is ever *retyped*, which is the v1 bug REWRITE-PLAN
     * §10 opens with.
     */
    protected override asClass(subject: Typed): { info: ClassInfo; place: Place } | undefined {
        let type = subject.type;
        const extra: Place["projection"] = [];
        // A `Pointer<C>` reaches an object the same way a `Reference<C>` does —
        // one dereference — which is what makes `p.field` and `p.method()` work
        // without writing one. The auto-dereference C++ spells `->`.
        if (
            (type.kind === "reference" && type.referent.kind === "class") ||
            (type.kind === "pointer" && type.pointee.kind === "class")
        ) {
            extra.push({kind: "Deref"});
            type = type.kind === "reference" ? type.referent : type.pointee;
        }
        if (type.kind !== "class") {
            return undefined;
        }
        const info = this.outer.classInfo(type.name);
        if (info === undefined) {
            return undefined;
        }
        if (subject.operand.kind === "Const") {
            return undefined;
        }
        const base = subject.operand.value;
        return {
            info,
            place: {local: base.local, projection: [...base.projection, ...extra]},
        };
    }

    #fieldOf(info: ClassInfo, name: string): { index: number; type: MachineType } | undefined {
        const index = info.fields.findIndex((field) => field.name === name);
        if (index < 0) {
            return undefined;
        }
        return {index, type: info.fields[index]!.type};
    }

    /** `this`, as a `Reference<Self>` borrowed from the parameter holding it. */
    #thisTyped(at: ts.Node): Typed | undefined {
        const binding = this.scopes.lookup("this");
        if (binding === undefined || this.self === undefined) {
            this.outer.error(
                at,
                "GF0002",
                "`this` is only meaningful inside a method or a constructor.",
            );
            return undefined;
        }
        return {operand: {kind: "Borrow", value: bindingPlace(binding)}, type: binding.type};
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
        // `new dvec3(1, 2, 3)` builds an aggregate and never reaches a class:
        // a linear-algebra type is a struct, so there is no vtable to install
        // and no constructor to call (DECISIONS §22).
        const linalg = this.linalgNew(expression);
        if (linalg !== "not-linalg") {
            return linalg;
        }

        if (!ts.isIdentifier(expression.expression)) {
            this.outer.unsupported(expression, "an expression after `new`");
            return undefined;
        }
        // From the erasure of the whole `new`, so that `new Box<i32>(…)` makes
        // a `Box<i32>` — see the same reasoning in the width pass. Interning
        // the type is what instantiates a generic class, so it happens before
        // `classInfo` is asked.
        const type = this.erase(expression, this.outer.checker.getTypeAtLocation(expression));
        if (type?.kind !== "class") {
            this.outer.unsupported(expression, `\`new ${expression.expression.text}\``);
            return undefined;
        }
        const ty = this.outer.tyOf(type, expression);
        const name = type.name;
        const info = this.outer.classInfo(name);
        if (info === undefined) {
            this.outer.unsupported(expression, `\`new ${name}\``);
            return undefined;
        }

        const local = this.f.addLocal({
            ty,
            storage: "Temporary",
            span: this.outer.span(expression),
        });
        this.push({kind: "StorageLive", value: local});
        this.push({kind: "Init", place: placeOf(local), rvalue: {kind: "Default"}});
        this.temporaries.push(local);

        const args = this.classCallArgs(
            expression,
            info,
            info.constructorSymbol,
            expression.arguments ?? ts.factory.createNodeArray(),
            this.refTo(expression, placeOf(local), type),
        );
        if (args === undefined) {
            return undefined;
        }
        if (args !== null) {
            const record = this.outer.fn(info.constructorSymbol!);
            if (record === undefined || record.kind !== "defined") {
                return undefined;
            }
            this.callDirect(record.id, args, undefined);
        } else if ((expression.arguments?.length ?? 0) > 0) {
            this.outer.error(
                expression,
                "GF0002",
                `\`${name}\` declares no constructor, so \`new ${name}\` takes no arguments.`,
            );
            return undefined;
        }

        return {operand: {kind: "Move", value: placeOf(local)}, type, temporary: local};
    }

    /**
     * Marshal the arguments of a constructor or method call, with the receiver
     * first.
     *
     * Returns `null` when there is no such function to call — a class with no
     * constructor — so that the caller can tell "nothing to do" from "something
     * went wrong", which `undefined` already means.
     */
    protected override classCallArgs(
        at: ts.Node,
        info: ClassInfo,
        symbol: string | undefined,
        args: readonly ts.Expression[],
        receiver: Operand,
    ): Operand[] | undefined | null {
        if (symbol === undefined) {
            return null;
        }
        const record = this.outer.fn(symbol);
        if (record === undefined) {
            this.outer.unsupported(at, `a call to \`${info.name}\`'s \`${symbol}\``);
            return undefined;
        }
        // Parameter 0 is the receiver; the declared parameters follow it.
        const expected = record.signature.params.slice(1);
        if (args.length !== expected.length) {
            this.outer.error(
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
            const value = this.expressionTyped(argument, want);
            if (value === undefined) {
                return undefined;
            }
            out.push(this.forArgument(argument, value));
        }
        return out;
    }

    /**
     * `main(args: string[])` — build the array from the pair the platform passed.
     *
     * Locals 1 and 2 are `argc` and `argv`: `main`'s emitted signature is C's,
     * because the C runtime is what calls it. The declared parameter is bound
     * here instead, to a **binding** rather than a parameter — which is what
     * makes the array `main`'s to release, exactly as a `const` would be. That is
     * also the only honest arrangement: the strings are copies of the platform's
     * bytes, so somebody has to own them, and the scope that named them is the
     * obvious somebody.
     */
    #bindEntryArgs(at: ts.Node, param: { name: string; type: MachineType }): void {
        const ty = this.outer.tyOf(param.type, at);
        const argc: Typed = {
            operand: {kind: "Copy", value: placeOf(LocalId(1))},
            type: {kind: "scalar", name: "i32"},
        };
        const argv: Typed = {
            operand: {kind: "Copy", value: placeOf(LocalId(2))},
            type: {kind: "pointer", pointee: {kind: "pointer", pointee: {kind: "scalar", name: "u8"}}},
        };
        const built = this.callRuntime(at as ts.Expression, RUNTIME.args, [argc, argv], param.type);
        if (built === undefined) {
            return;
        }

        const local = this.f.addLocal({ty, storage: "Owned", name: param.name});
        this.push({kind: "StorageLive", value: local});
        // `Move`, not `Copy`: the runtime built this array for us and nothing else
        // holds it. Copying would duplicate every string and leave the original to
        // the temporary's drop, which is an allocation per argument for nothing.
        this.push({
            kind: "Init",
            place: placeOf(local),
            rvalue: {kind: "Use", value: {kind: "Move", value: this.placeOfSubject(at, built)!}},
        });
        this.scopes.declare(param.name, {local, type: param.type, ty});
    }

    /** Run the initialisers held back for the base construction to finish. */
    #emitPendingInitialisers(): void {
        const info = this.#pendingInitialisers;
        if (info === undefined) {
            return;
        }
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
        // Parameter properties first, so that a field initialiser may read one:
        // `class C { double = this.x * 2; constructor(private x: i32) {} }` only
        // means anything in this order. They are assignments from a parameter
        // rather than from an expression, so there is no full-expression to open —
        // and they are **copies**, because the caller still owns the argument and
        // releases it when the call ends.
        for (const field of info.parameterProperties) {
            const index = info.fields.indexOf(field);
            const binding = this.scopes.lookup(field.name);
            if (index < 0 || binding === undefined) {
                continue;
            }
            const value: Typed = {
                operand: {kind: "Copy", value: bindingPlace(binding)},
                type: field.type,
            };
            this.push({
                kind: "Assign",
                place: {
                    local: LocalId(1),
                    projection: [{kind: "Deref"}, {kind: "Field", value: FieldId(index)}],
                },
                rvalue: {kind: "Use", value: this.forStorage(value)},
            });
        }

        for (const field of info.initialisedFields) {
            const initialiser = field.declaration.initializer;
            if (initialiser === undefined) {
                continue;
            }
            const index = info.fields.indexOf(field);
            if (index < 0) {
                continue;
            }

            // Each initialiser is its own full-expression, so whatever temporaries it
            // makes die at the end of it — the same rule a statement gets, and the
            // reason a `class C { s: string = "a" + "b" }` in a loop does not
            // accumulate the concatenation's intermediates.
            this.fullExpression(() => {
                const value = this.expressionTyped(initialiser, field.type);
                if (value === undefined) {
                    return;
                }
                // `Assign` rather than `Init`, and the same node `this.x = …` uses in a
                // constructor body: the storage was zeroed by `Default` before the
                // constructor was called, so an owning field holds an empty value that
                // is released before the new one lands.
                this.push({
                    kind: "Assign",
                    place: {
                        local: LocalId(1),
                        projection: [{kind: "Deref"}, {kind: "Field", value: FieldId(index)}],
                    },
                    rvalue: {kind: "Use", value: this.forStorage(value)},
                });
            });
        }
    }

    /** `Base$new(this)`, for a generated constructor that has no `super()` to read. */
    #callBaseConstructor(info: ClassInfo, at: ts.Node): void {
        const base = info.base;
        if (base?.constructorSymbol === undefined) {
            return;
        }
        const record = this.outer.fn(base.constructorSymbol);
        if (record === undefined || record.kind !== "defined") {
            this.outer.unsupported(at, `a call to \`${base.name}\`'s constructor`);
            return;
        }
        this.callDirect(record.id, [{kind: "Copy", value: placeOf(LocalId(1))}], undefined);
    }

    #block(node: ts.Block): void {
        const scope = this.scopes.push();
        for (const statement of node.statements) {
            if (this.current === undefined) {
                break;
            }
            this.#statement(statement);
        }
        // Falling out of a block ends its locals. An early exit released them
        // already and left `#current` undefined, so this does not double up.
        this.#endScope(scope);
        this.scopes.pop();
    }

    #statement(statement: ts.Statement): void {
        if (ts.isReturnStatement(statement)) {
            return this.#return(statement);
        }
        if (ts.isVariableStatement(statement)) {
            return this.#declaration(statement);
        }
        if (ts.isIfStatement(statement)) {
            return this.#if(statement);
        }
        if (ts.isWhileStatement(statement)) {
            return this.#while(statement);
        }
        if (ts.isDoStatement(statement)) {
            return this.#doWhile(statement);
        }
        if (ts.isForStatement(statement)) {
            return this.#for(statement);
        }
        if (ts.isForOfStatement(statement)) {
            return this.#forOf(statement);
        }
        if (ts.isSwitchStatement(statement)) {
            return this.#switch(statement);
        }
        if (ts.isLabeledStatement(statement)) {
            return this.#labelled(statement);
        }
        if (ts.isBreakStatement(statement)) {
            return this.#break(statement);
        }
        if (ts.isContinueStatement(statement)) {
            return this.#continue(statement);
        }
        if (ts.isBlock(statement)) {
            return this.#block(statement);
        }
        if (ts.isExpressionStatement(statement)) {
            return this.#expressionStatement(statement);
        }
        if (statement.kind === ts.SyntaxKind.EmptyStatement) {
            return;
        }
        this.outer.unsupported(statement, describe(statement));
    }

    #return(statement: ts.ReturnStatement): void {
        const mark = this.temporaries.length;
        if (statement.expression !== undefined) {
            const value = this.#returnValue(statement.expression);
            if (value === undefined) {
                return;
            }
            // The return place is local 0, always. For a register-sized value the
            // backend loads it; for an aggregate the caller designated the storage.
            // One mechanism, not two (REWRITE-PLAN §4.5).
            this.push({kind: "Init", place: placeOf(LocalId(0)), rvalue: {kind: "Use", value}});
        }
        // The return value is already in place, so releasing everything else is
        // safe — including the temporaries the return expression itself made.
        this.endTemporaries(mark);
        for (const scope of this.scopes.all()) {
            this.#endScope(scope);
        }
        this.seal({kind: "Return"});
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
        if (ts.isIdentifier(expression) && sameType(this.#returns, this.widthType(expression))) {
            const binding = this.scopes.lookup(expression.text);
            // A capture is excluded for the same reason a by-value parameter is:
            // the value belongs to a frame that is still live and still going to
            // destroy it. Falling through copies, which is what returning it means.
            if (
                binding !== undefined &&
                this.#owns(binding.type) &&
                !this.#isOwningParameter(binding) &&
                !isCapture(binding)
            ) {
                if (this.#readMoved(expression, binding.local, expression.text)) {
                    return undefined;
                }
                this.#moved.set(binding.local, expression.text);
                return {kind: "Move", value: bindingPlace(binding)};
            }
        }
        const value = this.expressionTyped(expression, this.#returns);
        return value === undefined ? undefined : this.forStorage(value);
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
    protected override needsCallerCopy(type: MachineType): boolean {
        return (
            this.#owns(type) ||
            type.kind === "struct" ||
            type.kind === "fixedArray" ||
            type.kind === "class"
        );
    }

    /**
     * The frame `break` or `continue` leaves through.
     *
     * Innermost first, and a label names one further out. `continue` skips
     * frames with no continue target, which is how `continue` inside a `switch`
     * reaches the loop around it.
     */
    #frameFor(label: string | undefined, continuing: boolean): LoopFrame | undefined {
        for (let i = this.#loops.length - 1; i >= 0; i -= 1) {
            const frame = this.#loops[i]!;
            if (continuing && frame.continueTo === undefined) {
                continue;
            }
            if (label === undefined || frame.label === label) {
                return frame;
            }
        }
        return undefined;
    }

    #break(statement: ts.BreakStatement): void {
        // tsc has already rejected a label that names nothing and a bare `break`
        // outside a breakable statement, so an absent frame here means the two
        // disagree rather than that the program is wrong.
        const frame = this.#frameFor(statement.label?.text, false);
        if (frame === undefined) {
            this.outer.unsupported(statement, "`break` here");
            return;
        }
        this.#exitLoop(frame, frame.breakTo);
    }

    #continue(statement: ts.ContinueStatement): void {
        const frame = this.#frameFor(statement.label?.text, true);
        if (frame?.continueTo === undefined) {
            this.outer.unsupported(statement, "`continue` here");
            return;
        }
        this.#exitLoop(frame, frame.continueTo);
    }

    /**
     * `outer: while (…) { … }` — a name for a loop, so `break` can leave more
     * than the innermost one.
     *
     * The label is handed to whatever statement it decorates rather than being a
     * construct of its own, so `outer: while` pushes one frame carrying the
     * label, not two. Only a labelled *block* needs a frame here, and it needs
     * one because `outer: { break outer; }` is legal and jumps forward.
     */
    #labelled(statement: ts.LabeledStatement): void {
        const label = statement.label.text;
        const inner = statement.statement;
        if (ts.isWhileStatement(inner)) {
            return this.#while(inner, label);
        }
        if (ts.isDoStatement(inner)) {
            return this.#doWhile(inner, label);
        }
        if (ts.isForStatement(inner)) {
            return this.#for(inner, label);
        }
        if (ts.isForOfStatement(inner)) {
            return this.#forOf(inner, label);
        }
        if (ts.isSwitchStatement(inner)) {
            return this.#switch(inner, label);
        }

        const enclosing = this.scopes.innermost;
        const exit = this.f.block();
        this.#loops.push({breakTo: exit, continueTo: undefined, enclosing, label});
        this.#statement(inner);
        this.#loops.pop();
        if (this.current !== undefined) {
            this.seal({kind: "Goto", value: exit});
        }
        this.current = exit;
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
        for (const scope of this.scopes.inside(frame.enclosing)) {
            this.#endScope(scope);
        }
        this.seal({kind: "Goto", value: target});
    }

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
            this.push({kind: "StorageDead", value: scope.locals[index]!});
        }
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
        for (let index = this.temporaries.length - 1; index >= mark; index -= 1) {
            dying.push(this.temporaries[index]!);
        }
        this.temporaries.length = mark;

        if (dying.length === 0) {
            this.seal({kind: "Branch", cond, thenBlock: thenTarget, elseBlock: elseTarget});
            return;
        }

        const onTrue = this.f.block();
        const onFalse = this.f.block();
        this.seal({kind: "Branch", cond, thenBlock: onTrue, elseBlock: onFalse});

        for (const [edge, target] of [
            [onTrue, thenTarget],
            [onFalse, elseTarget],
        ] as const) {
            for (const local of dying) {
                this.f.push(edge, {kind: "StorageDead", value: local});
            }
            this.f.seal(edge, {kind: "Goto", value: target});
        }
    }

    #declaration(statement: ts.VariableStatement): void {
        this.#declarationList(statement.declarationList);
    }

    #declarationList(list: ts.VariableDeclarationList): void {
        for (const declaration of list.declarations) {
            if (!ts.isIdentifier(declaration.name)) {
                this.outer.unsupported(declaration, "a destructuring binding");
                return;
            }
            if (declaration.initializer === undefined) {
                this.outer.unsupported(declaration, "a binding without an initialiser");
                return;
            }

            // The annotation is what gives a binding its width. Without one, the
            // initialiser's own width is used — and if the initialiser is built only
            // from literals there is nothing to take a width from, which is the one
            // case that has to be reported rather than guessed.
            const type = this.#bindingType(declaration);
            if (type === undefined) {
                return;
            }

            const ty = this.outer.tyOf(type, declaration);
            const local = this.f.addLocal({
                ty,
                // A binding owns what it holds and its scope destroys it. For the
                // trivial types this milestone covers there is nothing to destroy, but
                // the storage class is recorded from the start rather than inferred
                // later — that is the whole point of REWRITE-PLAN §4.2.
                storage: "Owned",
                name: declaration.name.text,
                span: this.outer.span(declaration),
            });

            // The initialiser's temporaries die at the end of *this* declaration —
            // after the value has been moved into the binding, not before.
            const name = declaration.name.text;
            const initializer = declaration.initializer;
            this.fullExpression(() => {
                const value = this.expressionTyped(initializer, type);
                if (value === undefined) {
                    return;
                }
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
                    this.outer.error(
                        initializer,
                        "GF0234",
                        "nothing owns this value, so it would be released at the end of " +
                        "this statement and the reference would outlive it. Bind it to a " +
                        "name first, then take a reference to that.",
                    );
                    return;
                }
                this.push({kind: "StorageLive", value: local});
                this.push({
                    kind: "Init",
                    place: placeOf(local),
                    rvalue: {kind: "Use", value: this.forStorage(value)},
                });
                this.scopes.declare(name, {local, type, ty});
            });
        }
    }

    #bindingType(declaration: ts.VariableDeclaration): MachineType | undefined {
        if (declaration.type !== undefined) {
            return this.erase(
                declaration.type,
                this.outer.checker.getTypeAtLocation(declaration.type),
            );
        }
        const initialiser = declaration.initializer!;
        const width = this.width(initialiser);
        if (width.kind === "error") {
            return undefined;
        }
        if (width.kind === "typed") {
            return width.type;
        }
        // `null` is poly like a literal, and for a stronger reason — it has no
        // width because it has no type at all — so the literal's message would name
        // the wrong missing thing.
        if (initialiser.kind === ts.SyntaxKind.NullKeyword) {
            this.outer.error(
                declaration,
                "GF0161",
                `\`${declaration.name.getText()}\` is initialised with \`null\`, which ` +
                "has no type of its own. Annotate what it is the null of — " +
                "`const w: Pointer<SDL_Window> | null = null`.",
            );
            return undefined;
        }
        this.outer.error(
            declaration,
            "GF0161",
            `\`${declaration.name.getText()}\` has no width: its initialiser is built ` +
            "only from literals, and a literal takes its width from context rather " +
            "than having one of its own. Annotate the binding.",
        );
        return undefined;
    }

    #if(statement: ts.IfStatement): void {
        const mark = this.temporaries.length;
        const cond = this.#condition(statement.expression);
        if (cond === undefined) {
            return;
        }

        const thenBlock = this.f.block();
        const elseBlock = statement.elseStatement ? this.f.block() : undefined;
        const joinBlock = this.f.block();

        this.#branchEndingTemporaries(cond, mark, thenBlock, elseBlock ?? joinBlock);

        this.current = thenBlock;
        this.#statement(statement.thenStatement);
        if (this.current !== undefined) {
            this.seal({kind: "Goto", value: joinBlock});
        }

        if (statement.elseStatement && elseBlock !== undefined) {
            this.current = elseBlock;
            this.#statement(statement.elseStatement);
            if (this.current !== undefined) {
                this.seal({kind: "Goto", value: joinBlock});
            }
        }

        this.current = joinBlock;
    }

    #while(statement: ts.WhileStatement, label?: string): void {
        const enclosing = this.scopes.innermost;
        const head = this.f.block();
        const body = this.f.block();
        const exit = this.f.block();

        this.seal({kind: "Goto", value: head});
        this.current = head;
        this.#loopCondition(statement.expression, body, exit);

        this.current = body;
        this.#loops.push({breakTo: exit, continueTo: head, enclosing, label});
        this.#statement(statement.statement);
        this.#loops.pop();
        if (this.current !== undefined) {
            this.seal({kind: "Goto", value: head});
        }

        this.current = exit;
    }

    /**
     * `do { … } while (c)` — a `while` whose first test is skipped.
     *
     * The only structural difference is where control enters: at the body rather
     * than at the head. `continue` still goes to the head, because the test is
     * what a `do/while` runs between iterations — jumping to the body instead
     * would skip it and turn the loop into an infinite one.
     */
    #doWhile(statement: ts.DoStatement, label?: string): void {
        const enclosing = this.scopes.innermost;
        const head = this.f.block();
        const body = this.f.block();
        const exit = this.f.block();

        this.seal({kind: "Goto", value: body});

        this.current = body;
        this.#loops.push({breakTo: exit, continueTo: head, enclosing, label});
        this.#statement(statement.statement);
        this.#loops.pop();
        if (this.current !== undefined) {
            this.seal({kind: "Goto", value: head});
        }

        this.current = head;
        this.#loopCondition(statement.expression, body, exit);

        this.current = exit;
    }

    /**
     * A `for` loop, desugared into its four parts.
     *
     * The initialiser gets a scope of its own, so `for (let i: i32 = 0; …)` binds
     * `i` for the loop and nothing after it — and `continue` releases the body's
     * scopes but not `i`, which is what makes the update expression still able to
     * read it.
     */
    #for(statement: ts.ForStatement, label?: string): void {
        const outer = this.scopes.push();

        if (statement.initializer !== undefined) {
            if (ts.isVariableDeclarationList(statement.initializer)) {
                this.#declarationList(statement.initializer);
            } else {
                this.fullExpression(() => {
                    this.value(statement.initializer as ts.Expression, undefined);
                });
            }
        }

        const head = this.f.block();
        const body = this.f.block();
        const update = this.f.block();
        const exit = this.f.block();

        this.seal({kind: "Goto", value: head});
        this.current = head;
        if (statement.condition === undefined) {
            this.seal({kind: "Goto", value: body});
        } else {
            this.#loopCondition(statement.condition, body, exit);
        }

        this.current = body;
        // `continue` goes to the update, not to the condition: skipping the update
        // is how a `for` loop turns into an infinite one.
        this.#loops.push({breakTo: exit, continueTo: update, enclosing: outer, label});
        this.#statement(statement.statement);
        this.#loops.pop();
        if (this.current !== undefined) {
            this.seal({kind: "Goto", value: update});
        }

        this.current = update;
        if (statement.incrementor !== undefined) {
            this.fullExpression(() => {
                this.#expressionValue(statement.incrementor!);
            });
        }
        this.seal({kind: "Goto", value: head});

        this.current = exit;
        this.#endScope(outer);
        this.scopes.pop();
    }

    /**
     * `for (const x of xs)` — an index loop, written out.
     *
     * There is no iterator protocol here and there is not going to be one: this
     * is C++'s range-`for` over a contiguous container, which is a counter, a
     * bound and a subscript. tsc agrees without help — under `noLib` it falls
     * back to the index signature and binds `x` to the element type, which is why
     * `tsconfig.base.json` can target ES2015 rather than ES5.
     *
     * The binding is a **copy** of the element, as `for (auto x : v)` is in C++.
     * Writing to it does not write through to the array, and for an owning
     * element type it costs an allocation per iteration — `Reference<T>` would be
     * the way to say otherwise, and it is not writable for most element types
     * yet.
     *
     * Only over a `T[]`. A `FixedArray` is rejected by tsc itself (TS2495), so it
     * never arrives here.
     */
    #forOf(statement: ts.ForOfStatement, label?: string): void {
        if (!ts.isVariableDeclarationList(statement.initializer)) {
            this.outer.unsupported(statement.initializer, "a `for…of` binding that is not a declaration");
            return;
        }
        const declaration = statement.initializer.declarations[0];
        if (statement.initializer.declarations.length !== 1 || declaration === undefined) {
            this.outer.unsupported(statement.initializer, "more than one `for…of` binding");
            return;
        }
        if (!ts.isIdentifier(declaration.name)) {
            this.outer.unsupported(declaration, "a destructuring binding");
            return;
        }

        const outer = this.scopes.push();
        const subject = this.value(statement.expression, undefined);
        if (subject === undefined) {
            this.scopes.pop();
            return;
        }
        const array = this.asArray(statement.expression, subject);
        if (array === undefined) {
            this.outer.unsupported(
                statement.expression,
                `\`for…of\` over a \`${renderType(subject.type)}\``,
            );
            this.scopes.pop();
            return;
        }

        const usizeTy = this.outer.tyOf(USIZE, statement);
        // `Owned` rather than `Temporary`: the counter is read again after the back
        // edge, and a temporary is released at the end of the statement that made
        // it.
        const counter = this.f.addLocal({ty: usizeTy, storage: "Owned"});
        this.push({kind: "StorageLive", value: counter});
        this.push({
            kind: "Init",
            place: placeOf(counter),
            rvalue: {kind: "Use", value: {kind: "Const", value: {kind: "Int", bits: 0n, ty: usizeTy}}},
        });

        const head = this.f.block();
        const body = this.f.block();
        const update = this.f.block();
        const exit = this.f.block();

        this.seal({kind: "Goto", value: head});

        // The bound is re-read every iteration, so a `push` inside the loop is seen
        // — the same answer `for (i = 0; i < v.size(); ++i)` gives, and the same
        // hazard, since growing reallocates and moves the elements.
        this.current = head;
        const length = this.temporaryTyped(statement, USIZE, {kind: "Len", value: array.place});
        if (length === undefined) {
            return;
        }
        const test = this.f.addLocal({ty: this.boolTy(), storage: "Temporary"});
        this.push({kind: "StorageLive", value: test});
        this.push({
            kind: "Init",
            place: placeOf(test),
            rvalue: {
                kind: "Binary",
                op: "Lt",
                lhs: {kind: "Copy", value: placeOf(counter)},
                rhs: length.operand,
            },
        });
        this.seal({
            kind: "Branch",
            cond: {kind: "Copy", value: placeOf(test)},
            thenBlock: body,
            elseBlock: exit,
        });

        this.current = body;
        const inner = this.scopes.push();
        const element = array.element;
        const local = this.f.addLocal({
            ty: this.outer.tyOf(element, declaration),
            storage: "Owned",
            name: declaration.name.text,
            span: this.outer.span(declaration),
        });
        this.push({kind: "StorageLive", value: local});
        this.push({
            kind: "Init",
            place: placeOf(local),
            rvalue: {
                kind: "Use",
                value: {
                    kind: "Copy",
                    value: {
                        local: array.place.local,
                        projection: [...array.place.projection, {kind: "Index", value: counter}],
                    },
                },
            },
        });
        this.scopes.declare(declaration.name.text, {
            local,
            type: element,
            ty: this.outer.tyOf(element, declaration),
        });

        this.#loops.push({breakTo: exit, continueTo: update, enclosing: outer, label});
        this.#statement(statement.statement);
        this.#loops.pop();
        // The element binding is released at the end of every iteration, including
        // the one `break` leaves through — `#exitLoop` releases every scope opened
        // inside the loop, and this is one.
        if (this.current !== undefined) {
            this.#endScope(inner);
            this.seal({kind: "Goto", value: update});
        }
        this.scopes.pop();

        this.current = update;
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
        this.push({kind: "StorageDead", value: counter});
        this.#endScope(outer);
        this.scopes.pop();
    }

    /**
     * `switch` — a chain of equality tests, and blocks that fall into each other.
     *
     * Not a jump table. The subject is evaluated once and compared against each
     * case in order, which is what a C compiler emits for a sparse switch anyway
     * and is the only thing that works for a `string` subject. A dense integer
     * switch would benefit from `br_table`; that is an optimisation for later and
     * changes no semantics.
     *
     * The clause blocks are chained so that a clause running off its end falls
     * into the next one, which is what `case 1: case 2:` means. Real fallthrough
     * between *non-empty* clauses is the same machinery, and it is
     * `noFallthroughCasesInSwitch` in `tsconfig.base.json` that forbids it — so
     * the rule lives with tsc, where the editor can show it, rather than here.
     */
    #switch(statement: ts.SwitchStatement, label?: string): void {
        // The frame's enclosing scope is the one *outside* the switch, so that
        // `break` releases the subject's scope on its way out. Pointing it at the
        // switch's own scope instead would leave the subject alive on every
        // breaking path, which for a `string` subject is a leak per iteration.
        const enclosing = this.scopes.innermost;
        const scope = this.scopes.push();
        const clauses = statement.caseBlock.clauses;
        const exit = this.f.block();

        // Evaluated once, into a binding, before any comparison. That is the whole
        // difference between a `switch` and the chain of `if`s it expands to — and
        // it has to be a *binding* rather than a temporary, because the dispatch
        // branches away on every test and a temporary would only be released on
        // the one path that fell through all of them.
        let held: Typed | undefined;
        this.fullExpression(() => {
            const subject = this.value(statement.expression, undefined);
            if (subject === undefined) {
                return;
            }
            // The same rule `===` follows, and only its equality half: a `string`
            // knows whether it equals another — the runtime compares the bytes —
            // where an aggregate has no such question to ask, because two values
            // with equal fields are as interchangeable as two `3`s.
            if (!isMachineComparable(subject.type) && subject.type.kind !== "string") {
                this.outer.error(
                    statement.expression,
                    "GF0002",
                    `a \`switch\` compares its subject with \`===\`, and a ` +
                    `\`${renderType(subject.type)}\` cannot be compared that way. ` +
                    "Switch on one of its fields instead.",
                );
                return;
            }
            const ty = this.outer.tyOf(subject.type, statement.expression);
            const local = this.f.addLocal({ty, storage: "Owned"});
            this.push({kind: "StorageLive", value: local});
            this.push({
                kind: "Init",
                place: placeOf(local),
                rvalue: {kind: "Use", value: this.forStorage(subject)},
            });
            // Declared under a name no source file can spell, so the scope releases
            // it exactly as it releases a `const`.
            this.scopes.declare("switch\0subject", {local, type: subject.type, ty});
            held = {operand: {kind: "Copy", value: placeOf(local)}, type: subject.type};
        });
        if (held === undefined) {
            this.scopes.pop();
            return;
        }

        const blocks = clauses.map(() => this.f.block());
        const defaultAt = clauses.findIndex((clause) => ts.isDefaultClause(clause));

        // The dispatch: one test per `case`, in order, then the `default` — which
        // is reached only when every test failed, wherever it was written.
        for (const [index, clause] of clauses.entries()) {
            if (!ts.isCaseClause(clause)) {
                continue;
            }
            const subject = held;
            // The answer lives in a local declared *outside* the full-expression, so
            // it survives the `StorageDead`s that close it. Each test is its own
            // full-expression because a case value may allocate — `case "a" + s:`
            // does — and the branch leaves this block, so those temporaries have to
            // be released before the branch rather than after it.
            const matched = this.f.addLocal({ty: this.boolTy(), storage: "Temporary"});
            this.push({kind: "StorageLive", value: matched});
            let ok = false;
            this.fullExpression(() => {
                const value = this.expressionTyped(clause.expression, subject.type);
                if (value === undefined) {
                    return;
                }
                this.push({
                    kind: "Init",
                    place: placeOf(matched),
                    rvalue: {
                        kind: "Binary",
                        op: "Eq",
                        lhs: this.forRead(subject),
                        rhs: this.forRead(value),
                    },
                });
                ok = true;
            });
            if (!ok) {
                this.scopes.pop();
                return;
            }
            const next = this.f.block();
            this.seal({
                kind: "Branch",
                cond: {kind: "Copy", value: placeOf(matched)},
                thenBlock: blocks[index]!,
                elseBlock: next,
            });
            this.current = next;
        }
        this.seal({kind: "Goto", value: defaultAt >= 0 ? blocks[defaultAt]! : exit});

        this.#loops.push({breakTo: exit, continueTo: undefined, enclosing, label});
        for (const [index, clause] of clauses.entries()) {
            this.current = blocks[index];
            const clauseScope = this.scopes.push();
            for (const inner of clause.statements) {
                this.#statement(inner);
            }
            if (this.current !== undefined) {
                this.#endScope(clauseScope);
                // Falls into the next clause, or off the end of the switch.
                this.seal({kind: "Goto", value: blocks[index + 1] ?? exit});
            }
            this.scopes.pop();
        }
        this.#loops.pop();

        this.current = exit;
        this.#endScope(scope);
        this.scopes.pop();
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
            this.seal({kind: "Goto", value: body});
            return;
        }
        const mark = this.temporaries.length;
        const cond = this.#condition(expression);
        if (cond === undefined) {
            return;
        }
        this.#branchEndingTemporaries(cond, mark, body, exit);
    }

    #expressionStatement(statement: ts.ExpressionStatement): void {
        this.fullExpression(() => {
            this.#expressionValue(statement.expression);
        });
    }

    /** Lower an expression whose value is discarded. */
    #expressionValue(expression: ts.Expression): void {
        if (ts.isCallExpression(expression)) {
            this.value(expression, undefined);
            return;
        }
        if (ts.isBinaryExpression(expression)) {
            const kind = expression.operatorToken.kind;
            if (kind === ts.SyntaxKind.EqualsToken) {
                this.#assignment(expression);
                return;
            }
            const compound = COMPOUND_TOKENS[kind];
            if (compound !== undefined) {
                this.#compoundAssignment(expression, compound);
                return;
            }
        }
        // `i++` and `++i` differ only in the value they produce, and a statement
        // discards it — so in this position they are the same update, and the
        // distinction never has to be lowered. It reappears in value position,
        // which is where `#unary` still refuses them.
        if (
            ts.isPrefixUnaryExpression(expression) &&
            (expression.operator === ts.SyntaxKind.PlusPlusToken ||
                expression.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
            this.#incrementDecrement(
                expression,
                expression.operand,
                expression.operator === ts.SyntaxKind.PlusPlusToken,
            );
            return;
        }
        if (ts.isPostfixUnaryExpression(expression)) {
            this.#incrementDecrement(
                expression,
                expression.operand,
                expression.operator === ts.SyntaxKind.PlusPlusToken,
            );
            return;
        }
        this.outer.unsupported(expression, "this expression as a statement");
    }

    /**
     * `a += b`, and every operator that has a compound form.
     *
     * Not a desugaring to `a = a + b`: the target is resolved to a place **once**
     * and then read and written through, so `xs[next()] += 1` advances `next`
     * once. Writing it as a desugaring is the version that looks obviously
     * correct and evaluates the subscript twice.
     */
    #compoundAssignment(expression: ts.BinaryExpression, operator: Operator): void {
        const target = this.#targetPlace(expression.left);
        if (target === undefined) {
            return;
        }
        const info = OPERATORS[operator];
        this.#updateInPlace(
            expression.operatorToken,
            target,
            operator,
            `${operator}=`,
            (type) =>
                // A shift count converts to the value's type rather than promoting it,
                // exactly as in `#binary`: `x <<= someI64` still shifts an `x`-wide
                // value (REWRITE-PLAN §7).
                info.shift
                    ? this.#shiftCount(expression.right, type)
                    : this.#expression(expression.right, type),
        );
    }

    /** `a++`, `a--`, `++a`, `--a` — an update by one. */
    #incrementDecrement(at: ts.Node, operand: ts.Expression, increment: boolean): void {
        const target = this.#targetPlace(operand);
        if (target === undefined) {
            return;
        }
        const spelling = increment ? "++" : "--";
        this.#updateInPlace(at, target, increment ? "+" : "-", spelling, (type) =>
            this.#oneOf(at, type),
        );
    }

    /**
     * The place an assignment target denotes, resolved exactly once.
     *
     * A read-modify-write needs an address it can both read and store through,
     * and needs it computed a single time. {@link #elementPlace} has already
     * materialised a computed subscript into a local, so reusing the `Place` it
     * hands back re-reads that local rather than evaluating the index again.
     */
    #targetPlace(target: ts.Expression): { place: Place; type: MachineType } | undefined {
        if (ts.isParenthesizedExpression(target)) {
            return this.#targetPlace(target.expression);
        }

        if (ts.isIdentifier(target)) {
            const binding = this.scopes.lookup(target.text);
            if (binding === undefined) {
                this.outer.unsupported(target, "updating a non-local name");
                return undefined;
            }
            // The update reads the binding before it writes it, so a moved-from
            // local is as unreadable here as it is anywhere else.
            if (this.#readMoved(target, binding.local, target.text)) {
                return undefined;
            }
            return {place: bindingPlace(binding), type: binding.type};
        }

        if (ts.isElementAccessExpression(target)) {
            const element = this.#elementPlace(target);
            if (element === undefined) {
                return undefined;
            }
            return {place: element.place, type: element.element};
        }

        if (ts.isPropertyAccessExpression(target)) {
            // An accessor is a call to read and a call to write, not an address.
            // Updating one in place is a get, an operator and a set — a different
            // lowering from this one, and not written yet. Saying that is more use
            // than reporting that it is not a place.
            if (
                this.staticAccessorAt(target, true) !== undefined ||
                this.staticAccessorAt(target, false) !== undefined
            ) {
                this.outer.unsupported(target, "updating a static accessor in place");
                return undefined;
            }
            const subject = this.value(target.expression, undefined);
            if (subject === undefined) {
                return undefined;
            }
            const asClass = this.asClass(subject);
            if (
                asClass !== undefined &&
                (asClass.info.setters.has(target.name.text) ||
                    asClass.info.getters.has(target.name.text))
            ) {
                this.outer.unsupported(target, "updating an accessor in place");
                return undefined;
            }
            return this.#fieldPlaceOf(target, subject, asClass);
        }

        this.outer.unsupported(target, "updating this expression");
        return undefined;
    }

    /**
     * `place op= value` — the read-modify-write that `+=` and `++` both reduce
     * to.
     *
     * The operand type is the **target's**, never one promoted from the two
     * sides: `someU8 += 300` is a `u8` addition, because the place it lands in
     * is eight bits wide and writing the update in this form widens nothing.
     */
    #updateInPlace(
        at: ts.Node,
        target: { place: Place; type: MachineType },
        operator: Operator,
        spelling: string,
        rhs: (type: Extract<MachineType, { kind: "scalar" }>) => Operand | undefined,
    ): void {
        const type = target.type;
        // Every operator with a compound form is arithmetic or bitwise, and both
        // are defined on the numeric widths alone. A `string`, a reference or a
        // struct reaching Cranelift as an `Add` is precisely the backend failure
        // REWRITE-PLAN §8 says must not be reachable from source.
        if (type.kind !== "scalar") {
            this.outer.error(
                at,
                "GF0002",
                `\`${spelling}\` works on the numeric widths; this is \`${renderType(type)}\`.`,
            );
            return;
        }
        if (OPERATORS[operator].integerOnly && isFloatType(type)) {
            this.outer.error(
                at,
                "GF0162",
                `\`${operator}\` is defined on integers; this operand is \`${type.name}\`.`,
            );
            return;
        }

        const value = rhs(type);
        if (value === undefined) {
            return;
        }

        this.push({
            kind: "Assign",
            place: target.place,
            rvalue: {
                kind: "Binary",
                op: MIR_OPS[operator],
                // A scalar is trivial, so reading the place is a register read that
                // leaves the value in place for the store that follows it.
                lhs: {kind: "Copy", value: target.place},
                rhs: value,
            },
        });
    }

    /** The `1` that `++` and `--` apply, at the width of what they update. */
    #oneOf(at: ts.Node, type: Extract<MachineType, { kind: "scalar" }>): Operand {
        const ty = this.outer.tyOf(type, at);
        if (isFloatType(type)) {
            const bits =
                type.name === "f32"
                    ? BigInt(new Uint32Array(new Float32Array([1]).buffer)[0]!)
                    : new BigUint64Array(new Float64Array([1]).buffer)[0]!;
            return {kind: "Const", value: {kind: "Float", bits, ty}};
        }
        return {kind: "Const", value: {kind: "Int", bits: 1n, ty}};
    }

    #assignment(expression: ts.BinaryExpression): void {
        if (ts.isPropertyAccessExpression(expression.left)) {
            this.#fieldAssignment(expression.left, expression.right);
            return;
        }
        if (ts.isElementAccessExpression(expression.left)) {
            const target = this.#elementPlace(expression.left);
            if (target === undefined) {
                return;
            }
            const value = this.expressionTyped(expression.right, target.element);
            if (value === undefined) {
                return;
            }
            // `Assign`: the element holds a live value, and for an owning element
            // that value is destroyed before the new one lands.
            this.push({
                kind: "Assign",
                place: target.place,
                rvalue: {kind: "Use", value: this.forStorage(value)},
            });
            return;
        }
        if (!ts.isIdentifier(expression.left)) {
            this.outer.unsupported(expression.left, "assigning to anything but a local");
            return;
        }
        const binding = this.scopes.lookup(expression.left.text);
        if (binding === undefined) {
            this.outer.unsupported(expression.left, "assigning to a non-local name");
            return;
        }
        const value = this.expressionTyped(expression.right, binding.type);
        if (value === undefined) {
            return;
        }
        // `Assign`, not `Init`: the destination holds a live value, and for an
        // owning type that value has to be destroyed before the new one lands.
        this.push({
            kind: "Assign",
            place: bindingPlace(binding),
            rvalue: {kind: "Use", value: this.forStorage(value)},
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
        // `C.x = v` where `x` is `static set x(v)`. First, because `C` is a class
        // name rather than an object and asking it for a value reports a name that
        // does not resolve.
        const staticSet = this.staticAccessorAt(target, true);
        if (staticSet !== undefined) {
            this.staticAccessorCall(target, staticSet.accessor, [source]);
            return;
        }
        const staticGet = this.staticAccessorAt(target, false);
        if (staticGet !== undefined) {
            this.outer.error(
                target,
                "GF0002",
                `\`${staticGet.info.name}.${target.name.text}\` is a static getter with no ` +
                `setter, so it can be read and not written. Add ` +
                `\`static set ${target.name.text}(value)\` if it should be.`,
            );
            return;
        }

        const subject = this.value(target.expression, undefined);
        if (subject === undefined) {
            return;
        }

        const asClass = this.asClass(subject);
        // `x.name = v` where `name` is a setter: a call, not a store. Checked
        // before the field lookup because a name is one or the other — declaring
        // both is refused where the class is analysed.
        const setter = asClass?.info.setters.get(target.name.text);
        if (setter !== undefined) {
            this.#accessorCall(target, setter, [source]);
            return;
        }

        const resolved = this.#fieldPlaceOf(target, subject, asClass);
        if (resolved === undefined) {
            return;
        }
        const value = this.expressionTyped(source, resolved.type);
        if (value === undefined) {
            return;
        }
        // `Assign` even inside a constructor, and it is safe there because
        // `Default` zeroed the object first: releasing a zeroed owning field is a
        // no-op all the way down (`gf_string_free(null)` returns).
        this.push({
            kind: "Assign",
            place: resolved.place,
            rvalue: {kind: "Use", value: this.forStorage(value)},
        });
    }

    /**
     * The place `p.x` denotes, given its already-evaluated subject.
     *
     * Shared by the two things that write a field: an assignment, which stores
     * once, and a compound assignment, which reads and stores through the same
     * address. The subject arrives evaluated so that neither of them evaluates
     * it twice — and so that both agree on which projection reaches the field,
     * which is the kind of thing that goes wrong once it is written down twice.
     */
    #fieldPlaceOf(
        target: ts.PropertyAccessExpression,
        subject: Typed,
        asClass: { info: ClassInfo; place: Place } | undefined,
    ): { place: Place; type: MachineType } | undefined {
        // `p.x` through a `Pointer<S>`: one dereference, then the field. A class
        // goes down the `#asClass` path below, which already sees through a
        // pointer; a struct has no such path and needs this.
        if (subject.type.kind === "pointer" && subject.type.pointee.kind === "struct") {
            const struct = subject.type.pointee;
            const index = this.fieldIndex(struct, target.name.text);
            const field = struct.fields[index];
            if (field === undefined) {
                this.outer.unsupported(target, `the field \`${target.name.text}\``);
                return undefined;
            }
            const place = this.placeOfSubject(target, subject);
            if (place === undefined) {
                return undefined;
            }
            return {
                place: {
                    local: place.local,
                    projection: [
                        ...place.projection,
                        {kind: "Deref"},
                        {kind: "Field", value: FieldId(index)},
                    ],
                },
                type: field.type,
            };
        }

        if (asClass !== undefined) {
            const field = this.#fieldOf(asClass.info, target.name.text);
            if (field === undefined) {
                // A getter with no setter reads but does not write, and saying which is
                // more use than saying the name is unknown.
                if (asClass.info.getters.has(target.name.text)) {
                    this.outer.error(
                        target,
                        "GF0002",
                        `\`${asClass.info.name}.${target.name.text}\` is a getter with no ` +
                        "setter, so it can be read and not written. Add `set " +
                        `${target.name.text}(value)\` if it should be.`,
                    );
                    return undefined;
                }
                this.outer.unsupported(target, `\`${asClass.info.name}.${target.name.text}\``);
                return undefined;
            }
            return {
                place: {
                    local: asClass.place.local,
                    projection: [
                        ...asClass.place.projection,
                        {kind: "Field", value: FieldId(field.index)},
                    ],
                },
                type: field.type,
            };
        }

        // Assigning *through* an address: `p.x = 1` where `p` is a
        // `Reference<Point>` or a `Pointer<Point>` writes the caller's struct,
        // which is the whole reason to have passed one. A reference has no
        // `const` half — `this` is one and every method that sets a field
        // writes through it.
        const behind = behindOneIndirection(subject.type);
        const struct = behind ?? subject.type;
        if (struct.kind !== "struct") {
            this.outer.unsupported(target, "assigning to this property");
            return undefined;
        }
        const index = this.fieldIndex(struct, target.name.text);
        const field = struct.fields[index];
        if (field === undefined) {
            this.outer.unsupported(target, `the field \`${target.name.text}\``);
            return undefined;
        }
        const place = this.placeOfSubject(target, subject);
        if (place === undefined) {
            return undefined;
        }
        const base =
            behind === undefined
                ? place.projection
                : [...place.projection, {kind: "Deref" as const}];
        return {
            place: {
                local: place.local,
                projection: [...base, {kind: "Field", value: FieldId(index)}],
            },
            type: field.type,
        };
    }

    /** Lower an expression to an operand of exactly `expected`. */
    #expression(expression: ts.Expression, expected: MachineType): Operand | undefined {
        return this.expressionTyped(expression, expected)?.operand;
    }

    /** As {@link #expression}, keeping the temporary marker the caller may need. */
    protected override expressionTyped(expression: ts.Expression, expected: MachineType): Typed | undefined {
        const value = this.value(expression, expected);
        if (value === undefined) {
            return undefined;
        }
        return this.coerce(expression, value, expected);
    }

    /** Lower an expression that must produce a `bool`. */
    #condition(expression: ts.Expression): Operand | undefined {
        const width = this.width(expression);
        if (width.kind === "error") {
            return undefined;
        }
        if (width.kind === "poly" || width.type.kind !== "bool") {
            const shown = width.kind === "poly" ? "a number" : `\`${renderType(width.type)}\``;
            this.outer.error(
                expression,
                "GF0002",
                `a condition must be a \`boolean\`; this is ${shown}. There is no ` +
                "truthiness here — write the comparison you mean.",
            );
            return undefined;
        }
        return this.#expression(expression, {kind: "bool"});
    }

    /**
     * Convert a lowered value to the type its context wants.
     *
     * A widening is an explicit `Cast` in the MIR, never an assumption; a
     * narrowing is `GF0160`, because the truncation is invisible at the point it
     * costs you.
     */
    protected override coerce(at: ts.Node, value: Typed, expected: MachineType): Typed | undefined {
        if (sameType(value.type, expected)) {
            return value;
        }

        // The conversion site, and the only one. A class becomes a contract by
        // building `(itab, &object)` — a *borrow*, so the object stays owned by
        // whoever owned it and the pair is never destroyed.
        if (expected.kind === "interface" && value.type.kind === "class") {
            return this.#toInterface(at, value, expected);
        }
        // `x` → `Reference<X>`: borrow it rather than copy it. A borrow and not a
        // conversion, so what it points at stays the caller's and nothing is
        // cloned — which is the whole reason to write the reference.
        //
        // The referent has to be *the same type*, not a convertible one. A
        // reference is an address, and the bytes at that address are whatever
        // the caller put there; converting first would produce a temporary and
        // hand back its address, so the callee would be writing into something
        // nobody can see. `Reference<Base>` from a `Derived` is the one
        // exception that *is* wanted, and it has its own case below because it
        // is a fact about class layout rather than about references.
        //
        // What this costs when it does not fire is a copy, which is exactly
        // what the signature said: passing an array by value is
        // `std::vector<T>` by value — correct, and a whole buffer.
        if (expected.kind === "reference" && sameType(value.type, expected.referent)) {
            const place = this.placeOfSubject(at, value);
            if (place === undefined) {
                return undefined;
            }
            const operand = this.refTo(at, place, value.type);
            return value.temporary === undefined
                ? {operand, type: expected}
                : {operand, type: expected, borrowsTemporary: true};
        }
        // `Pointer<Derived>` → `Pointer<Base>`: the same address, retyped.
        //
        // Costs nothing because a base is a byte-for-byte layout prefix of every
        // class that derives from it, so the object's address *is* the base
        // subobject's address. This is what makes polymorphism through a pointer
        // work — and it is exactly as unsound as `Derived**` to `Base**` is in C++,
        // which is the trade the prelude states when it makes `CorePointer<T>`
        // covariant.
        if (
            expected.kind === "pointer" &&
            value.type.kind === "pointer" &&
            expected.pointee.kind === "class" &&
            value.type.pointee.kind === "class" &&
            this.outer.derivesFrom(value.type.pointee.name, expected.pointee.name)
        ) {
            return {operand: value.operand, type: expected};
        }
        // `Pointer<T>` → `Pointer<unknown>`: C's implicit `T *` → `void *`, and the
        // same non-event at runtime — one word, unchanged, relabelled.
        //
        // Implicit in this direction only, which is the asymmetry C and C++ both
        // have and for the same reason: throwing the type away cannot be wrong,
        // where guessing it back can. `void *` → `Pointer<T>` is refused by tsc
        // before it reaches here, and `reify` is where that direction is written.
        //
        // It is what makes a binding usable at all. `SDL_memcpy(dst, src, n)` takes
        // whatever pointers the program has, and `surface.pixels = frame` assigns
        // through a `void *` field, neither of them growing a conversion that says
        // nothing the C header did not already say.
        if (
            expected.kind === "pointer" &&
            expected.pointee.kind === "void" &&
            value.type.kind === "pointer"
        ) {
            return {operand: value.operand, type: expected};
        }
        // `FixedArray<T, N>` → `Pointer<T>`: C's array-to-pointer decay.
        //
        // **An `AddrOf` of the array's place, not a retype of a value.** A fixed
        // array *is* the bytes — that is the whole difference between it and a
        // pointer — so what a pointer to it needs is the address of where those
        // bytes live. Retyping the operand would hand back whatever the operand
        // was, which for an array travelling by address is the same word by luck
        // rather than by rule.
        //
        // To its own element type or to `void`, and to nothing else. That is C's
        // rule exactly, and it is also all tsc permits: `FixedArray<T, N>` extends
        // `CorePointer<T>`, so the width brands keep `Pointer<u8>` and
        // `Pointer<i32>` apart before this is reached.
        if (
            expected.kind === "pointer" &&
            value.type.kind === "fixedArray" &&
            (expected.pointee.kind === "void" || sameType(expected.pointee, value.type.element))
        ) {
            const place = this.placeOfSubject(at, value);
            if (place === undefined) {
                return undefined;
            }
            const decayed = this.temporaryTyped(at, expected, {kind: "AddrOf", value: place});
            if (decayed === undefined) {
                return undefined;
            }
            // The same lifetime rule a borrow gets, for the same reason: a pointer to
            // a temporary array is fine as an argument, because the call finishes
            // inside the enclosing full-expression, and is a dangling binding if it
            // outlives one. `GF0234` is where that is caught.
            return value.temporary === undefined ? decayed : {...decayed, borrowsTemporary: true};
        }
        if (expected.kind === "reference" && expected.referent.kind === "class") {
            return this.#toClassReference(at, value, expected.referent.name);
        }
        if (expected.kind === "class" && value.type.kind === "class") {
            return this.#slice(at, value, expected);
        }

        if (fits(value.type, expected)) {
            const kind = this.castKind(at, value.type, expected);
            if (kind === undefined) {
                return undefined;
            }
            return this.temporaryTyped(at, expected, {
                kind: "Cast",
                op: kind,
                operand: value.operand,
                to: this.outer.tyOf(expected, at),
            });
        }

        const narrowing =
            value.type.kind === "scalar" && expected.kind === "scalar" && fits(expected, value.type);

        this.outer.error(
            at,
            narrowing ? "GF0160" : "GF0161",
            narrowing
                ? `this is a \`${renderType(value.type)}\` and \`${renderType(expected)}\` ` +
                `is narrower, so the conversion can lose the value. Write ` +
                `\`cast<${renderType(expected)}>(…)\` if that is what you mean.`
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
        if (value.type.kind !== "class") {
            return undefined;
        }
        if (!this.outer.implement(value.type.name, contract, at)) {
            return undefined;
        }

        const interfaceId = this.outer.interfaceId(layoutKey(contract));
        const classId = this.outer.classId(value.type.name);
        if (interfaceId === undefined || classId === undefined) {
            return undefined;
        }

        const source = this.placeOfSubject(at, value);
        if (source === undefined) {
            return undefined;
        }

        const local = this.f.addLocal({
            ty: this.outer.tyOf(contract, at),
            storage: "Temporary",
            span: this.outer.span(at),
        });
        this.push({kind: "StorageLive", value: local});
        this.push({
            kind: "Init",
            place: placeOf(local),
            rvalue: {kind: "MakeInterface", interface: interfaceId, class: classId, source},
        });
        // `Copy`, not `Move`: the pair is two borrowed words, trivially copied, and
        // reading it does not end anything.
        return {operand: {kind: "Copy", value: placeOf(local)}, type: contract};
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
        if (value.type.kind !== "class") {
            return undefined;
        }

        const info = this.outer.classInfo(value.type.name);
        let base = info;
        while (base !== undefined && base.name !== expected.name) {
            base = base.base;
        }
        if (base === undefined) {
            // tsc rejects an unrelated class first; this is the check that keeps the
            // backend from being the one that notices if it ever does not.
            this.outer.error(
                at,
                "GF0002",
                `\`${value.type.name}\` is not a \`${expected.name}\`, so there is no ` +
                "conversion between them.",
            );
            return undefined;
        }

        const source = this.placeOfSubject(at, value);
        if (source === undefined) {
            return undefined;
        }

        const local = this.f.addLocal({
            ty: this.outer.tyOf(expected, at),
            storage: "Temporary",
            span: this.outer.span(at),
        });
        this.push({kind: "StorageLive", value: local});
        this.push({
            kind: "Init",
            place: placeOf(local),
            rvalue: {kind: "Use", value: {kind: "Copy", value: source}},
        });
        this.temporaries.push(local);
        return {operand: {kind: "Copy", value: placeOf(local)}, type: expected, temporary: local};
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
            referent: {kind: "class", name: className},
        };

        // Already a reference: an upcast, and nothing but a retype.
        if (value.type.kind === "reference" && value.type.referent.kind === "class") {
            return {operand: value.operand, type};
        }
        if (value.type.kind !== "class") {
            return undefined;
        }

        const place = this.placeOfSubject(at, value);
        if (place === undefined) {
            return undefined;
        }
        const operand = this.refTo(at, place, value.type);
        // Borrowing a temporary is fine *here* — it lives to the end of the
        // enclosing full-expression, so a call completes inside its lifetime.
        // Only a binding would outlive it, and that is where this is checked.
        return value.temporary === undefined
            ? {operand, type}
            : {operand, type, borrowsTemporary: true};
    }

    protected override castKind(at: ts.Node, from: MachineType, to: MachineType): CastKind | undefined {
        if (from.kind === "bool" && isIntegerType(to)) {
            return "BoolToInt";
        }
        if (isIntegerType(from) && isIntegerType(to)) {
            return "IntToInt";
        }
        if (isIntegerType(from) && isFloatType(to)) {
            return "IntToFloat";
        }
        if (isFloatType(from) && isIntegerType(to)) {
            return "FloatToInt";
        }
        if (isFloatType(from) && isFloatType(to)) {
            return "FloatToFloat";
        }

        this.outer.error(
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
    protected override value(expression: ts.Expression, expected: MachineType | undefined): Typed | undefined {
        if (ts.isParenthesizedExpression(expression)) {
            return this.value(expression.expression, expected);
        }

        // Before the width answer is consulted, because `null` has no width to
        // report on and the message for a missing one would name the wrong thing.
        if (expression.kind === ts.SyntaxKind.NullKeyword) {
            return this.#null(expression, expected);
        }

        // Also before the width pass, and for the same shape of reason: a lambda
        // has no type of its own here. `(x) => x * 2` is a `LocalFn` or it is
        // nothing, and which one it is comes from the parameter it is being passed
        // to — so the expected type is the only thing that can answer, and asking
        // the width pass first would report an expression it cannot type.
        if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
            return this.#closure(expression, expected);
        }

        const width = this.width(expression);
        if (width.kind === "error") {
            return undefined;
        }
        const natural = width.kind === "typed" ? width.type : expected;

        if (natural === undefined) {
            this.outer.error(
                expression,
                "GF0161",
                "this expression is built only from literals, so it has no width, and " +
                "nothing here supplies one. Annotate the binding or convert with " +
                "`cast`.",
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
                    value: this.strConst(expression.text),
                },
                type: STRING,
            };
        }

        if (ts.isTemplateExpression(expression)) {
            return this.#template(expression);
        }
        // `identity<i32>` — one instantiation's address. Unambiguous, so it is
        // answered before anything asks what the bare name is worth: `identity`
        // on its own has no address, and the diagnostic for that would be the
        // wrong complaint about a program that named the body perfectly well.
        if (ts.isExpressionWithTypeArguments(expression)) {
            return this.#instantiatedValue(expression, natural);
        }
        if (ts.isPropertyAccessExpression(expression)) {
            return this.#propertyValue(expression, natural);
        }
        if (ts.isObjectLiteralExpression(expression)) {
            return this.#objectLiteral(expression, natural);
        }
        if (ts.isArrayLiteralExpression(expression)) {
            return this.#arrayLiteral(expression, natural);
        }
        if (ts.isElementAccessExpression(expression)) {
            return this.#elementAccess(expression);
        }

        if (expression.kind === ts.SyntaxKind.TrueKeyword) {
            return {operand: {kind: "Const", value: this.boolConst(true)}, type: natural};
        }
        if (expression.kind === ts.SyntaxKind.FalseKeyword) {
            return {operand: {kind: "Const", value: this.boolConst(false)}, type: natural};
        }

        if (ts.isIdentifier(expression)) {
            const binding = this.scopes.lookup(expression.text);
            if (binding === undefined) {
                return this.functionValue(expression, natural);
            }
            if (this.#readMoved(expression, binding.local, expression.text)) {
                return undefined;
            }
            // For a trivial type copy and move lower identically, and the frontend
            // still says which one it means. `Copy` is right here: reading a binding
            // does not end it.
            return {operand: {kind: "Copy", value: bindingPlace(binding)}, type: binding.type};
        }

        if (expression.kind === ts.SyntaxKind.ThisKeyword) {
            return this.#thisTyped(expression);
        }
        if (ts.isNewExpression(expression)) {
            return this.#new(expression);
        }
        if (ts.isConditionalExpression(expression)) {
            return this.#conditional(expression, natural);
        }
        if (ts.isPrefixUnaryExpression(expression)) {
            return this.#unary(expression, natural);
        }
        if (ts.isBinaryExpression(expression)) {
            return this.#binary(expression, natural);
        }
        if (ts.isCallExpression(expression)) {
            return this.#call(expression, natural);
        }

        this.outer.unsupported(expression, describe(expression));
        return undefined;
    }

    /**
     * `null` — the null value of whichever handle the context wants.
     *
     * It reaches the backend as `Const::Null`, which is a machine word of zero
     * whatever type it carries. That is the whole reason the set below is closed:
     * a `string` and a `T[]` are one word too, but they are *owning* handles, and
     * a zero one would be freed at the end of its scope like any other. A
     * contract reference is not one word at all.
     *
     * Nullability itself never reaches the MIR. `Pointer<T> | null` erases to the
     * same machine type as `Pointer<T>` — the null is representable in the value
     * — so it stays tsc's view of the program, and tsc is what makes the check
     * before the use.
     */
    #null(at: ts.Expression, expected: MachineType | undefined): Typed | undefined {
        if (expected === undefined) {
            this.outer.error(
                at,
                "GF0161",
                "`null` has no type of its own and nothing here supplies one. Annotate " +
                "what it is the null of — `const w: Pointer<SDL_Window> | null = null`.",
            );
            return undefined;
        }
        if (!hasNullValue(expected)) {
            this.outer.error(
                at,
                "GF0237",
                `\`${renderType(expected)}\` has no null. ${nullAdvice(expected)}`,
            );
            return undefined;
        }
        return {
            operand: {
                kind: "Const",
                value: {kind: "Null", value: this.outer.tyOf(expected, at)},
            },
            type: expected,
        };
    }

    #literal(
        literal: ts.NumericLiteral,
        type: MachineType,
        negated: boolean,
    ): Typed | undefined {
        if (type.kind !== "scalar") {
            this.outer.error(
                literal,
                "GF0161",
                `a numeric literal cannot be a \`${renderType(type)}\`.`,
            );
            return undefined;
        }

        const ty = this.outer.tyOf(type, literal);
        // The literal's *text*, with digit separators removed. `1_000` is ordinary
        // TypeScript, and neither `Number` nor `BigInt` will take the underscores.
        const text = literalDigits(literal.getText());

        if (rangeOf(type.name) === null) {
            const value = Number(text) * (negated ? -1 : 1);
            const bits =
                type.name === "f32"
                    ? BigInt(new Uint32Array(new Float32Array([value]).buffer)[0]!)
                    : new BigUint64Array(new Float64Array([value]).buffer)[0]!;
            return {operand: {kind: "Const", value: {kind: "Float", bits, ty}}, type};
        }

        // An integer width takes an integer literal, and nothing else. `1.5` is the
        // obvious case; `1e3` is the one worth a message of its own, because it is
        // exactly a thousand and is still refused — accepting it would be the
        // silent float-to-integer conversion the language rejects everywhere else.
        if (!isIntegerLiteral(text)) {
            this.outer.error(
                literal,
                "GF0164",
                `\`${literal.getText()}\` is a floating-point literal and \`${type.name}\` ` +
                `holds integers. Write the integer, or convert with ` +
                `\`cast<${type.name}>(…)\` where the truncation is meant.`,
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
            this.outer.error(
                literal,
                "GF0164",
                `${negated ? "-" : ""}${magnitude} does not fit in \`${type.name}\`, ` +
                `whose range is ${range.min} to ${range.max}.`,
            );
            return undefined;
        }
        return {operand: {kind: "Const", value: {kind: "Int", bits: check.bits, ty}}, type};
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
                        value: this.strConst(expression.head.text),
                    },
                    type: STRING,
                };

        const append = (piece: Typed): void => {
            result =
                result === undefined
                    ? piece
                    : this.temporaryTyped(expression, STRING, {
                        kind: "Binary",
                        op: "Add",
                        // Borrows, not copies: concatenation reads its operands and
                        // allocates a fresh result. Cloning them first allocates twice
                        // and leaves the first pair to nobody.
                        lhs: this.forRead(result),
                        rhs: this.forRead(piece),
                    });
        };

        for (const span of expression.templateSpans) {
            const value = this.value(span.expression, undefined);
            if (value === undefined) {
                return undefined;
            }
            const text = this.#toStringValue(span.expression, value);
            if (text === undefined) {
                return undefined;
            }
            append(text);

            if (span.literal.text.length > 0) {
                append({
                    operand: {
                        kind: "Const",
                        value: this.strConst(span.literal.text),
                    },
                    type: STRING,
                });
            }
        }

        return (
            result ?? {
                operand: {kind: "Const", value: this.strConst("")},
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
        if (value.type.kind === "string") {
            return value;
        }

        if (value.type.kind === "bool") {
            return this.callRuntime(at, RUNTIME.fromBool, [value], STRING);
        }

        if (value.type.kind !== "scalar") {
            this.outer.unsupported(at, `converting \`${renderType(value.type)}\` to a string`);
            return undefined;
        }

        // Widened to the runtime's parameter type first, so there is one conversion
        // function per signedness rather than one per width.
        const name = value.type.name;
        if (isFloatType(value.type)) {
            const widened = this.#convert(at, value, {kind: "scalar", name: "f64"});
            return widened && this.callRuntime(at, RUNTIME.fromF64, [widened], STRING);
        }
        const signed = name.startsWith("i");
        const wide: MachineType = {kind: "scalar", name: signed ? "i64" : "u64"};
        const widened = this.#convert(at, value, wide);
        if (widened === undefined) {
            return undefined;
        }
        return this.callRuntime(at, signed ? RUNTIME.fromI64 : RUNTIME.fromU64, [widened], STRING);
    }

    /** An explicit conversion, whether or not the language would allow it implicitly. */
    #convert(at: ts.Expression, value: Typed, to: MachineType): Typed | undefined {
        if (sameType(value.type, to)) {
            return value;
        }
        const kind = this.castKind(at, value.type, to);
        if (kind === undefined) {
            return undefined;
        }
        return this.temporaryTyped(at, to, {
            kind: "Cast",
            op: kind,
            operand: value.operand,
            to: this.outer.tyOf(to, at),
        });
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
            this.outer.error(
                expression,
                "GF0161",
                `an object literal cannot be a \`${renderType(natural)}\`.`,
            );
            return undefined;
        }

        // An `Aggregate` writes every field, and a union has room for one. tsc
        // asks for all of them because it sees an ordinary interface, which is
        // exactly the shape this rule exists to refuse.
        if (natural.union === true) {
            this.outer.error(
                expression,
                "GF0304",
                `\`${natural.name}\` is a union, so an object literal cannot build one — ` +
                `its ${natural.fields.length} members share one piece of storage and a ` +
                "literal supplies them all. Declare it and assign the member you mean: " +
                `\`let value: ${natural.name};\` then \`value.${natural.fields[0]?.name ?? "member"} = …\`.`,
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
                this.outer.unsupported(expression, `an object literal without \`${field.name}\``);
                return undefined;
            }
            const value = this.expressionTyped(property.initializer, field.type);
            if (value === undefined) {
                return undefined;
            }
            values.push(this.forStorage(value));
        }

        return this.temporaryTyped(expression, natural, {
            kind: "Aggregate",
            ty: this.outer.tyOf(natural, expression),
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
            this.outer.error(
                expression,
                "GF0161",
                `an array literal cannot be a \`${renderType(natural)}\`.`,
            );
            return undefined;
        }

        const values: Operand[] = [];
        for (const element of expression.elements) {
            if (ts.isSpreadElement(element)) {
                this.outer.unsupported(element, "a spread element in an array literal");
                return undefined;
            }
            const value = this.expressionTyped(element, natural.element);
            if (value === undefined) {
                return undefined;
            }
            values.push(this.forStorage(value));
        }

        return this.temporaryTyped(expression, natural, {
            kind: "Aggregate",
            ty: this.outer.tyOf(natural, expression),
            fields: values,
        });
    }

    /** `xs[i]` — an element, by address. */
    #elementAccess(expression: ts.ElementAccessExpression): Typed | undefined {
        const target = this.#elementPlace(expression);
        if (target === undefined) {
            return undefined;
        }
        return {operand: {kind: "Copy", value: target.place}, type: target.element};
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
        const subject = this.value(expression.expression, undefined);
        if (subject === undefined) {
            return undefined;
        }

        // `m[0]` and `v[1]` — a field projection rather than an element at a
        // stride, because these are structs (DECISIONS §22). Before the array
        // path because a linear-algebra type is not one.
        const linalg = this.linalgOf(subject.type);
        if (linalg !== undefined) {
            return this.linalgElementPlace(expression, subject, linalg);
        }

        // An array first, so that a `Reference<T[]>` gets the `Deref` that reaches
        // its elements rather than being indexed as though it were the handle.
        const array = this.asArray(expression, subject);
        const element = array?.element ?? elementTypeOf(subject.type);
        if (element === undefined) {
            this.outer.unsupported(expression, `indexing a \`${renderType(subject.type)}\``);
            return undefined;
        }
        // Indexing is `base + i * stride`, and an opaque handle has no stride.
        if (!this.outer.requireKnownLayout(element, expression, "indexing")) {
            return undefined;
        }

        const base = array?.place ?? this.placeOfSubject(expression, subject);
        if (base === undefined) {
            return undefined;
        }

        const argument = expression.argumentExpression;
        // A literal subscript folds into the projection, so a constant index costs
        // no arithmetic at all.
        if (ts.isNumericLiteral(argument) && !/[.eE]/.test(argument.getText())) {
            return {
                place: {
                    local: base.local,
                    projection: [...base.projection, {kind: "ConstIndex", value: BigInt(argument.getText())}],
                },
                element,
            };
        }

        const index = this.expressionTyped(argument, USIZE);
        if (index === undefined) {
            return undefined;
        }
        const slot = this.f.addLocal({
            ty: this.outer.tyOf(USIZE, expression),
            storage: "Temporary",
        });
        this.temporaries.push(slot);
        this.push({kind: "StorageLive", value: slot});
        this.push({
            kind: "Init",
            place: placeOf(slot),
            rvalue: {kind: "Use", value: index.operand},
        });
        return {
            place: {
                local: base.local,
                projection: [...base.projection, {kind: "Index", value: slot}],
            },
            element,
        };
    }

    /**
     * `E.A` — an enum member, which is a constant and not a read.
     *
     * tsc has already folded the value, computed forms included, so `1 << 3` and
     * `Previous + 1` arrive here as numbers. What the enum contributes is the
     * *width*: the one its namespace declares, or `i32`. That is what makes an
     * enum member explicit rather than contextual — it lands at a written width,
     * and narrowing from it is `GF0160` like any other narrowing.
     */
    #enumMember(expression: ts.PropertyAccessExpression): Typed | undefined {
        const width = this.width(expression);
        if (width.kind !== "typed" || width.type.kind !== "scalar") {
            return undefined;
        }

        // Asked of the member's *declaration* rather than of the access. tsc
        // answers `getConstantValue` for an `EnumMember` and returns `undefined`
        // for the `E.A` that names it, which is a silent difference: the constant
        // simply never arrives and the expression lowers to nothing.
        const declaration = this.outer.enumMemberAt(expression);
        if (declaration === undefined) {
            return undefined;
        }
        const value = this.outer.checker.getConstantValue(declaration);
        // A member that is not an integer constant was already reported where the
        // enum was declared, with the member to point at. Saying it again here
        // would be the same mistake twice.
        if (typeof value !== "number" || !Number.isInteger(value)) {
            return undefined;
        }

        // `explicitRadix`, so a member written `0xFFFFFFFF` in an `i32` enum keeps
        // the bit pattern a hex literal would — the declaration check is what
        // decided whether it was allowed.
        const check = checkLiteral(width.type.name, BigInt(value), true);
        if (!check.ok || check.bits === undefined) {
            return undefined;
        }
        return {
            operand: {
                kind: "Const",
                value: {kind: "Int", bits: check.bits, ty: this.outer.tyOf(width.type, expression)},
            },
            type: width.type,
        };
    }

    /** `s.length` on a string, or a field of a struct. */
    #propertyValue(expression: ts.PropertyAccessExpression, natural: MachineType): Typed | undefined {
        // An enum member is a constant, and `E` is a type rather than a value — so
        // this comes before anything tries to ask `E` for one.
        if (this.outer.enumMemberAt(expression) !== undefined) {
            return this.#enumMember(expression);
        }
        // `C.f` — a static method's address, before anything asks `C` for a value.
        if (this.staticAt(expression) !== undefined) {
            return this.functionValue(expression, natural);
        }
        // `ns.f` — a namespace-qualified function's address. Beside the static
        // case and for the same reason: `ns` is no more a value than `C` is, so
        // this has to come before anything asks it for one.
        if (this.outer.namespaceValue(expression) !== undefined) {
            return this.functionValue(expression, natural);
        }
        // `C.x` where `x` is `static get x()`. Also before, and for the same
        // reason: `C` is a class name and has no value to ask for.
        const staticGet = this.staticAccessorAt(expression, false);
        if (staticGet !== undefined) {
            return this.staticAccessorCall(expression, staticGet.accessor, []);
        }
        return this.#property(expression);
    }

    /**
     * `x.name` or `x.name = v` — an accessor, called.
     *
     * A **virtual** call, exactly like a method: an accessor has a vtable slot,
     * so a getter overridden in a derived class is reached through a base
     * reference. The only thing property syntax changes is where the arguments
     * come from — none for a getter, the right-hand side for a setter.
     */
    #accessorCall(
        at: ts.PropertyAccessExpression,
        accessor: ClassMethod,
        args: readonly ts.Expression[],
    ): Typed | undefined {
        const subject = this.value(at.expression, undefined);
        if (subject === undefined) {
            return undefined;
        }
        const asClass = this.asClass(subject);
        if (asClass === undefined) {
            this.outer.unsupported(at, "an accessor on this receiver");
            return undefined;
        }

        const record = this.outer.fn(accessor.symbol);
        if (record === undefined || record.kind !== "defined") {
            this.outer.unsupported(at, `a call to \`${accessor.symbol}\``);
            return undefined;
        }

        const marshalled = this.classCallArgs(
            at,
            asClass.info,
            accessor.symbol,
            args,
            this.refTo(at, asClass.place, {kind: "class", name: asClass.info.name}),
        );
        if (marshalled === undefined || marshalled === null) {
            return undefined;
        }

        return this.emitCall(
            at,
            {kind: "Virtual", slot: accessor.slot, sig: record.sig},
            marshalled,
            record.signature.returns,
        );
    }

    #property(expression: ts.PropertyAccessExpression): Typed | undefined {
        // `p.address` — the bits, as a number. First, for the reason the width pass
        // takes it first: `Pointer<C>` is `C & CorePointer<C>`, and a field of the
        // pointee would otherwise win.
        if (expression.name.text === POINTER_ADDRESS) {
            const pointer = this.tryErase(expression.expression);
            if (pointer?.kind === "pointer") {
                const subject = this.value(expression.expression, undefined);
                if (subject === undefined) {
                    return undefined;
                }
                return this.temporaryTyped(expression, USIZE, {
                    kind: "Cast",
                    op: "PtrToInt",
                    operand: this.forRead(subject),
                    to: this.outer.tyOf(USIZE, expression),
                });
            }
        }

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
                            ty: this.outer.tyOf(USIZE, expression),
                        },
                    },
                    type: USIZE,
                };
            }
        }

        // `x.name` where `name` is a getter: an ordinary virtual call, dispatched
        // like any method, so `override get` reaches the derived body.
        const className = this.outer.classNameAt(expression.expression, this.bindings);
        const getter =
            className === undefined
                ? undefined
                : this.outer.classInfo(className)?.getters.get(expression.name.text);
        if (getter !== undefined) {
            return this.#accessorCall(expression, getter, []);
        }

        const subject = this.value(expression.expression, undefined);
        if (subject === undefined) {
            return undefined;
        }

        const asClass = this.asClass(subject);
        if (asClass !== undefined) {
            const field = this.#fieldOf(asClass.info, expression.name.text);
            if (field === undefined) {
                this.outer.unsupported(
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
                        projection: [...asClass.place.projection, {kind: "Field", value: FieldId(field.index)}],
                    },
                },
                type: field.type,
            };
        }

        // A `Pointer<S>` and a `Reference<S>` both reach the struct in one
        // dereference, and neither writes it — the auto-dereference C++ spells
        // `->` for the first and nothing at all for the second.
        const behind = behindOneIndirection(subject.type);
        const pointedTo = behind ?? subject.type;
        if (pointedTo.kind === "struct") {
            const index = this.fieldIndex(pointedTo, expression.name.text);
            const field = pointedTo.fields[index];
            if (field === undefined) {
                this.outer.unsupported(expression, `the field \`${expression.name.text}\``);
                return undefined;
            }
            const place = this.placeOfSubject(expression, subject);
            if (place === undefined) {
                return undefined;
            }
            // Through the indirection first, when there is one.
            const base =
                behind === undefined
                    ? place.projection
                    : [...place.projection, {kind: "Deref" as const}];
            return {
                operand: {
                    kind: "Copy",
                    value: {local: place.local, projection: [...base, {kind: "Field", value: FieldId(index)}]},
                },
                type: field.type,
            };
        }

        if (expression.name.text === "length") {
            // An array — possibly behind a reference — reads its length from the
            // handle, so the place is the one `#asArray` resolves.
            const array = this.asArray(expression, subject);
            if (array !== undefined) {
                return this.temporaryTyped(expression, USIZE, {kind: "Len", value: array.place});
            }
            if (subject.type.kind === "string" || subject.type.kind === "cstring") {
                const read = this.forRead(subject);
                if (read.kind === "Const") {
                    this.outer.unsupported(expression, "`length` of a literal");
                    return undefined;
                }
                return this.temporaryTyped(expression, USIZE, {kind: "Len", value: read.value});
            }
        }

        this.outer.unsupported(expression, "this property access");
        return undefined;
    }

    /**
     * `identity<i32>` as a value: the address of that one instantiation.
     *
     * The same `Const`/`Func` an ordinary function's address is — the
     * instantiation has a `FuncId` like any other function, because by the time
     * this runs it *is* an ordinary function. What made it needs saying only
     * here.
     */
    #instantiatedValue(
        expression: ts.ExpressionWithTypeArguments,
        natural: MachineType,
    ): Typed | undefined {
        const target = this.outer.instantiatedValue(expression, this.bindings);
        if (target === undefined || target === "reported") {
            if (target === undefined) {
                this.outer.unsupported(expression, "type arguments on something not generic");
            }
            return undefined;
        }
        if (natural.kind !== "fnptr" || target.kind !== "defined") {
            this.outer.error(
                expression,
                "GF0161",
                "this names one instantiation of a generic, so it is a code address; " +
                `it cannot be a \`${renderType(natural)}\`.`,
            );
            return undefined;
        }
        return {
            operand: {
                kind: "Const",
                value: {
                    kind: "Func",
                    func: {kind: "Local", value: target.id},
                    ty: this.outer.tyOf(natural, expression),
                },
            },
            type: natural,
        };
    }

    /**
     * The place a lowered value occupies, for projecting into.
     *
     * A field access needs an address, and a constant has none — which is why an
     * aggregate literal is materialised into a temporary before anything reaches
     * into it.
     */
    protected override placeOfSubject(at: ts.Node, subject: Typed): Place | undefined {
        if (subject.operand.kind === "Const") {
            this.outer.unsupported(at, "reaching into a constant");
            return undefined;
        }
        return subject.operand.value;
    }

    #unary(expression: ts.PrefixUnaryExpression, natural: MachineType): Typed | undefined {
        const operand = expression.operand;

        if (expression.operator === ts.SyntaxKind.ExclamationToken) {
            const inner = this.#condition(operand);
            if (inner === undefined) {
                return undefined;
            }
            return this.temporaryTyped(expression, {kind: "bool"}, {
                kind: "Unary",
                op: "Not",
                operand: inner,
            });
        }

        if (expression.operator === ts.SyntaxKind.PlusToken) {
            return this.value(operand, natural);
        }

        if (expression.operator === ts.SyntaxKind.MinusToken) {
            // The unsigned rule comes *first*, before the literal fold. Fold first
            // and `-1` becomes `255`, which is in range for a `u8` and walks straight
            // past the range check — which is the whole reason GF0165 exists
            // (REWRITE-PLAN §7).
            if (natural.kind === "scalar" && rangeOf(natural.name)?.min === 0n) {
                this.outer.error(
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
            if (ts.isNumericLiteral(operand)) {
                return this.#literal(operand, natural, true);
            }

            const inner = this.#expression(operand, natural);
            if (inner === undefined) {
                return undefined;
            }
            return this.temporaryTyped(expression, natural, {
                kind: "Unary",
                op: "Neg",
                operand: inner,
            });
        }

        if (expression.operator === ts.SyntaxKind.TildeToken) {
            if (natural.kind === "scalar" && rangeOf(natural.name) === null) {
                this.outer.error(
                    expression,
                    "GF0162",
                    `\`~\` is defined on integers; this operand is \`${natural.name}\`.`,
                );
                return undefined;
            }
            const inner = this.#expression(operand, natural);
            if (inner === undefined) {
                return undefined;
            }
            return this.temporaryTyped(expression, natural, {
                kind: "Unary",
                op: "BitNot",
                operand: inner,
            });
        }

        // `a++` and `++a` update as *statements*, which is where `#expressionValue`
        // lowers them. Only the value they produce is missing, and that is the half
        // where the two spellings stop being the same thing — so name it, rather
        // than reporting the operator as unknown.
        if (
            expression.operator === ts.SyntaxKind.PlusPlusToken ||
            expression.operator === ts.SyntaxKind.MinusMinusToken
        ) {
            const spelling = expression.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--";
            this.outer.unsupported(
                expression,
                `\`${spelling}\` as a value — it updates on its own as a statement`,
            );
            return undefined;
        }

        this.outer.unsupported(expression, "this unary operator");
        return undefined;
    }

    #binary(expression: ts.BinaryExpression, natural: MachineType): Typed | undefined {
        const nullTest = this.nullTestOf(expression);
        if (nullTest !== undefined) {
            return this.#nullTest(expression, nullTest);
        }

        const kind = expression.operatorToken.kind;
        if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
            return this.#shortCircuit(expression, kind === ts.SyntaxKind.AmpersandAmpersandToken);
        }

        const operator = OPERATOR_TOKENS[kind];
        if (operator === undefined) {
            return undefined;
        }
        const info = OPERATORS[operator];

        // The type the operands are worked at. For a comparison that is not the
        // result type, so it has to come from the operands themselves.
        const operandType = info.comparison
            ? this.#operandType(expression)
            : info.shift
                ? natural
                : natural;
        if (operandType === undefined) {
            return undefined;
        }

        const lhsTyped = this.expressionTyped(expression.left, operandType);
        if (lhsTyped === undefined) {
            return undefined;
        }
        const lhs = this.forRead(lhsTyped);

        let rhs: Operand | undefined;
        if (info.shift) {
            // The count is *converted* to the value's type, not promoted to a common
            // type with it. A `u8` shifted by an `i64` is still a `u8` shift.
            rhs = this.#shiftCount(expression.right, operandType);
        } else {
            const rhsTyped = this.expressionTyped(expression.right, operandType);
            rhs = rhsTyped === undefined ? undefined : this.forRead(rhsTyped);
        }
        if (rhs === undefined) {
            return undefined;
        }

        const result = info.comparison ? ({kind: "bool"} as MachineType) : operandType;
        return this.temporaryTyped(expression, result, {
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
        if (left.kind === "error" || right.kind === "error") {
            return undefined;
        }
        if (left.kind === "typed" && right.kind === "typed") {
            const common = commonType(left.type, right.type);
            if (common !== null) {
                return common;
            }
            return undefined;
        }
        if (left.kind === "typed") {
            return left.type;
        }
        if (right.kind === "typed") {
            return right.type;
        }

        this.outer.error(
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
        if (width.kind === "error") {
            return undefined;
        }
        // A literal count simply takes the value's type; anything else is
        // converted to it, narrowing included, because a shift count is a count
        // rather than a value being preserved.
        if (width.kind === "poly" || sameType(width.type, valueType)) {
            return this.#expression(expression, valueType);
        }

        const value = this.value(expression, valueType);
        if (value === undefined) {
            return undefined;
        }
        const kind = this.castKind(expression, value.type, valueType);
        if (kind === undefined) {
            return undefined;
        }
        return this.temporary(expression, valueType, {
            kind: "Cast",
            op: kind,
            operand: value.operand,
            to: this.outer.tyOf(valueType, expression),
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
        const result = this.f.addLocal({
            ty: this.outer.tyOf(natural, expression),
            storage: "Temporary",
            span: this.outer.span(expression),
        });

        const mark = this.temporaries.length;
        const cond = this.#condition(expression.condition);
        if (cond === undefined) {
            return undefined;
        }

        const thenBlock = this.f.block();
        const elseBlock = this.f.block();
        const joinBlock = this.f.block();

        this.push({kind: "StorageLive", value: result});
        this.#branchEndingTemporaries(cond, mark, thenBlock, elseBlock);

        for (const [block, arm] of [
            [thenBlock, expression.whenTrue],
            [elseBlock, expression.whenFalse],
        ] as const) {
            this.current = block;
            const armMark = this.temporaries.length;
            const value = this.expressionTyped(arm, natural);
            if (value === undefined) {
                return undefined;
            }
            this.push({
                kind: "Init",
                place: placeOf(result),
                rvalue: {kind: "Use", value: this.forStorage(value)},
            });
            this.endTemporaries(armMark);
            this.seal({kind: "Goto", value: joinBlock});
        }

        this.current = joinBlock;
        this.temporaries.push(result);
        return {operand: {kind: "Copy", value: placeOf(result)}, type: natural, temporary: result};
    }

    /**
     * `&&` and `||` are control flow, not operators.
     *
     * They short-circuit, so the right-hand side runs only on one path. That is a
     * branch, and a branch belongs in the CFG — which is why the MIR has no
     * `BinOp::And`.
     */
    #shortCircuit(expression: ts.BinaryExpression, isAnd: boolean): Typed | undefined {
        const bool: MachineType = {kind: "bool"};
        const result = this.f.addLocal({
            ty: this.outer.tyOf(bool, expression),
            storage: "Temporary",
        });

        const left = this.#condition(expression.left);
        if (left === undefined) {
            return undefined;
        }

        const rightBlock = this.f.block();
        const shortBlock = this.f.block();
        const joinBlock = this.f.block();

        this.push({kind: "StorageLive", value: result});
        this.seal({
            kind: "Branch",
            cond: left,
            thenBlock: isAnd ? rightBlock : shortBlock,
            elseBlock: isAnd ? shortBlock : rightBlock,
        });

        this.current = rightBlock;
        const right = this.#condition(expression.right);
        if (right === undefined) {
            return undefined;
        }
        this.push({kind: "Init", place: placeOf(result), rvalue: {kind: "Use", value: right}});
        this.seal({kind: "Goto", value: joinBlock});

        this.current = shortBlock;
        this.push({
            kind: "Init",
            place: placeOf(result),
            rvalue: {kind: "Use", value: {kind: "Const", value: this.boolConst(!isAnd)}},
        });
        this.seal({kind: "Goto", value: joinBlock});

        this.current = joinBlock;
        return {operand: {kind: "Copy", value: placeOf(result)}, type: bool};
    }

    #call(expression: ts.CallExpression, natural: MachineType): Typed | undefined {
        if (expression.expression.kind === ts.SyntaxKind.SuperKeyword) {
            return this.#superCall(expression);
        }
        // A value of function-pointer type, called: a local holding a callback, a
        // struct field, an element of an array. First, because a callee can be any
        // expression at all while every path below recognises one shape — and
        // because a field holding a code address is *not* a method call, there
        // being nowhere in a `FnPtr` to put a receiver.
        // A `LocalFn` value, called. Before `callableValue`, which recognises a
        // bare code address and would call one with no environment at all — the
        // lifted body's first parameter, silently missing, and every argument off
        // by one.
        const closure = this.#closureCallee(expression.expression);
        if (closure !== undefined) {
            return this.#localFnCall(expression, closure.place, closure.type);
        }

        // `a.add(b)` and `dvec3.add(a, b)`, before `callableValue`.
        //
        // The static spelling is why this is *here* rather than with the other
        // method paths below: `callableValue` asks what `dvec3.add` is worth as
        // a value, and `dvec3` is a type name with no value at all — so it
        // reports a name that does not resolve before anything has decided this
        // was not an indirect call through a function pointer. The same shape
        // as `POINTER_METHODS` being probed silently in `#methodCall`, and the
        // same fix: answer first (DECISIONS §22).
        if (ts.isPropertyAccessExpression(expression.expression)) {
            const linalg = this.linalgCall(expression, expression.expression);
            if (linalg !== "not-linalg") {
                return linalg;
            }
        }

        const callable = this.callableValue(expression.expression);
        if (callable !== undefined) {
            return this.#indirectCall(expression, callable.value, callable.type);
        }

        if (ts.isPropertyAccessExpression(expression.expression)) {
            // `ns.f(…)` — a namespace-qualified call, which is the same *direct*
            // call the bare name would have been and not an indirect one through
            // its address. Before the method paths because a namespace is not a
            // receiver: there is nothing here to pass as one.
            const qualified = this.outer.namespaceCallee(
                expression,
                expression.expression,
                this.bindings,
            );
            if (qualified === "reported") {
                return undefined;
            }
            if (qualified !== undefined) {
                return this.#resolvedCall(expression, qualified);
            }
            const method = this.#methodCall(expression, expression.expression);
            if (method !== "not-a-method") {
                return method;
            }
            return this.#console(expression);
        }

        if (!ts.isIdentifier(expression.expression)) {
            return undefined;
        }
        const name = expression.expression.text;

        if (name === NATIVE_CAST) {
            return this.cast(expression, natural);
        }
        if (name === MOVE) {
            return this.#move(expression);
        }
        if (name === FIXED_ARRAY) {
            return this.fixedArray(expression, natural);
        }
        if (name === TRY_CAST) {
            return this.tryCast(expression);
        }
        if (name === CSTRING) {
            return this.cstring(expression);
        }
        if (name === CSTRING_FREE) {
            return this.cstringFree(expression);
        }
        if (name === ALLOC) {
            return this.alloc(expression, natural);
        }
        if (name === ALLOC_ARRAY) {
            return this.allocArray(expression, natural);
        }
        if (name === STRING_FROM_CSTRING) {
            return this.stringFromCString(expression);
        }
        if (name === STRING_FROM_BYTES) {
            return this.stringFromBytes(expression);
        }
        if (name === NATIVE_SIZE_OF || name === NATIVE_ALIGN_OF) {
            return this.layoutQuery(expression, name === NATIVE_SIZE_OF);
        }
        if (name === NATIVE_ZEROED) {
            return this.zeroed(expression, natural);
        }

        // Resolved through tsc's symbol, not by name: an imported function is the
        // same symbol as its declaration however it is spelled at the call site,
        // and two same-named privates in different files are different symbols.
        const target = this.outer.resolveCallee(expression, this.bindings);
        // Already complained about, with the reason. See `resolveCallee`.
        if (target === undefined || target === "reported") {
            return undefined;
        }
        return this.#resolvedCall(expression, target);
    }

    /**
     * A call to a declaration that has already been resolved, however it was
     * spelled: a bare name, or a name reached through a module namespace.
     */
    #resolvedCall(expression: ts.CallExpression, target: FnRecord): Typed | undefined {
        if (expression.arguments.length !== target.signature.params.length) {
            // tsc has already rejected a genuine arity mismatch, so reaching this
            // means the two disagree, which is a compiler bug rather than a user one.
            this.outer.unsupported(expression, "a call whose arity tsc and the lowerer disagree on");
            return undefined;
        }

        return this.#directCall(expression, target, expression.arguments);
    }

    /** A call to a known function: marshal the arguments and emit the terminator. */
    #directCall(
        expression: ts.CallExpression,
        target: FnRecord,
        written: readonly ts.Expression[],
    ): Typed | undefined {
        if (written.length !== target.signature.params.length) {
            // tsc has already rejected a genuine arity mismatch, so reaching this
            // means the two disagree, which is a compiler bug rather than a user one.
            this.outer.unsupported(expression, "a call whose arity tsc and the lowerer disagree on");
            return undefined;
        }

        const args: Operand[] = [];
        for (const [index, argument] of written.entries()) {
            const value = this.expressionTyped(argument, target.signature.params[index]!.type);
            if (value === undefined) {
                return undefined;
            }
            args.push(this.forArgument(argument, value));
        }

        return this.emitCall(
            expression,
            {
                kind: "Direct",
                value:
                    target.kind === "defined"
                        ? {kind: "Local", value: target.id}
                        : {kind: "Extern", value: this.outer.externIdOf(target)},
            },
            args,
            target.signature.returns,
        );
    }

    /**
     * Emit a call terminator, whatever the callee is.
     *
     * One place, so that a direct call, a static method and a call through a
     * function pointer agree about where the result lands and how a `void` return
     * is spelled — the three differ only in the callee.
     */
    protected override emitCall(
        at: ts.Node,
        callee: Extract<Terminator, { kind: "Call" }>["callee"],
        args: Operand[],
        returns: MachineType,
    ): Typed | undefined {
        const destination =
            returns.kind === "void"
                ? undefined
                : this.f.addLocal({
                    ty: this.outer.tyOf(returns, at),
                    storage: "Temporary",
                });
        if (destination !== undefined) {
            this.temporaries.push(destination);
            this.push({kind: "StorageLive", value: destination});
        }

        const next = this.f.block();
        this.seal({
            kind: "Call",
            callee,
            args,
            destination: {place: placeOf(destination ?? LocalId(0)), target: next},
            unwind: NO_UNWIND,
        });
        this.current = next;

        if (destination === undefined) {
            return undefined;
        }
        return this.fromCall(destination, returns);
    }

    /**
     * A callee that is a `LocalFn` value, and the place it lives in.
     *
     * A name, and only a name. That is not a restriction in practice: the escape
     * rule refuses a `LocalFn` as a field, an element and a return type, so a
     * parameter and a local are the only places one can be — and both are names.
     */
    #closureCallee(
        expression: ts.Expression,
    ): { place: Place; type: Extract<MachineType, { kind: "localfn" }> } | undefined {
        if (!ts.isIdentifier(expression)) {
            return undefined;
        }
        const binding = this.scopes.lookup(expression.text);
        if (binding === undefined || binding.type.kind !== "localfn") {
            return undefined;
        }
        return {place: bindingPlace(binding), type: binding.type};
    }

    /**
     * `f(1)` where `f` is a `LocalFn`: the environment, then the arguments.
     *
     * The environment travels as argument 0 rather than in a register the ABI
     * reserves, because there is no such register in any convention this
     * compiler targets and inventing one would make the lifted body uncallable
     * by anything else. It is the arrangement C uses for a `void *` userdata,
     * moved to the front and made mandatory.
     */
    #localFnCall(
        expression: ts.CallExpression,
        place: Place,
        type: Extract<MachineType, { kind: "localfn" }>,
    ): Typed | undefined {
        if (expression.arguments.length !== type.params.length) {
            this.outer.unsupported(expression, "a call whose arity tsc and the lowerer disagree on");
            return undefined;
        }

        const field = (index: number): Place => ({
            local: place.local,
            projection: [...place.projection, {kind: "Field", value: FieldId(index)}],
        });

        const args: Operand[] = [{kind: "Copy", value: field(1)}];
        for (const [index, argument] of expression.arguments.entries()) {
            const value = this.expressionTyped(argument, type.params[index]!);
            if (value === undefined) {
                return undefined;
            }
            args.push(this.forArgument(argument, value));
        }

        return this.emitCall(
            expression,
            {
                kind: "Indirect",
                operand: {kind: "Copy", value: field(0)},
                sig: this.outer.localFnSig(type, expression),
            },
            args,
            type.returns,
        );
    }

    /**
     * `(x) => x * 2` written where a `LocalFn` is wanted: the closure value.
     *
     * Two words, built here in the frame the captures live in — a code address
     * for the lifted body, and a pointer to an environment of references to
     * this frame's locals. Both are temporaries of the enclosing
     * full-expression, which is exactly the lifetime the type promises: the call
     * this is an argument to finishes before they die.
     *
     * The environment is a struct of `Reference<T>`, so its category is `Borrow`
     * and the drop pass places nothing on it. Nothing here owns anything; the
     * frame that declared the captured locals still owns them and still destroys
     * them (DECISIONS §18).
     */
    #closure(
        node: ts.ArrowFunction | ts.FunctionExpression,
        expected: MachineType | undefined,
    ): Typed | undefined {
        if (expected === undefined || expected.kind !== "localfn") {
            // A lambda has no type of its own, so there is nothing to report a
            // mismatch against — the message has to be about the position instead.
            this.outer.error(
                node,
                "GF0239",
                expected === undefined
                    ? "a lambda has no type of its own, and nothing here says what it " +
                    "should be. It can only be written where a `LocalFn<F>` parameter " +
                    "is expected."
                    : `a lambda cannot be a \`${renderType(expected)}\`. A lambda that ` +
                    "captures is a `LocalFn<F>`, and one that does not can still only be " +
                    "written where a `LocalFn<F>` is expected — a plain function type is " +
                    "a bare code address, which is what a named function is.",
            );
            return undefined;
        }

        // **An argument, and nowhere else.** The environment below is a temporary
        // of the enclosing full-expression, so a call bounds it exactly: the call
        // finishes before the temporary dies. A binding does not —
        //
        //     const g: LocalFn<(x: i32) => i32> = (x) => x + n;
        //
        // leaves `g` holding the address of a temporary from a statement that has
        // ended. This is the same rule as `GF0234`'s and the same reasoning: only
        // a binding can outlive a temporary, so only a binding has to be refused.
        //
        // Binding a `LocalFn` *parameter* to a name stays legal, and is a different
        // thing entirely — that environment belongs to a caller whose frame is
        // still live for the whole of this call.
        if (!isCallArgument(node)) {
            this.outer.error(
                node,
                "GF0239",
                "a lambda's environment is a temporary of the statement that writes it, " +
                "so binding one to a name would outlive it. Write the lambda at the " +
                "call that takes it.",
            );
            return undefined;
        }

        const lifted = this.outer.liftClosure(
            node,
            expected,
            this.scopes,
            this.self,
            this.bindings,
        );
        if (lifted === undefined) {
            return undefined;
        }

        const erasedType: MachineType = {kind: "pointer", pointee: {kind: "void"}};
        const erasedTy = this.outer.tyOf(erasedType, node);
        let environment: Operand;

        if (lifted.env === undefined) {
            // Nothing captured, so there is no environment: the lifted body takes the
            // parameter and never loads it. Null rather than a zero-field struct,
            // because a struct of nothing still needs an address and this does not.
            environment = {kind: "Const", value: {kind: "Null", value: erasedTy}};
        } else {
            const slots = this.f.addLocal({
                ty: lifted.env.ty,
                storage: "Temporary",
                span: this.outer.span(node),
            });
            this.push({kind: "StorageLive", value: slots});
            this.push({
                kind: "Init",
                place: placeOf(slots),
                rvalue: {
                    kind: "Aggregate",
                    ty: lifted.env.ty,
                    // Field order is `lifted.captures`, which the lifted body indexed by
                    // when it declared its bindings. One list, read twice.
                    fields: lifted.captures.map((capture) =>
                        this.refTo(node, bindingPlace(capture), capture.type),
                    ),
                },
            });

            const address = this.f.addLocal({ty: lifted.env.pointer, storage: "Temporary"});
            this.push({kind: "StorageLive", value: address});
            this.push({
                kind: "Init",
                place: placeOf(address),
                rvalue: {kind: "AddrOf", value: placeOf(slots)},
            });

            // And then its type is thrown away, because the receiving parameter is
            // one type for every closure that can reach it. Written as a cast rather
            // than by storing a `Pointer<Env>` into a `Pointer<unknown>` slot: the
            // erasure is the point, and it should be visible in a MIR dump.
            const erased = this.f.addLocal({ty: erasedTy, storage: "Temporary"});
            this.push({kind: "StorageLive", value: erased});
            this.push({
                kind: "Init",
                place: placeOf(erased),
                rvalue: {
                    kind: "Cast",
                    op: "PtrToPtr",
                    operand: {kind: "Copy", value: placeOf(address)},
                    to: erasedTy,
                },
            });
            environment = {kind: "Copy", value: placeOf(erased)};
        }

        const ty = this.outer.tyOf(expected, node);
        const local = this.f.addLocal({ty, storage: "Temporary", span: this.outer.span(node)});
        this.push({kind: "StorageLive", value: local});
        this.push({
            kind: "Init",
            place: placeOf(local),
            rvalue: {
                kind: "Aggregate",
                ty,
                fields: [
                    {
                        kind: "Const",
                        value: {
                            kind: "Func",
                            func: {kind: "Local", value: lifted.func},
                            ty: this.outer.localFnCodeTy(expected, node),
                        },
                    },
                    environment,
                ],
            },
        });
        return {operand: {kind: "Copy", value: placeOf(local)}, type: expected};
    }

    /**
     * `f(1)` where `f` is a value of function-pointer type.
     *
     * The signature comes from the *type*, not from any declaration — there may
     * be no declaration in this build at all. It is recorded on the node because
     * the call site and whatever definition ends up there have to classify
     * identically, and C's rules are the only thing they share.
     */
    #indirectCall(
        expression: ts.CallExpression,
        callee: Typed,
        signature: Extract<MachineType, { kind: "fnptr" }>,
    ): Typed | undefined {
        if (expression.arguments.length !== signature.params.length) {
            this.outer.unsupported(expression, "a call whose arity tsc and the lowerer disagree on");
            return undefined;
        }

        const args: Operand[] = [];
        for (const [index, argument] of expression.arguments.entries()) {
            const value = this.expressionTyped(argument, signature.params[index]!);
            if (value === undefined) {
                return undefined;
            }
            args.push(this.forArgument(argument, value));
        }

        return this.emitCall(
            expression,
            {
                kind: "Indirect",
                operand: this.forRead(callee),
                sig: this.outer.sigOf(signature, expression),
            },
            args,
            signature.returns,
        );
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
    /**
     * `x.pick<i32>(v)` — a call to one instantiation of a generic method.
     *
     * A **direct** call, always: a generic method has no vtable slot, so there
     * is nothing to dispatch through and nothing to override it. The receiver
     * is passed as an ordinary first argument, which is what `this` already is
     * everywhere else.
     */
    #genericMethodCall(
        expression: ts.CallExpression,
        access: ts.PropertyAccessExpression,
        info: ClassInfo,
        template: MethodTemplate,
    ): Typed | undefined {
        const record = this.outer.instantiateMethod(info, template, expression, this.bindings);
        if (record === undefined || record === "reported" || record.kind !== "defined") {
            return undefined;
        }

        // A `static` has no receiver, so it is an ordinary direct call.
        if (template.isStatic) {
            return this.#directCall(expression, record, expression.arguments);
        }

        const subject = this.value(access.expression, undefined);
        if (subject === undefined) {
            return undefined;
        }
        const asClass = this.asClass(subject);
        if (asClass === undefined) {
            this.outer.unsupported(access, "a method call on this receiver");
            return undefined;
        }

        const args = this.classCallArgs(
            expression,
            info,
            record.name,
            expression.arguments,
            this.refTo(access, asClass.place, {kind: "class", name: info.name}),
        );
        if (args === undefined || args === null) {
            return undefined;
        }
        return this.emitCall(
            expression,
            {kind: "Direct", value: {kind: "Local", value: record.id}},
            args,
            record.signature.returns,
        );
    }

    #methodCall(
        expression: ts.CallExpression,
        access: ts.PropertyAccessExpression,
    ): Typed | undefined | "not-a-method" {
        if (access.expression.kind === ts.SyntaxKind.SuperKeyword) {
            return this.#superMethodCall(expression, access);
        }

        // `p.free()`, `p.deref()`, `p.offset(n)`, before the class path for the
        // same reason the width pass takes them first: a `Pointer<C>`
        // auto-dereferences to a `C`.
        if (
            POINTER_METHODS.has(access.name.text) &&
            // Probed silently first: `C.free()` on a class *name* has no value to
            // lower, and asking for one reports a name that does not resolve before
            // anything has decided this was not a pointer at all.
            this.tryErase(access.expression)?.kind === "pointer"
        ) {
            const subject = this.value(access.expression, undefined);
            if (subject !== undefined && subject.type.kind === "pointer") {
                return this.pointerMethod(expression, access, subject);
            }
        }

        // `C.f(…)` — a static method: an ordinary direct call with no receiver.
        const staticMethod = this.staticAt(access);
        if (staticMethod !== undefined) {
            const record = this.outer.fn(staticMethod.symbol);
            if (record === undefined || record.kind !== "defined") {
                this.outer.unsupported(expression, `a call to \`${staticMethod.symbol}\``);
                return undefined;
            }
            return this.#directCall(expression, record, expression.arguments);
        }

        // `xs.push(v)` and `xs.pop()`, before the class and contract paths for the
        // same reason the width pass takes them first: an array is neither, and
        // these two methods are the compiler's rather than any declaration's.
        const element = this.arrayElementAt(access);
        if (element !== undefined) {
            const array = this.value(access.expression, undefined);
            if (array === undefined) {
                return undefined;
            }
            switch (access.name.text) {
                case "push":
                    return this.arrayPush(expression, array, element);
                case "pop":
                    return this.arrayPop(expression, array, element);
                case "forEach":
                    return this.arrayForEach(expression, array, element);
                default:
                    this.outer.unsupported(expression, `\`${access.name.text}\` on an array`);
                    return undefined;
            }
        }

        // `s.substring(a, b)`, `s.indexOf(t)`, `s.codePointAt(i)` — the three
        // `String` methods that are runtime calls. Before the class and contract
        // paths for the reason the array branch above is: a `string` is neither.
        if (this.tryErase(access.expression)?.kind === "string") {
            return this.#stringMethod(expression, access);
        }

        const contract = this.contractAt(access.expression);
        if (contract !== undefined) {
            return this.#interfaceCall(expression, access, contract);
        }

        // Asked of tsc rather than of the width pass, because the width pass
        // *reports*: `console.log` is a property access too, and running it over
        // `console` would raise a diagnostic about a name that does not resolve
        // before this could decide the call was not a method call at all.
        const className = this.outer.classNameAt(access.expression, this.bindings);
        if (className === undefined) {
            return "not-a-method";
        }

        const info = this.outer.classInfo(className);
        if (info === undefined) {
            return "not-a-method";
        }

        // A method generic in its own right: one copy per set of type
        // arguments, resolved **directly** rather than through a slot, because
        // it has none. Before the ordinary lookup because the two maps are
        // disjoint and this one is the narrower question.
        const template = info.methodTemplates.get(access.name.text);
        if (template !== undefined) {
            return this.#genericMethodCall(expression, access, info, template);
        }

        const method = info.methods.get(access.name.text);
        if (method === undefined) {
            return "not-a-method";
        }

        const subject = this.value(access.expression, undefined);
        if (subject === undefined) {
            return undefined;
        }
        const asClass = this.asClass(subject);
        if (asClass === undefined) {
            this.outer.unsupported(access, "a method call on this receiver");
            return undefined;
        }

        const record = this.outer.fn(method.symbol);
        if (record === undefined || record.kind !== "defined") {
            this.outer.unsupported(expression, `a call to \`${method.symbol}\``);
            return undefined;
        }

        const args = this.classCallArgs(
            expression,
            info,
            method.symbol,
            expression.arguments,
            this.refTo(access, asClass.place, {kind: "class", name: className}),
        );
        if (args === undefined || args === null) {
            return undefined;
        }

        const returns = record.signature.returns;
        const destination =
            returns.kind === "void"
                ? undefined
                : this.f.addLocal({
                    ty: this.outer.tyOf(returns, expression),
                    storage: "Temporary",
                });
        if (destination !== undefined) {
            this.temporaries.push(destination);
            this.push({kind: "StorageLive", value: destination});
        }

        const next = this.f.block();
        this.seal({
            kind: "Call",
            callee: {kind: "Virtual", slot: method.slot, sig: record.sig},
            args,
            destination: {place: placeOf(destination ?? LocalId(0)), target: next},
            unwind: NO_UNWIND,
        });
        this.current = next;

        if (destination === undefined) {
            return undefined;
        }
        return this.fromCall(destination, returns);
    }

    /**
     * `pet === null` or `pet !== null`, where `pet` is a contract reference.
     *
     * Returns the non-null side and whether the test is for equality, or
     * `undefined` when this is an ordinary comparison. Recognised on both sides,
     * because `null !== pet` is the same question.
     */
    protected override nullTestOf(
        expression: ts.BinaryExpression,
    ): { subject: ts.Expression; equals: boolean } | undefined {
        const kind = expression.operatorToken.kind;
        const equals =
            kind === ts.SyntaxKind.EqualsEqualsToken ||
            kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
        const differs =
            kind === ts.SyntaxKind.ExclamationEqualsToken ||
            kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
        if (!equals && !differs) {
            return undefined;
        }

        const isNull = (node: ts.Expression): boolean =>
            node.kind === ts.SyntaxKind.NullKeyword;
        const subject = isNull(expression.right)
            ? expression.left
            : isNull(expression.left)
                ? expression.right
                : undefined;
        if (subject === undefined) {
            return undefined;
        }
        // A contract reference is a pair, and a class reference is one word. Both
        // can be null; they are tested differently.
        if (this.contractAt(subject) !== undefined) {
            return {subject, equals};
        }
        const type = this.outer.checker.getNonNullableType(
            this.outer.checker.getTypeAtLocation(subject),
        );
        const referent = referentOf(this.outer.checker, type);
        if (referent !== null && classNameOf(referent) !== null) {
            return {subject, equals};
        }
        // A `CString` is one machine word and is the type a C function most often
        // returns null from — `getenv`, `SDL_GetError`, half of libc. Declaring one
        // `CString | null` and being made to check it is the whole benefit of the
        // nullable spelling, and it is worth nothing if the check does not lower.
        if (isCStringType(this.outer.checker, type)) {
            return {subject, equals};
        }
        // And a `Pointer<T>`, for the same reason and rather more often: `malloc`,
        // `fopen`, `SDL_CreateWindow`. `Pointer<T> | null` erases to the same
        // machine word as `Pointer<T>` — the null is representable in the value —
        // so nullability stays tsc's view of the program and the check is a
        // comparison against zero.
        if (isPointerType(this.outer.checker, type)) {
            return {subject, equals};
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
        const value = this.value(test.subject, undefined);
        if (value === undefined) {
            return undefined;
        }
        const place = this.placeOfSubject(test.subject, value);
        if (place === undefined) {
            return undefined;
        }

        const bool: MachineType = {kind: "bool"};
        // A class reference, a `CString` and a `Pointer<T>` are each a single word,
        // so they compare against a null constant like any other address. A
        // contract reference is a pair, and what is null is its itab word — a
        // different read, hence a different node.
        if (
            value.type.kind === "reference" ||
            value.type.kind === "cstring" ||
            value.type.kind === "pointer"
        ) {
            return this.temporaryTyped(expression, bool, {
                kind: "Binary",
                op: test.equals ? "Eq" : "Ne",
                lhs: {kind: "Copy", value: place},
                rhs: {
                    kind: "Const",
                    value: {kind: "Null", value: this.outer.tyOf(value.type, expression)},
                },
            });
        }
        const isNull = this.temporaryTyped(expression, bool, {
            kind: "InterfaceIsNull",
            value: place,
        });
        if (test.equals || isNull === undefined) {
            return isNull;
        }
        return this.temporaryTyped(expression, bool, {
            kind: "Unary",
            op: "Not",
            operand: isNull.operand,
        });
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
            this.outer.unsupported(access, `\`${contract.name}.${access.name.text}()\``);
            return undefined;
        }

        const receiver = this.value(access.expression, contract);
        if (receiver === undefined) {
            return undefined;
        }

        if (expression.arguments.length !== method.params.length) {
            this.outer.error(
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

        const args: Operand[] = [this.forRead(receiver)];
        for (const [index, argument] of expression.arguments.entries()) {
            const want = method.params[index]!;
            const value = this.expressionTyped(argument, want);
            if (value === undefined) {
                return undefined;
            }
            args.push(this.forArgument(argument, value));
        }

        // The signature the *interface* declares, not any class's: at the call site
        // the class is unknown, which is the whole point of dispatching.
        const receiverTy = this.outer.mir.ty({
            kind: "Pointer",
            value: this.outer.mir.ty({kind: "Void"}),
        });
        const sig = this.outer.mir.sig({
            params: [
                {ty: receiverTy, name: null},
                ...method.params.map((param) => ({
                    ty: this.outer.tyOf(param, expression),
                    name: null,
                })),
            ],
            ret: this.outer.tyOf(method.returns, expression),
            abi: "Internal",
        });

        const returns = method.returns;
        const destination =
            returns.kind === "void"
                ? undefined
                : this.f.addLocal({
                    ty: this.outer.tyOf(returns, expression),
                    storage: "Temporary",
                });
        if (destination !== undefined) {
            this.temporaries.push(destination);
            this.push({kind: "StorageLive", value: destination});
        }

        const next = this.f.block();
        this.seal({
            kind: "Call",
            callee: {kind: "Interface", slot, sig},
            args,
            destination: {place: placeOf(destination ?? LocalId(0)), target: next},
            unwind: NO_UNWIND,
        });
        this.current = next;

        if (destination === undefined) {
            return undefined;
        }
        return this.fromCall(destination, returns);
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
        const self = this.self;
        if (self === undefined) {
            this.outer.error(
                access,
                "GF0002",
                "`super` is only meaningful inside a method or a constructor.",
            );
            return undefined;
        }
        const base = self.base;
        if (base === undefined) {
            this.outer.error(
                access,
                "GF0002",
                `\`${self.name}\` extends nothing, so there is no \`super\` to call.`,
            );
            return undefined;
        }
        const method = base.methods.get(access.name.text);
        if (method === undefined) {
            this.outer.error(
                access,
                "GF0002",
                `\`${base.name}\` has no method \`${access.name.text}\`.`,
            );
            return undefined;
        }
        const record = this.outer.fn(method.symbol);
        if (record === undefined || record.kind !== "defined") {
            this.outer.unsupported(expression, `a call to \`${method.symbol}\``);
            return undefined;
        }

        const binding = this.scopes.lookup("this");
        if (binding === undefined) {
            this.outer.error(access, "GF0002", "`super` needs a `this` to call through.");
            return undefined;
        }

        // `this` is already a `Reference<Self>`, and a `Reference<Derived>` is a
        // valid `Reference<Base>` because the base is a layout prefix — which is
        // the whole reason fields are flattened base-first.
        const args = this.classCallArgs(
            expression,
            base,
            method.symbol,
            expression.arguments,
            {kind: "Copy", value: bindingPlace(binding)},
        );
        if (args === undefined || args === null) {
            return undefined;
        }

        const returns = record.signature.returns;
        const destination =
            returns.kind === "void"
                ? undefined
                : this.f.addLocal({
                    ty: this.outer.tyOf(returns, expression),
                    storage: "Temporary",
                });
        if (destination !== undefined) {
            this.temporaries.push(destination);
            this.push({kind: "StorageLive", value: destination});
        }

        this.callDirect(record.id, args, destination);
        if (destination === undefined) {
            return undefined;
        }
        return this.fromCall(destination, returns);
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
        const self = this.self;
        if (self === undefined || !this.inConstructor) {
            this.outer.error(
                expression,
                "GF0002",
                "`super(…)` is only meaningful inside a constructor.",
            );
            return undefined;
        }
        const base = self.base;
        if (base === undefined) {
            this.outer.error(
                expression,
                "GF0002",
                `\`${self.name}\` extends nothing, so there is no \`super\` to call.`,
            );
            return undefined;
        }
        const receiver = this.#thisTyped(expression);
        if (receiver === undefined) {
            return undefined;
        }
        const binding = this.scopes.lookup("this")!;

        const args = this.classCallArgs(
            expression,
            base,
            base.constructorSymbol,
            expression.arguments,
            {kind: "Copy", value: bindingPlace(binding)},
        );
        if (args === undefined) {
            return undefined;
        }
        if (args === null) {
            if (expression.arguments.length > 0) {
                this.outer.error(
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

        const record = this.outer.fn(base.constructorSymbol!);
        if (record === undefined || record.kind !== "defined") {
            return undefined;
        }
        this.callDirect(record.id, args, undefined);
        // The base subobject is complete, which is exactly when C++ runs this
        // class's default member initialisers — before the constructor body.
        this.#emitPendingInitialisers();
        return undefined;
    }

    /**
     * `s.substring(a, b)`, `s.indexOf(t)`, `s.codePointAt(i)`.
     *
     * The receiver is **borrowed**, like every other argument a runtime call
     * takes — `forRead` sees an owning type and produces a `Borrow`, so reading
     * a substring does not first clone the string it is read from.
     *
     * The result of `substring` is an owned `string`, so the scope that takes it
     * releases it. That is the same arrangement `stringFromCString` has and
     * needs no special handling here: a `callRuntime` returning `STRING` lands
     * in a temporary the drop pass already tracks.
     */
    #stringMethod(
        expression: ts.CallExpression,
        access: ts.PropertyAccessExpression,
    ): Typed | undefined {
        const subject = this.value(access.expression, STRING);
        if (subject === undefined) {
            return undefined;
        }
        const written = expression.arguments;

        switch (access.name.text) {
            case "substring": {
                const start = this.#offsetArgument(expression, written[0], 0n);
                // The end nobody wrote is "as far as there is", spelled as the
                // largest `usize` — which `gf_string_substring` clamps to the
                // length, exactly as it clamps one somebody did write. So the
                // two forms are one call rather than two signatures.
                const end = this.#offsetArgument(expression, written[1], 0xffff_ffff_ffff_ffffn);
                if (start === undefined || end === undefined) {
                    return undefined;
                }
                return this.callRuntime(expression, RUNTIME.substring, [subject, start, end], STRING);
            }
            case "indexOf": {
                const search = written[0];
                if (search === undefined) {
                    this.outer.error(expression, "GF0002", "`indexOf` takes a string to look for.");
                    return undefined;
                }
                const needle = this.value(search, STRING);
                const from = this.#offsetArgument(expression, written[1], 0n);
                if (needle === undefined || from === undefined) {
                    return undefined;
                }
                return this.callRuntime(expression, RUNTIME.indexOf, [subject, needle, from], ISIZE);
            }
            case "codePointAt": {
                const index = this.#offsetArgument(expression, written[0], 0n);
                if (index === undefined) {
                    return undefined;
                }
                return this.callRuntime(
                    expression,
                    RUNTIME.codePointAt,
                    [subject, index],
                    {kind: "scalar", name: "u32"},
                );
            }
            default:
                this.outer.unsupported(expression, `\`${access.name.text}\` on a \`string\``);
                return undefined;
        }
    }

    /** A `usize` offset argument, or the constant an omitted one stands for. */
    #offsetArgument(
        at: ts.Expression,
        argument: ts.Expression | undefined,
        absent: bigint,
    ): Typed | undefined {
        if (argument === undefined) {
            return {
                operand: {
                    kind: "Const",
                    value: {kind: "Int", bits: absent, ty: this.outer.tyOf(USIZE, at)},
                },
                type: USIZE,
            };
        }
        return this.value(argument, USIZE);
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
            this.outer.unsupported(expression, "this call target");
            return undefined;
        }

        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.unsupported(expression, "`console` with anything but one argument");
            return undefined;
        }

        const value = this.value(argument, undefined);
        if (value === undefined) {
            return undefined;
        }
        const text = this.#toStringValue(argument, value);
        if (text === undefined) {
            return undefined;
        }

        return this.callRuntime(
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
        if (argument === undefined) {
            return undefined;
        }

        if (!ts.isIdentifier(argument)) {
            this.outer.unsupported(argument, "moving out of anything but a local");
            return undefined;
        }
        const binding = this.scopes.lookup(argument.text);
        if (binding === undefined) {
            this.outer.unsupported(argument, `the name \`${argument.text}\``);
            return undefined;
        }
        if (this.#readMoved(argument, binding.local, argument.text)) {
            return undefined;
        }

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
            this.outer.error(
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

        // A capture is a borrow of a local the enclosing frame still owns, and it
        // is that frame which destroys it. Emptying it from in here leaves the
        // owner holding a moved-from value it never wrote, and the closure may run
        // any number of times — so the second call moves out of nothing.
        if (isCapture(binding)) {
            this.outer.error(
                argument,
                "GF0238",
                `\`${argument.text}\` is captured from the enclosing function, which still ` +
                "owns it — a capture is a borrow, so there is nothing here to move out " +
                "of. Copy it instead (assigning it is a copy).",
            );
            return undefined;
        }

        this.#moved.set(binding.local, argument.text);
        return {operand: {kind: "Move", value: bindingPlace(binding)}, type: binding.type};
    }

    /**
     * Whether a binding is one of this function's owning by-value parameters.
     *
     * Parameters are locals `1..=n`, in order — the one place in this compiler
     * where a local's *index* carries meaning, and it comes from the MIR's own
     * definition of a function rather than from a convention invented here.
     */
    #isOwningParameter(binding: Binding): boolean {
        if (!this.#owns(binding.type)) {
            return false;
        }
        const params = this.f.raw.locals.length === 0 ? 0 : this.#paramCount();
        return binding.local >= 1 && binding.local <= params;
    }

    #paramCount(): number {
        return this.outer.mir.paramCount(this.f.raw.sig);
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
        if (moved === undefined) {
            return false;
        }
        this.outer.error(
            at,
            "GF0235",
            `\`${name}\` was moved from, so it no longer holds a value. ` +
            `Bind the result of the \`move\` to a name and read that instead.`,
        );
        return true;
    }
}
