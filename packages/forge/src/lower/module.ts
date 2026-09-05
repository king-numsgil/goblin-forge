/**
 * Module-level lowering: declarations, classes, interfaces, and the type
 * interning every body shares.
 *
 * This half runs first and answers questions; {@link BodyLowerer} runs second
 * and asks them. The 25-odd public members below are that boundary, and they
 * are the whole of it — a body reaches the module through this surface and
 * nothing else.
 */

import {
    type ClassId,
    type ExternId,
    FieldId,
    type FuncId,
    type FunctionBuilder,
    type InterfaceId,
    LocalId,
    ModuleBuilder,
    type SigId,
    type TyId,
} from "@goblin-forge/backend";
import {
    classNameOf,
    contractOf,
    DEFAULT_ENUM_WIDTH,
    type Diagnostic,
    ENUM_UNDERLYING,
    erase,
    Erasure,
    ErasureError,
    layoutKey,
    layoutKeyHash,
    type MachineType,
    NO_BINDINGS,
    type Note,
    rangeOf,
    renderType,
    type Substitution,
} from "@goblin-forge/checker";
import { globalDeclarations, stdLibrary } from "@goblin-forge/runtime/paths";
import ts from "typescript";
import {
    buildClass,
    type ClassInfo,
    type ClassMethod,
    collectClasses,
    type MethodBody,
    type MethodTemplate,
    type StaticMethod,
} from "../classes.ts";
import { INT_TY, STD_MODULES } from "./tables.ts";
import {
    type ClassBody,
    type FnRecord,
    type FnSignature,
    type FnTemplate,
    type GenericUse,
    type LiftedClosure,
    type LowerResult,
    type PendingInstantiation,
    VOID,
} from "./types.ts";
import {
    bindingsOf,
    inferBindings,
    instantiationKey,
    instantiationSymbol,
    typeParameterSymbolsOf,
} from "./generics.ts";
import { type Binding, Scopes } from "./scopes.ts";
import {
    behindOneIndirection,
    describe,
    isStaticMember,
    moduleTag,
    needsDrop,
} from "./util.ts";
import { BodyLowerer } from "./body.ts";
import { capturedNames, thisParameterOf, usesThis } from "./closures.ts";

/**
 * How many instantiations deep a chain may go before it is reported.
 *
 * Arbitrary, as every such limit is. What is not arbitrary is that there be
 * one: `f<T>() { f<Pair<T>>() }` type-checks and has infinitely many
 * instantiations, and without a limit the compiler exhausts its stack and says
 * nothing about which program did it.
 */
const MAX_INSTANTIATION_DEPTH = 64;

/**
 * A path in the one shape two of them can be compared in.
 *
 * Separators because Windows accepts both and tsc hands back a mixture; case
 * because the same file reaches the compiler as `C:\…` from a config and
 * `c:/…` from a resolution, and on Windows those are one file.
 */
function normalisePath(path: string): string {
    return path.replaceAll("\\", "/").toLowerCase();
}

export class Lowerer {
    readonly #program: ts.Program;
    readonly #checker: ts.TypeChecker;
    readonly #mir: ModuleBuilder;
    readonly #diagnostics: Diagnostic[] = [];
    readonly #functions = new Map<string, FnRecord>();
    readonly #requireMain: boolean;
    readonly #root: string;
    readonly #entry: string;
    #classes = new Map<string, ClassInfo>();
    /**
     * Generic class declarations, by their bare name — `Box`, not `Box<i32>`.
     *
     * Nothing is emitted for one. {@link Lowerer.classInfoFor} makes the
     * instantiations, on demand, because the first mention of a `Box<i32>` may
     * be inside a generic function's body and that is lowered long after the
     * ordinary classes were declared.
     */
    #genericClasses = new Map<string, ts.ClassDeclaration>();
    /** Interned `LocalFn` value types, by the mangled name {@link #localFnTy} builds. */
    #localFns = new Map<string, TyId>();
    /** How many closures have been lifted, for naming the next one. */
    #liftedCount = 0;
    readonly #classTys = new Map<string, TyId>();
    readonly #classIds = new Map<string, ClassId>();
    /**
     * The class an expression denotes, seeing through one `Reference<T>`, or
     * `undefined`.
     *
     * Answered from tsc directly and **without reporting anything**, so a caller
     * can use it to decide *whether* a construct is about a class before
     * committing to lowering it as one.
     */
    /**
     * Functions whose *address* is taken somewhere in the program.
     *
     * These are emitted with the C calling convention, because a `FnPtr`'s
     * signature is classified by the C rules and a call through one has to agree
     * with the definition. Only the convention changes; the symbol and the
     * linkage do not, so an internal helper stays internal.
     *
     * Whole-program, and it has to be: whether a function's address is taken is
     * not a property of its declaration, and the call in another module that
     * takes it may be lowered long after the declaration was.
     */
    readonly #addressTaken = new Set<ts.Declaration>();
    /**
     * Generic functions, by the key their declaration would have had.
     *
     * A template is **not** a function: nothing is declared in the MIR for one
     * and nothing is emitted, because a generic has no code until some call
     * says what its type parameters are. What is here is what an instantiation
     * needs in order to be made.
     */
    readonly #templates = new Map<string, FnTemplate>();

    /** One emitted copy per set of type arguments, by {@link instantiationKey}. */
    readonly #instantiations = new Map<string, FnRecord>();

    /**
     * Instantiations that have been declared and whose bodies are still to be
     * lowered.
     *
     * A worklist rather than a loop, because lowering one body is what
     * discovers the next: `first<Pair<i32>>` is only known to be wanted once
     * the body that calls it is being lowered. {@link Lowerer.#drainPending}
     * runs it to a fixed point.
     */
    readonly #pending: PendingInstantiation[] = [];

    /**
     * Class members declared on demand and still waiting for their bodies.
     *
     * Apart from {@link Lowerer.#pending} because a class body is a
     * {@link ClassBody} rather than a function instantiation, and drained
     * beside it for the same reason: an instantiated class's method may be what
     * asks for the next instantiation of anything.
     */
    readonly #pendingClasses: ClassBody[] = [];

    /** How deep the current chain of *class* instantiations is. */
    #classDepth = 0;

    /**
     * The instantiation being lowered, and how it was reached.
     *
     * `f<T>` calling `f<Pair<T>>` type-checks and has infinitely many
     * instantiations, so something has to stop. Rust caps the depth and reports
     * it; so does this, rather than running the machine out of memory and
     * reporting nothing at all.
     */
    #current: { readonly depth: number; readonly trail: readonly string[] } | undefined;

    /**
     * Where the instantiation currently being lowered was asked for.
     *
     * Attached as a {@link Note} to every diagnostic raised while it is being
     * lowered. tsc checks a generic at its *declaration*, so a body that type-
     * checks is fine for every `T` as far as tsc is concerned — but erasure is
     * this compiler's rule and tsc knows nothing about it, so `identity<T>` is
     * fine and `identity<Speaker>` is a contract with no value form. Without
     * the note that diagnostic points inside a body the reader did not write a
     * call to.
     */
    #instantiatedAt: Note | undefined;

    readonly #externs = new Map<string, ExternId>();
    readonly #structs = new Map<string, TyId>();
    readonly #interfaces = new Map<string, InterfaceId>();
    readonly #interfaceTys = new Map<string, TyId>();
    readonly #interfaceInfo = new Map<string, Extract<MachineType, { kind: "interface" }>>();
    /**
     * Record a class → contract conversion, resolving the itab's entries.
     *
     * The entries are a **gather from the vtable**: the class's final overrider
     * for each of the interface's methods, in the interface's own slot order. No
     * search happens at run time and none happens in the backend.
     */
    readonly #implemented = new Set<string>();

    // -- classes -------------------------------------------------------------

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

    get mir(): ModuleBuilder {
        return this.#mir;
    }

    get checker(): ts.TypeChecker {
        return this.#checker;
    }

    get functions(): ReadonlyMap<string, FnRecord> {
        return this.#functions;
    }

    /**
     * Resolve a call to the function it names, through **tsc**.
     *
     * By symbol rather than by string, which is what makes an import work: the
     * name at the call site and the name at the declaration are the same symbol
     * even when they are spelled differently, and two same-named privates in
     * different files are different symbols even though they are spelled alike.
     *
     * A **generic** is resolved here too, and that is deliberate: the width
     * pass and the body lowerer both arrive through this one door, so
     * instantiating behind it means neither of them has to know that generics
     * exist. What comes back is an ordinary {@link FnRecord} for one
     * instantiation, with a concrete signature — which is the whole claim
     * monomorphisation makes.
     *
     * `"reported"` is the third answer, and it is not the same as `undefined`.
     * A generic that could not be instantiated has already been complained
     * about *here*, with the specific reason; a caller that treats that as "not
     * a function I know" goes on to add "this name is not supported yet" and
     * "this call is not supported yet" underneath it, which is two more
     * diagnostics about a program whose one problem has been named. The same
     * sentinel shape `linalgCall` and `#methodCall` already use.
     */
    resolveCallee(
        call: ts.CallExpression,
        bindings: Substitution,
    ): FnRecord | "reported" | undefined {
        const declaration = this.#calleeDeclaration(call.expression);
        if (declaration?.name === undefined) {
            return undefined;
        }
        const key = this.#keyOf(declaration, declaration.name.text);
        const template = this.#templates.get(key);
        if (template !== undefined) {
            return this.#instantiate(template, {node: call}, bindings) ?? "reported";
        }
        return this.#functions.get(key);
    }

    /**
     * `x.pick<i32>(v)` — one instantiation of a generic **method**.
     *
     * Close to {@link Lowerer.#instantiate} and deliberately not merged with
     * it: the two differ in the three things that matter. A method's copies are
     * keyed by the *class* as well as the method, because `Box<i32>.pick<u8>`
     * and `Box<f64>.pick<u8>` are different functions. Its substitution is the
     * class's and the method's **together**, because the body may mention both.
     * And it takes a receiver, so its signature starts with a
     * `Reference<Self>` — unless it is `static`, which has none.
     *
     * The result is an ordinary {@link FnRecord} for a **direct** call. A
     * generic method is never virtual: a slot holds one function and this is as
     * many as it has type arguments, which is the same reason C++ forbids
     * `virtual` on a member template.
     */
    instantiateMethod(
        info: ClassInfo,
        template: MethodTemplate,
        call: ts.CallExpression,
        bindings: Substitution,
    ): FnRecord | "reported" | undefined {
        const supplied = this.#typeArgumentsOf(
            {name: `${info.name}.${template.name}`, parameters: template.parameters},
            {node: call},
            template.declaration,
        );
        if (supplied === undefined) {
            return "reported";
        }

        const args: MachineType[] = [];
        for (const {type, at} of supplied) {
            const machine = this.erase(at, type, bindings);
            if (machine === undefined) {
                return "reported";
            }
            args.push(machine);
        }

        const key = instantiationKey(`${info.name}#${template.name}`, args);
        const existing = this.#instantiations.get(key);
        if (existing !== undefined) {
            return existing;
        }

        // The class's and the method's together. The class's first, so that a
        // method that shadows its class's parameter name — `<T>` inside
        // `Box<T>` — resolves to its own, which is what TypeScript says too.
        const combined = new Map(info.bindings);
        for (const [parameter, bound] of bindingsOf(template.parameters, args)) {
            combined.set(parameter, bound);
        }

        const params = this.#classFnParams(
            template.declaration,
            combined,
            template.isStatic ? undefined : info,
        );
        const signature = this.#checker.getSignatureFromDeclaration(template.declaration);
        const returns =
            params === undefined || signature === undefined
                ? undefined
                : this.erase(
                    template.declaration.type ?? template.declaration,
                    this.#checker.getReturnTypeOfSignature(signature),
                    combined,
                );
        if (params === undefined || returns === undefined) {
            return "reported";
        }

        const label = `${info.name}.${template.name}<${args.map(renderType).join(", ")}>`;
        const symbol = instantiationSymbol(
            `${info.name}$${template.name}`,
            this.#relative(template.declaration.getSourceFile().fileName),
            key,
            args,
        );
        const self: MachineType = {
            kind: "reference",
            referent: {kind: "class", name: info.name},
        };
        const receiver = template.isStatic ? [] : [self];
        const builder = this.#declareClassFn(
            symbol,
            [...receiver, ...params.map((p) => p.type)],
            returns,
            template.declaration,
        );
        const record = this.#functions.get(symbol);
        if (record === undefined || record.kind !== "defined") {
            this.unsupported(call, `a call to \`${label}\``);
            return "reported";
        }
        this.#instantiations.set(key, record);
        this.#pendingClasses.push({
            kind: template.isStatic ? "static" : "method",
            info,
            bindings: combined,
            node: template.declaration,
            builder,
            params,
            returns,
        });
        return record;
    }

    /**
     * `identity<i32>` written as a **value** — the address of one instantiation.
     *
     * Its own entry point rather than a branch of {@link Lowerer.resolveCallee},
     * because the two differ in what they are allowed to do: a call may infer
     * its type arguments and an address has nothing to infer them *from*. The
     * refusal that follows is therefore a different sentence, not a weaker
     * version of the same one.
     *
     * The bare `identity`, with no angle brackets, never reaches here — it is
     * not an `ExpressionWithTypeArguments` — and answers `undefined` from
     * `functionValueAt` instead, which is right: a generic has no address of
     * its own.
     */
    instantiatedValue(
        expression: ts.ExpressionWithTypeArguments,
        bindings: Substitution,
    ): FnRecord | "reported" | undefined {
        const declaration = this.#calleeDeclaration(expression.expression);
        if (declaration?.name === undefined) {
            return undefined;
        }
        const template = this.#templates.get(this.#keyOf(declaration, declaration.name.text));
        if (template === undefined) {
            return undefined;
        }
        return this.#instantiate(template, {node: expression}, bindings) ?? "reported";
    }

    /**
     * The instantiation of `template` this call wants, making it if it is new.
     *
     * Memoised on the **erased** type arguments, so forty calls to
     * `first<i32>` are one function, and so are `first<i32>` and
     * `first<MyAlias>` where the alias is `i32`. That is the right granularity
     * because the copies differ only in machine types.
     *
     * The body is not lowered here. It goes on {@link Lowerer.#pending} and is
     * drained after the ordinary bodies are, because this runs *from inside*
     * one of them — lowering re-entrantly would put a second `BodyLowerer` on
     * the stack for no reason, and the recursive case (`f<i32>` calling
     * `f<i32>`) would not terminate.
     */
    #instantiate(
        template: FnTemplate,
        use: GenericUse,
        bindings: Substitution,
    ): FnRecord | undefined {
        // Written out, or inferred — and inferred is the common spelling, so it
        // is not a lesser path. `at` is what a diagnostic about one of them
        // underlines: the type argument itself when there is one to point at,
        // and the whole use when tsc worked it out.
        const supplied = this.#typeArgumentsOf(template, use, template.node);
        if (supplied === undefined) {
            return undefined;
        }

        // Erased **here**, under the substitution in force at the call site,
        // which is what makes the result concrete however deep the nesting
        // goes. Inside `outer<T>`, the `T` in `inner<T>(x)` is whatever this
        // instantiation of `outer` bound; and inside `grow<T>`, the `Wrap<T>`
        // in `grow<Wrap<T>>(w)` is a whole struct rather than a type that still
        // mentions a parameter. See `Substitution` for what goes wrong if this
        // is deferred instead.
        const args: MachineType[] = [];
        for (const {type, at} of supplied) {
            const machine = this.erase(at, type, bindings);
            if (machine === undefined) {
                return undefined;
            }
            // Deliberately **not** checked for a value form here. Whether `T`
            // needs one is a property of the body, not of the type argument:
            // `identity<T>(x: T)` does, `sizeOf<T>()` does not, and an opaque
            // handle is a perfectly good argument to the second. Refusing here
            // would refuse the second for the first's reason. The body's own
            // checks report it where it actually matters, and the instantiation
            // note says which call put them there.
            args.push(machine);
        }

        const key = instantiationKey(template.key, args);
        const existing = this.#instantiations.get(key);
        if (existing !== undefined) {
            return existing;
        }

        const label = `${template.name}<${args.map(renderType).join(", ")}>`;

        // `f<T>() { f<Pair<T>>() }` type-checks and never runs out of new type
        // arguments. The limit is arbitrary the way every such limit is; what
        // matters is that it names the chain rather than ending the process.
        const depth = (this.#current?.depth ?? 0) + 1;
        const trail = [...(this.#current?.trail ?? []), label];
        if (depth > MAX_INSTANTIATION_DEPTH) {
            this.error(
                use.node,
                "GF0402",
                `instantiating \`${label}\` here needs another instantiation, and that ` +
                `one needs another, ${MAX_INSTANTIATION_DEPTH} deep so far. The last few:` +
                // Numbered, because the labels repeat: `renderType` names a
                // struct by its name, so every `Wrap` in a chain of nested ones
                // prints as `Wrap`. The numbers are what show it is growing.
                `\n\n${trail
                    .slice(-5)
                    .map((step, index) => `    #${trail.length - 4 + index}  ${step}`)
                    .join("\n")}\n\n` +
                "Each set of type arguments is compiled separately, so a generic that " +
                "calls itself with a *larger* type has no end. Recursion is fine as long " +
                "as the type arguments stop growing — pass on the same ones this copy " +
                "was given, or stop at a function that is not generic.",
            );
            return undefined;
        }

        const symbol = instantiationSymbol(
            template.name,
            this.#relative(template.node.getSourceFile().fileName),
            key,
            args,
        );

        // Declared under the substitution, so the parameters and the return are
        // the *concrete* types this copy has. Everything downstream — the
        // signature, the drop pass, the C classifier — then sees an ordinary
        // monomorphic function and none of them has to know why.
        const instanceBindings = bindingsOf(template.parameters, args);

        const signature = this.#signature(template.node, instanceBindings);
        if (signature === undefined) {
            return undefined;
        }

        const sig = this.#mir.sig({
            params: signature.params.map((param) => ({
                ty: this.tyOf(param.type, template.node),
                name: null,
            })),
            ret: this.tyOf(signature.returns, template.node),
            // Never exported: an instantiation has no symbol a caller outside
            // this build could have agreed on. GENERICS-PLAN §6 is what changes
            // that, and it changes the linkage rather than this.
            //
            // The convention is C when the generic's *address* is taken
            // anywhere, for the reason a plain function's is: a `FnPtr`'s
            // signature is classified by the C rules, so the call through the
            // pointer and the definition have to agree. Conservative on
            // purpose — it marks every instantiation of that generic, not the
            // one whose address was taken — because whether an address is taken
            // is a whole-program fact and the instantiations are made one at a
            // time.
            abi: this.#addressTaken.has(template.node) ? "C" : "Internal",
        });
        const builder = this.#mir.declareFunction({
            name: symbol,
            sig,
            linkage: "Internal",
            span: this.span(template.node),
        });
        const record: FnRecord = {
            kind: "defined",
            id: builder.id,
            sig,
            signature,
            name: template.name,
            exported: false,
        };
        this.#instantiations.set(key, record);
        this.#pending.push({
            node: template.node,
            builder,
            record,
            bindings: instanceBindings,
            key,
            label,
            depth,
            trail,
            at: use.node,
        });
        return record;
    }

    /**
     * A call's type arguments, however it came by them.
     *
     * Written out — `first<i32>(xs)` — they are read from the nodes. Left to
     * tsc — `first(xs)` — they are recovered by unifying the declaration's
     * signature against the resolved one, which is where tsc has already put
     * the answer.
     *
     * The two are the same thing to everything downstream, and that matters
     * more than it looks: `first(xs)` and `first<f64>(xs)` have to be *one*
     * instantiation rather than two identical ones, and they are, because the
     * memo is on the erased arguments and not on how they were spelled.
     *
     * `at` is what a diagnostic about an argument underlines: the argument
     * itself when one was written, the whole call when tsc worked it out.
     */
    #typeArgumentsOf(
        template: { readonly name: string; readonly parameters: readonly ts.Symbol[] },
        use: GenericUse,
        declaration: ts.SignatureDeclaration,
    ): readonly { readonly type: ts.Type; readonly at: ts.Node }[] | undefined {
        const written = use.node.typeArguments;
        if (written !== undefined && written.length === template.parameters.length) {
            return written.map((node) => ({
                type: this.#checker.getTypeFromTypeNode(node),
                at: node,
            }));
        }

        // Only a *call* has anything to infer from. `const f = identity;`
        // written as a value has no argument whose type could say what `T` is,
        // so the answer below is the only one — and it is the right one rather
        // than a shortfall, because there is genuinely nothing there.
        const resolved =
            use.node.kind === ts.SyntaxKind.CallExpression
                ? this.#checker.getResolvedSignature(use.node)
                : undefined;
        const declared = this.#checker.getSignatureFromDeclaration(declaration);
        const inferred =
            resolved === undefined || declared === undefined
                ? undefined
                : inferBindings(this.#checker, template.parameters, declared, resolved);

        if (inferred !== undefined) {
            return template.parameters.map((parameter) => ({
                type: inferred.get(parameter)!,
                at: use.node,
            }));
        }

        // Not "inference is unimplemented" — it is implemented, and this is a
        // use it could not finish. For a call the commonest reason by far is a
        // type parameter that appears nowhere in the arguments; for an address
        // there is no reason at all, because an address has no arguments.
        const undetermined = template.parameters.map((p) => `\`${p.name}\``).join(" and ");
        const one = template.parameters.length === 1;
        const angles = template.parameters.map(() => "…").join(", ");
        this.error(
            use.node,
            "GF0404",
            use.node.kind === ts.SyntaxKind.CallExpression
                ? `this call does not determine ${undetermined}, so there is no way to ` +
                `know which copy of \`${template.name}\` to compile. Write ` +
                `\`${template.name}<${angles}>(…)\` with a concrete type in place of ` +
                `each \`…\`.\n\nA generic is compiled once for each set of type ` +
                `arguments, so ${one ? "it has" : "they have"} to be settled at the ` +
                "call — either by an argument whose type says so, or in writing."
                : `\`${template.name}\` is generic and this takes its *address*, which ` +
                `has no arguments to determine ${undetermined} from. Write ` +
                `\`${template.name}<${angles}>\` with a concrete type in place of each ` +
                "`…`.\n\nA generic has no address of its own: each set of type " +
                "arguments is a separate function, so naming one is how you say which " +
                "function you meant.",
        );
        return undefined;
    }

    /**
     * Lower every instantiation that has been asked for, and everything they
     * ask for in turn.
     *
     * A `while` rather than a `for`, because {@link Lowerer.#instantiate} may
     * push onto the list being drained: an instantiated body is where the next
     * instantiation is discovered. It terminates because the memo means each
     * distinct set of type arguments is pushed once, and the depth limit means
     * there are finitely many.
     *
     * Breadth-first, and nothing depends on the order — but the depth limit
     * does depend on knowing that it *is* breadth-first, which is why depth
     * rides on the item rather than being read off the call stack.
     */
    #drainPending(): void {
        while (this.#pending.length > 0 || this.#pendingClasses.length > 0) {
            // Class members first, and until there are none: a method's body may
            // call a generic, and a generic's body may mention a class — so the
            // two lists feed each other and neither can be finished on its own.
            while (this.#pendingClasses.length > 0) {
                this.#lowerClassBody(this.#pendingClasses.shift()!);
            }
            if (this.#pending.length === 0) {
                continue;
            }
            const pending = this.#pending.shift()!;
            const previousNote = this.#instantiatedAt;
            const previousCurrent = this.#current;
            this.#instantiatedAt = {
                message: `\`${pending.label}\` was instantiated here`,
                location: this.#locationOf(pending.at),
            };
            this.#current = {depth: pending.depth, trail: pending.trail};
            try {
                this.#lowerInstantiation(pending);
            } finally {
                this.#current = previousCurrent;
                this.#instantiatedAt = previousNote;
            }
        }
    }

    /** The `function` declaration a callee expression names, if it names one. */
    #calleeDeclaration(expression: ts.Expression): ts.FunctionDeclaration | undefined {
        let symbol = this.#checker.getSymbolAtLocation(expression);
        if (symbol === undefined) {
            return undefined;
        }
        // An imported name is an *alias* for the thing it imports.
        if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            symbol = this.#checker.getAliasedSymbol(symbol);
        }
        return symbol.declarations?.find(ts.isFunctionDeclaration);
    }

    /**
     * Erase an expression's type without reporting when it cannot be erased.
     *
     * A *probe*, for the places that are deciding what kind of construct they are
     * looking at rather than lowering one. `console.log(x)` is a property access
     * whose receiver has no machine type at all, so anything that asks the width
     * pass about a receiver before knowing it is a value raises a diagnostic
     * about `console` — which is the wrong complaint and stops the compile.
     */
    tryErase(expression: ts.Expression, bindings: Substitution): MachineType | undefined {
        try {
            return erase(
                this.#checker,
                this.#checker.getTypeAtLocation(expression),
                new Erasure(bindings),
            );
        } catch (error) {
            if (error instanceof ErasureError) {
                return undefined;
            }
            throw error;
        }
    }

    /**
     * `f` or `C.f` written as a *value* rather than called.
     *
     * The result is a code address. An instance method is deliberately not here:
     * it needs a receiver, and a function pointer has nowhere to put one — which
     * is the whole reason `static` is what a callback is written as.
     */
    /**
     * Whether this expression is the *name* of a function declaration.
     *
     * Broader than {@link Lowerer.functionValueAt}, and deliberately: an
     * intrinsic like `cstring` is an ambient `declare function` with no address
     * at all, so it has no record here — but it is still a name rather than a
     * value, and treating `cstring(s)` as a call through a function pointer takes
     * it away from the path that knows what it means.
     */
    namesADeclaredFunction(expression: ts.Expression): boolean {
        if (!ts.isIdentifier(expression)) {
            return false;
        }
        let symbol = this.#checker.getSymbolAtLocation(expression);
        if (symbol === undefined) {
            return false;
        }
        if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            symbol = this.#checker.getAliasedSymbol(symbol);
        }
        return symbol.declarations?.some(ts.isFunctionDeclaration) ?? false;
    }

    /**
     * Whether a name that *spells* a prelude intrinsic was declared by the
     * program instead.
     *
     * The globals are matched by **text** — `if (name === MOVE)` — which is fine
     * for `sizeOf` and `nativeCast` and stops being fine the moment one of them
     * is an ordinary English word. A program with its own
     * `function take(s: string)` would have every call to it intercepted by the
     * intrinsic, and the complaint would be about a place to put a default back
     * into, which is a sentence about a feature the author never used.
     *
     * tsc has already answered this: a user file is a module, so a `function
     * take` in it *shadows* the global rather than colliding with it, and the
     * symbol at the call site is the program's. So the question is only whether
     * the symbol's declarations are the prelude's, and the answer is exact
     * rather than heuristic.
     *
     * This is the same argument `STD_MODULES` makes for being keyed by specifier
     * before name — a flat table of names matches any declaration that happens to
     * share one — arriving for the globals.
     */
    shadowsPrelude(expression: ts.Expression): boolean {
        if (!ts.isIdentifier(expression)) {
            return false;
        }
        let symbol = this.#checker.getSymbolAtLocation(expression);
        if (symbol === undefined) {
            return false;
        }
        if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            symbol = this.#checker.getAliasedSymbol(symbol);
        }
        const declarations = symbol.declarations ?? [];
        if (declarations.length === 0) {
            return false;
        }
        const prelude = normalisePath(globalDeclarations());
        return declarations.every(
            (declaration) => normalisePath(declaration.getSourceFile().fileName) !== prelude,
        );
    }

    functionValueAt(expression: ts.Expression): FnRecord | undefined {
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
            const info = this.#classes.get(expression.expression.text);
            const method = info?.statics.get(expression.name.text);
            if (method !== undefined) {
                return this.#functions.get(method.symbol);
            }
            // Not a class name, so it may be a module namespace. Falling through
            // rather than answering "no" here is what lets `alloc.mi_malloc` be
            // handed to `SDL_SetMemoryFunctions` the way the bare name can.
            if (!this.#isModuleNamespace(expression.expression)) {
                return undefined;
            }
            return this.#plainCallee(expression);
        }
        return this.#plainCallee(expression);
    }

    /**
     * The record for a **non-generic** function this expression names.
     *
     * Separate from {@link Lowerer.resolveCallee} because this one is asked in
     * *value* position — `f` handed somewhere as a code address — where there
     * is no call and therefore no type arguments to instantiate with. A generic
     * has no address until it is instantiated, so it answers `undefined` here
     * and the caller reports a name it could not resolve. Taking the address of
     * an *instantiation* is stage 4 of GENERICS-PLAN.
     */
    #plainCallee(expression: ts.Expression): FnRecord | undefined {
        const declaration = this.#calleeDeclaration(expression);
        if (declaration?.name === undefined) {
            return undefined;
        }
        return this.#functions.get(this.#keyOf(declaration, declaration.name.text));
    }

    /**
     * `ns.f` where `ns` is a module namespace — `import * as ns from "…"`.
     *
     * The same function a named import reaches, and that is a fact about tsc
     * rather than an arrangement here: the property access resolves to the
     * *export's* own symbol, so both spellings land on one declaration and
     * therefore one record. Which is what lets one module write
     * `import * as alloc from "std/alloc"` and another
     * `import { mi_malloc } from "std/alloc"` in the same program, and reach the
     * same extern — there is nothing per import to reconcile because there is
     * nothing per import.
     *
     * Only a top-level `function` answers. A method is a `MethodDeclaration`
     * whichever way it is written, so `C.f()` and `obj.m()` fall past this to
     * the paths that know how to find a receiver — which a namespace does not
     * have and never needs.
     */
    namespaceCallee(
        call: ts.CallExpression,
        access: ts.PropertyAccessExpression,
        bindings: Substitution,
    ): FnRecord | "reported" | undefined {
        if (!this.#isModuleNamespace(access.expression)) {
            return undefined;
        }
        // Through `resolveCallee` rather than a lookup, so that a generic
        // reached this way instantiates like one reached by a bare name. tsc
        // resolves `ns.f` to the export's own symbol, so the two spellings
        // arrive at one declaration and there is nothing per import to
        // reconcile.
        return this.resolveCallee(call, bindings);
    }

    /**
     * `ns.f` written as a **value** rather than called.
     *
     * The call form is {@link Lowerer.namespaceCallee}; this one exists because
     * an address has no type arguments and so cannot instantiate anything. A
     * generic answers `undefined` here.
     */
    namespaceValue(access: ts.PropertyAccessExpression): FnRecord | undefined {
        if (!this.#isModuleNamespace(access.expression)) {
            return undefined;
        }
        return this.#plainCallee(access);
    }

    /** Whether this name is a generic class's, with no type arguments on it. */
    namesAGenericClass(name: string): boolean {
        return this.#genericClasses.has(name);
    }

    /** Whether this expression names a generic function. */
    namesAGeneric(expression: ts.Expression): boolean {
        const declaration = this.#calleeDeclaration(expression);
        if (declaration?.name === undefined) {
            return false;
        }
        return this.#templates.has(this.#keyOf(declaration, declaration.name.text));
    }

    /**
     * Whether an expression names a module rather than a value.
     *
     * Through the alias, because `import * as ns` binds a local alias *to* the
     * module: the alias itself carries `Alias`, and only what it points at
     * carries `Module`.
     */
    #isModuleNamespace(expression: ts.Expression): boolean {
        const symbol = this.#checker.getSymbolAtLocation(expression);
        if (symbol === undefined) {
            return false;
        }
        const resolved =
            (symbol.flags & ts.SymbolFlags.Alias) !== 0
                ? this.#checker.getAliasedSymbol(symbol)
                : symbol;
        return (resolved.flags & ts.SymbolFlags.Module) !== 0;
    }

    run(): LowerResult {
        // Every file in the program that is not a declaration file — including
        // the ones tsc calls "external library", which is its word for anything
        // reached through `node_modules`.
        //
        // Those used to be filtered out here, which is right for a TypeScript
        // project: `node_modules` holds JavaScript and `.d.ts` and nothing that
        // wants compiling. It is wrong for this language, in two ways that only
        // appear once the compiler is *installed* rather than checked out.
        // `std/collection` ships inside the package, so a consumer's copy of it
        // lives under `node_modules` and every class in it was silently
        // dropped — the symptom being `GF0001` about a class whose file tsc had
        // resolved and read. And a Goblin library crosses a boundary **as
        // source** (DECISIONS §25), instantiated in the consumer's own
        // compilation, which is the same shape and was broken the same way.
        //
        // Nothing arrives here by accident to make this risky: `noLib`,
        // `types: []` and `typeRoots: []` mean the program is the prelude plus
        // what the entry point imported, transitively. A `.ts` file in it is
        // source this build was asked to compile, wherever it sits on disk.
        const sources = this.#program.getSourceFiles().filter((file) => !file.isDeclarationFile);

        // The prelude's plain C imports, which the loop below never reaches: it
        // walks the program's own files, and the prelude is a declaration file.
        // Only the *record* is made here — `externIdOf` makes the MIR extern at
        // the first call site, so a program that names none of them carries none.
        this.#declarePreludeExterns();

        // Before anything is declared: whether a function's address is taken
        // decides its calling convention, and a declaration cannot be revised once
        // the call that takes the address has been lowered.
        this.#collectAddressTaken(sources);

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
                if (one) {
                    declared.push(one);
                }
            }
        }

        for (const body of classBodies) {
            this.#lowerClassBody(body);
        }
        for (const {node, builder} of declared) {
            this.#lowerBody(node, builder);
        }

        // Last, and to a fixed point: an instantiation is discovered by
        // lowering the body that calls it, so the list this drains is still
        // being added to while it drains. Nothing above needs to have happened
        // first except the bodies — a generic called only from another generic
        // is reached through the worklist like any other.
        this.#drainPending();

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
            return {module: undefined, diagnostics: this.#diagnostics};
        }
        return {module: this.#mir.finish(), diagnostics: this.#diagnostics};
    }

    /** The interned `TyId` of a class, by name. */
    classTy(name: string): TyId | undefined {
        return this.#classTys.get(name);
    }

    classInfo(name: string): ClassInfo | undefined {
        return this.#classes.get(name);
    }

    /**
     * The `ClassInfo` for a class named here, instantiating it if it is a
     * generic's and this is the first mention.
     *
     * `Box<i32>` is a different class from `Box<f64>` — different layout,
     * different vtable, different destructor — so there is one of these per set
     * of type arguments, made the first time anything asks. Everything after
     * that point treats it as an ordinary class, which is the claim
     * monomorphisation makes and the reason nothing downstream changed.
     *
     * The bodies go on {@link Lowerer.#pendingClasses} rather than being
     * lowered here, for the reason a function instantiation's do: this runs
     * from inside a body, and lowering re-entrantly would stack a second
     * `BodyLowerer` for no reason.
     */
    classInfoFor(name: string, args: readonly MachineType[], at: ts.Node): ClassInfo | undefined {
        const known = this.#classes.get(name);
        if (known !== undefined) {
            return known;
        }
        if (args.length === 0) {
            return undefined;
        }

        // `Box<i32>` names the declaration `Box`. Split at the first `<`, which
        // is unambiguous because a class's own name cannot contain one — that
        // is the same property that makes the instantiated name unforgeable.
        const bare = name.slice(0, name.indexOf("<"));
        const node = this.#genericClasses.get(bare);
        if (node === undefined) {
            return undefined;
        }

        const parameters = node.typeParameters ?? [];
        if (parameters.length !== args.length) {
            this.unsupported(at, `\`${name}\`, whose type arguments do not match \`${bare}\``);
            return undefined;
        }

        // `class Box<T> { inner: Box<Box<T>> }` is the class-shaped version of
        // an unbounded generic, and needs the same limit for the same reason.
        if (this.#classDepth >= MAX_INSTANTIATION_DEPTH) {
            this.error(
                at,
                "GF0402",
                `instantiating \`${name}\` needs another instantiation of \`${bare}\`, and ` +
                `that one needs another, ${MAX_INSTANTIATION_DEPTH} deep. Each set of ` +
                "type arguments is a separate class with its own layout, so one that " +
                "contains itself at a *larger* type has no end.",
            );
            return undefined;
        }

        const bindings = new Map<ts.Symbol, MachineType>();
        for (const [index, parameter] of parameters.entries()) {
            const symbol = this.#checker.getSymbolAtLocation(parameter.name);
            if (symbol === undefined) {
                this.unsupported(parameter, "a type parameter tsc could not resolve");
                return undefined;
            }
            bindings.set(symbol, args[index]!);
        }

        this.#classDepth += 1;
        try {
            const info = buildClass(
                node,
                name,
                bindings,
                (baseName) => this.#classes.get(baseName),
                this.#checker,
                {
                    unsupported: (node_, what) => this.unsupported(node_, what),
                    refuse: (node_, message) => this.error(node_, "GF0002", message),
                    erase: (eraseAt, type) => this.erase(eraseAt, type, bindings),
                },
            );
            if (info === undefined) {
                return undefined;
            }
            // Registered **before** the members are declared, so that a method
            // taking or returning a `Box<i32>` interns the class it is a member
            // of rather than asking for it again and recursing.
            this.#classes.set(name, info);
            this.#registerClass(info);
            this.#pendingClasses.push(...this.#declareClassMembers(info));
            // Layout then contracts, immediately, where the eager path has to
            // do each in its own pass. It is safe here for the reason the two
            // passes exist there: by the time anything asks for a `Box<i32>`
            // every ordinary class already has its methods, and nothing derives
            // from an instantiation, because a generic base class is refused —
            // so there is no *other* class whose `defineClass` could come along
            // afterwards and wipe this one's interface list.
            this.#defineClassLayout(info);
            this.#registerDeclaredInterfaces(info);
            return info;
        } finally {
            this.#classDepth -= 1;
        }
    }

    /** The record for a function emitted under a generated symbol. */
    fn(symbol: string): FnRecord | undefined {
        return this.#functions.get(symbol);
    }

    /** Whether `name` is `base`, or derives from it through any number of steps. */
    derivesFrom(name: string, base: string): boolean {
        let info = this.#classes.get(name);
        while (info !== undefined) {
            if (info.name === base) {
                return true;
            }
            info = info.base;
        }
        return false;
    }

    /**
     * The type an accessor reads or writes.
     *
     * A getter's return type, or a setter's parameter type — the same question
     * asked of whichever half exists, so that `x.name` and `x.name = v` agree
     * about what `name` is.
     */
    /**
     * The type an accessor reads or writes, under **the class's** substitution.
     *
     * Not the asking body's. `b.held` in some other function asks what a
     * `Box<i32>`'s getter returns, and answering under that function's
     * substitution erased `T` as a parameter nothing had bound. A method
     * escaped this because its signature is recorded once at declaration; an
     * accessor is re-erased at each use, which is what made it visible.
     */
    accessorType(
        info: ClassInfo,
        accessor: ClassMethod | StaticMethod,
    ): MachineType | undefined {
        const bindings = info.bindings;
        const declaration = accessor.declaration;
        if (ts.isSetAccessorDeclaration(declaration)) {
            const parameter = declaration.parameters[0];
            if (parameter === undefined) {
                this.unsupported(declaration, "a setter with no parameter");
                return undefined;
            }
            return this.erase(parameter, this.#checker.getTypeAtLocation(parameter), bindings);
        }
        const signature = this.#checker.getSignatureFromDeclaration(declaration);
        if (signature === undefined) {
            this.unsupported(declaration, "an accessor tsc could not give a signature to");
            return undefined;
        }
        return this.erase(
            declaration,
            this.#checker.getReturnTypeOfSignature(signature),
            bindings,
        );
    }

    /**
     * The element type, when this expression is a `T[]` or a reference to one.
     *
     * A *probe*: it answers `undefined` rather than reporting, because the caller
     * is deciding whether a property access is an array call at all and most of
     * them are not.
     */
    arrayElementAt(
        expression: ts.Expression,
        bindings: Substitution,
    ): MachineType | undefined {
        const type = this.#checker.getTypeAtLocation(expression);
        const candidates = type.isIntersection() ? type.types : [type];
        for (const part of candidates) {
            if (!this.#checker.isArrayType(part)) {
                continue;
            }
            const element = this.#checker.getIndexTypeOfType(part, ts.IndexKind.Number);
            if (element === undefined) {
                continue;
            }
            return this.erase(expression, element, bindings);
        }
        return undefined;
    }

    /**
     * Whether this expression is a `readonly T[]` — an array this code may read
     * and may not write.
     *
     * Only `take` asks. Every other way of writing an element is spelled as a
     * write and tsc refuses it on its own: `xs[0] = v` is `TS2542`, `xs.push(v)`
     * is `TS2339` because the method is not on the type. `take(xs[0])` is the
     * one that gets through, because it is spelled as a *read* — the default it
     * puts back is this compiler's doing and nothing in the signature says so.
     *
     * The **index signature's own modifier** answers, rather than the name of
     * the type: `Reference<readonly T[]>` is an intersection, and the array half
     * is the half that knows.
     */
    readonlyArrayAt(expression: ts.Expression): boolean {
        const type = this.#checker.getTypeAtLocation(expression);
        const candidates = type.isIntersection() ? type.types : [type];
        for (const part of candidates) {
            if (!this.#checker.isArrayType(part)) {
                continue;
            }
            const info = this.#checker.getIndexInfoOfType(part, ts.IndexKind.Number);
            if (info !== undefined) {
                return info.isReadonly;
            }
        }
        return false;
    }

    /**
     * The base whose constructor this class does **not** inherit, or
     * `undefined` when constructing it is fine.
     *
     * C++'s rule, and for C++'s reason: a base's constructor initialises the
     * base's fields and knows nothing about the derived class's, so it is
     * precisely the constructor that cannot be right for the class inheriting
     * it. `using Base::Base` is the opt-in there and has no spelling here.
     *
     * tsc disagrees — `new Derived(4)` is a call to `Base`'s constructor as far
     * as it is concerned — so it type-checks the arguments against the base's
     * signature and hands over a call this compiler has no constructor for.
     * Without this the failure is the *arity* check reporting that a generated
     * constructor takes none of the arguments tsc just insisted on, which
     * describes the symptom and names neither the rule nor the fix.
     *
     * A base that takes no arguments is not a problem: there is nothing to
     * forward, and the generated constructor calls it the way C++'s implicit
     * default constructor does.
     */
    uninheritedConstructor(info: ClassInfo): ClassInfo | undefined {
        if (info.ctor !== undefined) {
            return undefined;
        }
        for (let base = info.base; base !== undefined; base = base.base) {
            if (base.ctor === undefined) {
                continue;
            }
            return base.ctor.parameters.length > 0 ? base : undefined;
        }
        return undefined;
    }

    classNameAt(expression: ts.Expression, bindings: Substitution): string | undefined {
        // The **erasure** first, because it is the only answer that has the
        // substitution in it. Inside a generic, tsc still says `T` however the
        // instantiation was made — so asking it directly finds no class, the
        // method-call path decides this is not a method, and `x.speak()` on a
        // `Reference<T>` quietly lowered to nothing and returned zero.
        //
        // Erasure knows, because a binding carries the machine type the call
        // site erased. Everything below is the fallback for expressions that do
        // not erase at all, which is most of what this is asked about.
        const erased = this.tryErase(expression, bindings);
        const behind = erased === undefined ? undefined : behindOneIndirection(erased) ?? erased;
        if (behind?.kind === "class") {
            // Asking is also what *makes* a generic class, here as in `tyOf`:
            // this is the door the width pass and the method-call path come
            // through, and a `Pointer<Box<i32>>` reified out of a `void *` may
            // be the first mention of `Box<i32>` anywhere.
            if (behind.args !== undefined) {
                this.classInfoFor(behind.name, behind.args, expression);
            }
            if (this.#classes.has(behind.name)) {
                return behind.name;
            }
        }

        const type = this.#checker.getTypeAtLocation(expression);
        const direct = classNameOf(type);
        if (direct !== null && this.#classes.has(direct)) {
            return direct;
        }
        // `Reference<C>` is `C & ReferenceCore<C>`, so the class is one of the
        // intersection's members rather than the type itself.
        if (type.isIntersection()) {
            for (const part of type.types) {
                const name = classNameOf(part);
                if (name !== null && this.#classes.has(name)) {
                    return name;
                }
            }
        }
        return undefined;
    }

    // -- declarations --------------------------------------------------------

    /**
     * The MIR extern for an imported function, made on first use.
     *
     * Memoised by C name, exactly as {@link runtimeFn} is, and for the same
     * reason: an extern is an undefined symbol, so the module should carry one
     * only for a symbol it actually calls.
     */
    externIdOf(record: Extract<FnRecord, { kind: "imported" }>): ExternId {
        const existing = this.#externs.get(record.name);
        if (existing !== undefined) {
            return existing;
        }
        const id = this.#mir.extern({
            name: record.name,
            sig: record.sig,
            span: this.span(record.declaration),
        });
        this.#externs.set(record.name, id);
        return id;
    }

    /**
     * The MIR signature id for a function-pointer type.
     *
     * Always the C classification — see the `fnptr` note on `MachineType`. Shared
     * with the call site so that a `FnPtr`'s type and a call through it cannot
     * disagree about how an aggregate parameter travels.
     */
    sigOf(type: Extract<MachineType, { kind: "fnptr" }>, at: ts.Node): SigId {
        return this.#mir.sig({
            params: type.params.map((param) => ({ty: this.tyOf(param, at), name: null})),
            ret: this.tyOf(type.returns, at),
            abi: "C",
        });
    }

    /**
     * The signature a `LocalFn`'s code pointer has: the environment first, then
     * the parameters as written.
     *
     * The environment is a `Pointer<unknown>` — C's `void *` — and not a pointer
     * to the environment's real struct, because the type has to be the same for
     * every closure a given `LocalFn<F>` parameter can receive, and each of those
     * has an environment of its own shape. The lifted body attaches the type back
     * with a `PtrToPtr` cast on entry, which is what `reify<T>()` does at the
     * source level (DECISIONS §13) and what an interface method's receiver
     * already does one file over.
     *
     * `Internal`, not `C`: a `LocalFn` never crosses a boundary — `#checkCBoundary`
     * refuses one — so there is no second party whose classification has to be
     * matched, and the C rules would only cost aggregate parameters a trip
     * through memory.
     */
    localFnSig(type: Extract<MachineType, { kind: "localfn" }>, at: ts.Node): SigId {
        return this.#mir.sig({
            params: [
                {ty: this.#mir.ty({kind: "Pointer", value: this.#mir.ty({kind: "Void"})}), name: null},
                ...type.params.map((param) => ({ty: this.tyOf(param, at), name: null})),
            ],
            ret: this.tyOf(type.returns, at),
            abi: "Internal",
        });
    }

    /**
     * The type of a `LocalFn`'s code field, for the constant that names the
     * lifted function.
     *
     * A `FnPtr` constant carries its type because the signature it is classified
     * by is not recoverable from the function alone, and the closure site is the
     * one place that has to spell it.
     */
    localFnCodeTy(type: Extract<MachineType, { kind: "localfn" }>, at: ts.Node): TyId {
        return this.#mir.ty({kind: "FnPtr", value: this.localFnSig(type, at)});
    }

    /**
     * The MIR type of a `LocalFn` value: a code address and an environment.
     *
     * A struct of two words rather than a `TyKind` of its own. The rule that
     * makes a `LocalFn` different from a pair of pointers — that it may not
     * outlive the call — is a frontend rule, checked where `LocalFn<F>` is still
     * spelled, so a dedicated MIR node would carry no information the backend
     * acts on and would cost a wire-format fingerprint to add. `Reference<I>`
     * travels as an `(itab, data)` pair for the same reason.
     */
    #localFnTy(type: Extract<MachineType, { kind: "localfn" }>, at: ts.Node): TyId {
        const name = `LocalFn$${type.params.map(renderType).join("$")}$to$${renderType(type.returns)}`;
        const existing = this.#localFns.get(name);
        if (existing !== undefined) {
            return existing;
        }
        const id = this.#mir.struct({
            name,
            fields: [
                {name: "code", ty: this.#mir.ty({kind: "FnPtr", value: this.localFnSig(type, at)})},
                {
                    name: "env",
                    ty: this.#mir.ty({kind: "Pointer", value: this.#mir.ty({kind: "Void"})}),
                },
            ],
        });
        const ty = this.#mir.ty({kind: "Struct", value: id});
        this.#localFns.set(name, ty);
        return ty;
    }

    /**
     * Lift an arrow function into a function of its own, and say what its
     * environment has to contain.
     *
     * The environment is built by the *caller*, at the closure site, because
     * that is the frame the captures live in and the only place their addresses
     * can be taken — so this returns the bindings it captured rather than
     * emitting anything into the enclosing body. The two halves have to agree
     * about field order, and they do by both reading this list.
     *
     * Runs while the enclosing function is mid-lowering, which is safe because a
     * `FunctionBuilder` and a `BodyLowerer` own no shared mutable state: the
     * only thing they share is the module's type and symbol tables, which are
     * interned rather than positional.
     */
    liftClosure(
        node: ts.ArrowFunction | ts.FunctionExpression,
        type: Extract<MachineType, { kind: "localfn" }>,
        enclosing: Scopes,
        self: ClassInfo | undefined,
        /**
         * The enclosing body's substitution, which the lifted one inherits.
         *
         * A closure written inside a generic is part of that instantiation and
         * sees the same `T`. Passing it in rather than starting the lifted body
         * with an empty one is the whole of what makes that true.
         */
        bindings: Substitution,
    ): LiftedClosure | undefined {
        // Where `this` comes from, decided once and for the whole form.
        //
        // An arrow captures the enclosing method's `this` lexically, which is
        // TypeScript's rule and the one Goblin can keep. A `function` expression
        // binds its own, from the receiver at the call site — and a `LocalFn` is a
        // code address and an environment, with nowhere to put a receiver and no
        // call sequence that supplies one. So `this` in there is not a *different*
        // `this`; it is one that nothing can ever provide.
        //
        // tsc refuses the bare spelling first, under `noImplicitThis`. The
        // declared one, `function (this: Box) { … }`, it accepts — that is a
        // promise about what a caller will supply, and this is the caller saying
        // it cannot.
        const declaredThis = thisParameterOf(node);
        if (declaredThis !== undefined || (ts.isFunctionExpression(node) && usesThis(node))) {
            this.error(
                declaredThis ?? node,
                "GF0002",
                "a `function` expression takes its `this` from the receiver at the call " +
                "site, and a `LocalFn` is a code address and an environment with no " +
                "receiver in it — so nothing here can supply one. Write it as an arrow " +
                "function, which captures the enclosing `this` instead of expecting to " +
                "be given one.",
            );
            return undefined;
        }

        // The written parameters. A declared `this` is `parameters[0]` in the AST
        // and absent from tsc's signature, which is refused above — so past here
        // the two agree and a disagreement really is a compiler bug.
        const written = node.parameters;
        if (written.length !== type.params.length) {
            this.unsupported(node, "a closure whose arity tsc and the lowerer disagree on");
            return undefined;
        }

        const params: { name: string; type: MachineType }[] = [];
        for (const [index, parameter] of written.entries()) {
            if (!ts.isIdentifier(parameter.name)) {
                this.unsupported(parameter, "a destructured closure parameter");
                return undefined;
            }
            if (parameter.questionToken || parameter.dotDotDotToken || parameter.initializer) {
                this.unsupported(parameter, "an optional, rest, or defaulted closure parameter");
                return undefined;
            }
            params.push({name: parameter.name.text, type: type.params[index]!});
        }

        // Names the enclosing scope stack does not know are not captures: a
        // top-level function, an enum member, an ambient declaration. They resolve
        // exactly as they would outside a closure, through the paths that already
        // handle them.
        //
        // `this` joins the list as an ordinary name, because that is what it is
        // here: a local of type `Reference<Self>` bound under that name. Capturing
        // it needs no second mechanism, and deliberately does not get one — the
        // environment holds a reference to the local holding the reference, which
        // is one more indirection than strictly required and one fewer shape of
        // capture to keep in agreement.
        const names = [...capturedNames(node, this.#checker), ...(usesThis(node) ? ["this"] : [])];
        const captures: { name: string; binding: Binding }[] = [];
        for (const name of names) {
            const binding = enclosing.lookup(name);
            if (binding !== undefined) {
                captures.push({name, binding});
            }
        }
        const index = this.#liftedCount++;
        let env: { ty: TyId; pointer: TyId } | undefined;
        if (captures.length > 0) {
            const envId = this.#mir.struct({
                name: `LocalFnEnv$${index}`,
                // A `Reference<T>` per capture, which is what makes a write inside the
                // closure land on the enclosing frame's local rather than on a copy.
                // Category `Borrow`, so the drop pass places nothing here: the frame
                // that owns these values is still the frame that destroys them.
                //
                // `binding.ty` is the *value's* type even when the binding is itself a
                // capture, which is what makes nesting cost nothing. The field operand
                // at the closure site is a `Ref` of the binding's place, and a capture's
                // place ends in a `Deref` — so taking its address hands back the address
                // that was dereferenced, which is the original frame's slot rather than
                // the enclosing environment's. Depth never accumulates indirections; a
                // closure three deep reads its captures with the same two loads as one.
                fields: captures.map((capture) => ({
                    name: capture.name,
                    ty: this.#mir.ty({kind: "Reference", value: capture.binding.ty}),
                })),
                span: this.span(node),
            });
            const ty = this.#mir.ty({kind: "Struct", value: envId});
            env = {ty, pointer: this.#mir.ty({kind: "Pointer", value: ty})};
        }

        const builder = this.#mir.declareFunction({
            name: `closure$${index}`,
            sig: this.localFnSig(type, node),
            span: this.span(node),
        });

        // The captures go in first, so that a parameter shadowing a captured name
        // wins the lookup — which is what the source says, the parameter being the
        // inner binding.
        const scopes = new Scopes();
        const typed =
            env === undefined
                ? undefined
                : builder.addLocal({ty: env.pointer, storage: "Owned", name: "env"});
        if (typed !== undefined) {
            captures.forEach((capture, field) => {
                scopes.declare(capture.name, {
                    local: typed,
                    type: capture.binding.type,
                    ty: capture.binding.ty,
                    // `*(*env).field` — through the environment, to the reference, to
                    // the value the enclosing frame still owns.
                    projection: [
                        {kind: "Deref"},
                        {kind: "Field", value: FieldId(field)},
                        {kind: "Deref"},
                    ],
                });
            });
        }
        // Local 0 is the return place and local 1 is the erased environment
        // pointer, so the written parameters start at 2.
        params.forEach((param, position) => {
            scopes.declare(param.name, {
                local: LocalId(2 + position),
                type: param.type,
                ty: this.tyOf(param.type, node),
            });
        });

        const lowerer = new BodyLowerer(this, builder, scopes, type.returns, bindings);
        if (self !== undefined) {
            // `inConstructor` is false even for a closure written inside one: the
            // only thing it gates is `super(…)`, which is meaningless in a closure
            // and which tsc rejects there anyway.
            lowerer.setClassContext(self, false);
        }
        lowerer.runClosure(
            node.body,
            typed === undefined || env === undefined
                ? undefined
                : {local: typed, parameter: LocalId(1), ty: env.pointer},
        );
        return {func: builder.id, captures: captures.map((capture) => capture.binding), env};
    }

    /**
     * The MIR type of a vector: `<3 x f64>`.
     *
     * Reached directly rather than through {@link Lowerer.tyOf}, because there
     * is no `MachineType` for one and there should not be. A vector is not a
     * type the *language* has — no binding, field, parameter or return is ever
     * one — it is what a `dvec3` becomes between a load and a store, and the
     * only thing that names one is the lowering of an operation (DECISIONS
     * §22).
     */
    simdTy(elem: "F32" | "F64", lanes: number): TyId {
        return this.#mir.ty({kind: "Simd", elem, lanes});
    }

    /** The MIR type id for an erased machine type. */
    tyOf(type: MachineType, at: ts.Node): TyId {
        switch (type.kind) {
            case "void":
                return this.#mir.ty({kind: "Void"});
            case "bool":
                return this.#mir.ty({kind: "Bool"});
            case "string":
                return this.#mir.ty({kind: "Str"});
            case "cstring":
                return this.#mir.ty({kind: "CStr"});
            case "struct":
                return this.#structTy(type, at);
            case "class": {
                // Interning a class is also what *makes* one, when it is a
                // generic's instantiation nothing has mentioned yet. This is
                // the choke point every mention goes through — a parameter, a
                // field, a `new`, a local — so it is the one place that has to
                // know, and everything upstream keeps treating `Box<i32>` as an
                // ordinary class name.
                if (type.args !== undefined && this.classTy(type.name) === undefined) {
                    this.classInfoFor(type.name, type.args, at);
                }
                const ty = this.classTy(type.name);
                if (ty === undefined) {
                    this.unsupported(at, `the class \`${type.name}\``);
                    return this.#mir.ty({kind: "Void"});
                }
                return ty;
            }
            case "interface":
                return this.#interfaceTy(type, at);
            // No layout, and no value form — the backend panics if anything asks for
            // either. It reaches the MIR at all so that a `Pointer<FILE>` keeps the
            // handle's *name*, which is what the generated C header forward-declares
            // and what a diagnostic can say out loud.
            case "opaque":
                return this.#mir.ty({kind: "Opaque", value: this.#mir.sym(type.name)});
            case "reference":
                return this.#mir.ty({kind: "Reference", value: this.tyOf(type.referent, at)});
            case "pointer":
                return this.#mir.ty({kind: "Pointer", value: this.tyOf(type.pointee, at)});
            // Both hold their elements **inline**, so an element with no size is not
            // a thing either can be made of. A `Pointer<FILE>[]` is fine and is what
            // anyone actually wants: the pointer has a size, whatever it points at.
            case "fixedArray":
                if (
                    !this.requireValueForm(type.element, at, "a `FixedArray` element") ||
                    !this.refuseEscape(type.element, at, "a `FixedArray` element")
                ) {
                    return this.#mir.ty({kind: "Void"});
                }
                return this.#mir.ty({
                    kind: "FixedArray",
                    element: this.tyOf(type.element, at),
                    length: BigInt(type.length),
                });
            case "array":
                if (
                    !this.requireValueForm(type.element, at, "an array element") ||
                    !this.refuseEscape(type.element, at, "an array element")
                ) {
                    return this.#mir.ty({kind: "Void"});
                }
                return this.#mir.ty({kind: "Array", value: this.tyOf(type.element, at)});
            // Always the C classification. A function pointer exists so that a call
            // site and a definition agree without sharing a declaration, and C's
            // rules are the only ones anything outside this build knows — so an
            // internal calling convention here would be a second, invisible ABI that
            // happens to work until the first aggregate parameter.
            case "fnptr":
                return this.#mir.ty({kind: "FnPtr", value: this.sigOf(type, at)});
            case "localfn":
                return this.#localFnTy(type, at);
            case "scalar":
                if (type.name === "f32" || type.name === "f64") {
                    return this.#mir.ty({
                        kind: "Float",
                        value: type.name === "f32" ? "F32" : "F64",
                    });
                }
                return this.#mir.ty({kind: "Int", value: INT_TY[type.name]});
            default:
                this.unsupported(at, `the type \`${renderType(type)}\``);
                return this.#mir.ty({kind: "Void"});
        }
    }

    /**
     * Declare a runtime function, once per module.
     *
     * Ordinary `extern "C"` imports called with ordinary `Call` terminators.
     * There is no privileged channel into the runtime, and a MIR dump shows the
     * calls, which is where you want to see them.
     */
    runtimeFn(name: string, params: MachineType[], ret: MachineType, at: ts.Node): ExternId {
        const existing = this.#externs.get(name);
        if (existing !== undefined) {
            return existing;
        }
        const id = this.#mir.extern({
            name,
            sig: this.#mir.sig({
                params: params.map((param) => ({ty: this.tyOf(param, at), name: null})),
                ret: this.tyOf(ret, at),
                abi: "C",
            }),
        });
        this.#externs.set(name, id);
        return id;
    }

    /** By the contract's {@link layoutKey}, never its name — see {@link Lowerer.#interfaceTy}. */
    interfaceId(key: string): InterfaceId | undefined {
        return this.#interfaces.get(key);
    }

    classId(name: string): ClassId | undefined {
        return this.#classIds.get(name);
    }

    interfaceInfo(key: string): Extract<MachineType, { kind: "interface" }> | undefined {
        return this.#interfaceInfo.get(key);
    }

    implement(className: string, contract: Extract<MachineType, { kind: "interface" }>, at: ts.Node): boolean {
        // Idempotent, and it has to be: the propagation below re-enters this for
        // every derived class, and a three-deep hierarchy would otherwise walk
        // itself forever.
        const contractKey = layoutKey(contract);
        const key = `${className}\0${contractKey}`;
        if (this.#implemented.has(key)) {
            return true;
        }
        this.#implemented.add(key);

        const classId = this.#classIds.get(className);
        const info = this.#classes.get(className);
        const interfaceId = this.#interfaces.get(contractKey);
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
            if (derivedName === className) {
                continue;
            }
            let base = derived.base;
            let inherits = false;
            while (base !== undefined) {
                if (base.name === className) {
                    inherits = true;
                    break;
                }
                base = base.base;
            }
            if (inherits) {
                this.implement(derivedName, contract, at);
            }
        }
        return true;
    }

    /**
     * `E.A` — the enum member this names, if it names one.
     *
     * Asked of tsc's symbol rather than of the spelling, so an imported enum and
     * an aliased one resolve the same way a local one does.
     */
    enumMemberAt(expression: ts.PropertyAccessExpression): ts.EnumMember | undefined {
        const declaration = this.#checker.getSymbolAtLocation(expression.name)?.declarations?.[0];
        return declaration !== undefined && ts.isEnumMember(declaration) ? declaration : undefined;
    }

    /**
     * Erase a type, or report and return `undefined`.
     *
     * `bindings` has **no default**, and that is the point: a caller inside a
     * generic body that forgets to pass the instantiation's substitution
     * erases `T` as "nothing says what it is" rather than as the concrete type,
     * and a default would let that happen silently at whichever of the thirty
     * call sites was overlooked. Requiring it makes tsc the thing that finds
     * them. Outside a generic the answer is {@link NO_BINDINGS}, written out.
     */
    erase(at: ts.Node, type: ts.Type, bindings: Substitution): MachineType | undefined {
        try {
            return erase(this.#checker, type, new Erasure(bindings));
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
        const {line, character} = source.getLineAndCharacterOfPosition(node.getStart(source));
        return {file: this.#mir.file(source.fileName), line: line + 1, col: character + 1};
    }

    // -- shared services -----------------------------------------------------

    unsupported(node: ts.Node, what: string): void {
        this.error(
            node,
            "GF0001",
            `${what} is not supported yet. This is a gap in the compiler rather than a ` +
            `rule about the language.`,
        );
    }

    /**
     * Refuse an operation that needs a layout the build does not have.
     *
     * Every arithmetic or allocation operation on a pointer needs the pointee's
     * size: a stride to index by, a size and an alignment to hand `dealloc`. An
     * opaque handle has none of those, and the backend **panics** rather than
     * inventing them — so this is the check that turns the panic into a sentence
     * with a line number. POINTER-ERASURE.md is the long form: a type with no
     * layout does not refuse these operations on its own, because the obvious
     * stand-ins (a zero-field struct, `void`) have a size of zero and an
     * alignment of one, and answer every question wrongly rather than not at all.
     *
     * Returns `false` when it reported, so callers read as a guard.
     */
    /**
     * Refuse an opaque handle used as a *value*.
     *
     * A `Pointer<FILE>` travels; a `FILE` does not exist here at all. Without
     * this the type reaches the backend, which has no register width and no
     * aggregate size for it and panics — correctly, but with no line to point at.
     */
    requireValueForm(type: MachineType, at: ts.Node, what: string): boolean {
        if (type.kind !== "opaque") {
            return true;
        }
        this.error(
            at,
            "GF0302",
            `\`${type.name}\` is declared elsewhere, so this build has never seen its ` +
            `fields and cannot hold one: ${what} needs a size, and there is none. ` +
            `Use \`Pointer<${type.name}>\`, which is an address and is exactly what ` +
            "the library hands out.",
        );
        return false;
    }

    /**
     * Refuse a `LocalFn` where the value would outlive the frame its environment
     * is in — DECISIONS §18's escape rule, at the type positions that outlive a
     * call: a return type, a field, an element.
     *
     * A **parameter** is deliberately not one of them, and that is the point:
     * passing a closure down is bounded by the call, so it is the one direction
     * that is always safe. Binding one to a name inside the callee is safe for
     * the same reason and is not checked here, because a local cannot outlive
     * the frame it is declared in.
     */
    refuseEscape(type: MachineType, at: ts.Node, what: string): boolean {
        if (type.kind !== "localfn") {
            return true;
        }
        this.error(
            at,
            "GF0239",
            `${what} is a \`${renderType(type)}\`, whose environment lives in the frame ` +
            "that wrote the closure — so it stops being valid the moment that frame " +
            "returns, and this outlives it. Call it where it was passed, or pass it " +
            "on to another `LocalFn` parameter.",
        );
        return false;
    }

    requireKnownLayout(type: MachineType, at: ts.Node, what: string): boolean {
        // The other type with no layout, and the other reason for it: an opaque
        // handle's is somewhere else, an erased pointer's was thrown away on
        // purpose. Both refuse the same operations, so they share this guard — and
        // the guard is why they are refused at all. `void` *has* a layout, of zero
        // bytes aligned to one, so nothing below here would fail on its own; it
        // would stride by nothing and hand `dealloc` a size of nothing.
        if (type.kind === "void") {
            this.error(
                at,
                "GF0305",
                `\`void\` is the absence of a value, so it has no size and no alignment, ` +
                `and ${what} needs both. A \`Pointer<unknown>\` is C's \`void *\` — an ` +
                "address whose type was thrown away — and getting at what is behind " +
                "one means attaching a type back first with `p.reify<T>()`.",
            );
            return false;
        }
        if (type.kind !== "opaque") {
            return true;
        }
        this.error(
            at,
            "GF0302",
            `\`${type.name}\` is declared elsewhere, so this build does not know its ` +
            `size or its alignment, and ${what} needs both. A \`Pointer<${type.name}>\` ` +
            "can be passed, returned, stored and compared — that is the whole point of " +
            "an opaque handle — but only the library that defines it can do arithmetic " +
            "on one.",
        );
        return false;
    }

    error(node: ts.Node, code: string, message: string): void {
        this.#diagnostics.push({
            severity: "error",
            code,
            source: "goblin",
            message,
            location: this.#locationOf(node),
            // The instantiation backtrace, when there is one. Every diagnostic
            // raised while an instantiated body is being lowered points inside
            // a generic the reader may never have looked at, and the note is
            // what says which call put it there — the same job C++'s
            // "required from here" does.
            ...(this.#instantiatedAt === undefined ? {} : {notes: [this.#instantiatedAt]}),
        });
    }

    #locationOf(node: ts.Node) {
        const source = node.getSourceFile();
        const start = node.getStart(source);
        const {line, character} = source.getLineAndCharacterOfPosition(start);
        return {
            file: source.fileName,
            line: line + 1,
            column: character + 1,
            length: Math.max(1, node.getEnd() - start),
        };
    }

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
        if (exported) {
            return name;
        }
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
        // A std module that is real Goblin source — `std/collection` — is never
        // under the project root, so the clause above cannot reach it and the
        // fallback would tag it with an absolute path. That path is the checkout
        // on one machine, a `node_modules` entry on another, and a cache
        // directory under the user's home when the packaged CLI extracts it: the
        // same sources would produce three different symbols for the same
        // internal function.
        //
        // DECISIONS §20 recorded this as the first thing to fix if a std module
        // ever became real source. It is, so this is that fix — and the tag it
        // hands back is the specifier a program would have imported, which is
        // both stable and legible in a disassembly.
        const std = stdLibrary().replaceAll("\\", "/");
        if (std !== "" && path.startsWith(`${std}/`)) {
            return `std/${path.slice(std.length + 1)}`;
        }
        return path;
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
        if (!exported) {
            return false;
        }
        if (this.#entry === "") {
            return true;
        }
        return node.getSourceFile().fileName.replaceAll("\\", "/") === this.#entry;
    }

    /**
     * Find every function referred to as a value rather than called.
     *
     * The distinction is entirely syntactic — `f(1)` calls, `f` does not — so
     * this collects the callee position of every call first and then treats any
     * remaining reference as an address.
     */
    #collectAddressTaken(sources: readonly ts.SourceFile[]): void {
        const callees = new Set<ts.Node>();
        const findCalls = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
                callees.add(node.expression);
            }
            ts.forEachChild(node, findCalls);
        };
        for (const source of sources) {
            findCalls(source);
        }

        const scan = (node: ts.Node): void => {
            // The `f` in `obj.f` is not an independent reference to `f`; the whole
            // property access is. Skipping it keeps `C.f()` from looking like an
            // address taken through its own name.
            const parent: ts.Node | undefined = node.parent;
            // A declaration's own name is not a reference to it. Without this, every
            // `function f(…)` marks `f` as having its address taken — which quietly
            // moves the whole program onto the C calling convention, and then fails
            // on the first parameter that cannot cross a C boundary.
            const isDeclarationName =
                parent !== undefined &&
                (ts.isFunctionDeclaration(parent) ||
                    ts.isMethodDeclaration(parent) ||
                    ts.isClassDeclaration(parent) ||
                    ts.isVariableDeclaration(parent) ||
                    ts.isParameter(parent) ||
                    ts.isPropertyDeclaration(parent) ||
                    ts.isBindingElement(parent)) &&
                parent.name === node;

            const isMemberName =
                parent !== undefined &&
                ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
                    (ts.isQualifiedName(parent) && parent.right === node));

            if (
                (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
                !callees.has(node) &&
                !isMemberName &&
                !isDeclarationName
            ) {
                for (const declaration of this.#checker.getSymbolAtLocation(node)?.declarations ?? []) {
                    if (ts.isFunctionDeclaration(declaration)) {
                        this.#addressTaken.add(declaration);
                    } else if (ts.isMethodDeclaration(declaration) && isStaticMember(declaration)) {
                        this.#addressTaken.add(declaration);
                    }
                }
            }
            ts.forEachChild(node, scan);
        };
        for (const source of sources) {
            scan(source);
        }
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
        const collected = collectClasses(this.#program, this.#checker, {
            unsupported: (node, what) => this.unsupported(node, what),
            refuse: (node, message) => this.error(node, "GF0002", message),
            // Nothing collected eagerly is inside a generic: a generic class is
            // set aside rather than analysed, and instantiated on demand by
            // {@link Lowerer.classInfoFor}.
            erase: (at, type) => this.erase(at, type, NO_BINDINGS),
        });
        this.#classes = collected.classes;
        this.#genericClasses = collected.generics;
        this.#refuseInlineCycles();

        for (const info of this.#classes.values()) {
            this.#registerClass(info);
        }

        const bodies: ClassBody[] = [];
        for (const info of this.#classes.values()) {
            bodies.push(...this.#declareClassMembers(info));
        }
        // Three passes over all of them, not one pass doing three things, and
        // the separation is load-bearing in both directions.
        //
        // `implement` needs every class's methods to have a `FuncId`, because
        // it resolves each derived class's *final overriders* — so it cannot
        // run before the declaring loop above has finished.
        //
        // And `defineClass` **rewrites a class's interface list wholesale**, so
        // it cannot run after. Interleaving the two per class did exactly that:
        // `Base implements Speaker` propagated an itab to `Middle`, and
        // `Middle`'s own `defineClass` — one iteration later — wiped it. Every
        // `tryCast` on a derived class then answered null.
        for (const info of this.#classes.values()) {
            this.#defineClassLayout(info);
        }
        for (const info of this.#classes.values()) {
            this.#registerDeclaredInterfaces(info);
        }
        return bodies;
    }

    /** Reserve a class's `ClassId` and `TyId`, so `Reference<Self>` can intern. */
    #registerClass(info: ClassInfo): void {
        const id = this.#mir.declareClass({
            name: info.name,
            base: (info.base ? this.#classIds.get(info.base.name) : null) ?? null,
            span: this.span(info.node),
        });
        this.#classIds.set(info.name, id);
        this.#classTys.set(info.name, this.#mir.ty({kind: "Class", value: id}));
    }

    /**
     * Declare every function one class owns, and hand back its bodies.
     *
     * Split out of {@link Lowerer.#declareClasses} so it can run *on demand*.
     * A `Box<i32>` is not knowable up front: the first mention of one may be
     * inside a generic function's body, which is lowered long after the
     * eager classes were declared. So this has to be callable at any point,
     * which is the whole of why it is a function rather than a loop body.
     */
    #declareClassMembers(info: ClassInfo): ClassBody[] {
        const bindings = info.bindings;
        const bodies: ClassBody[] = [];
        {
            const self: MachineType = {kind: "class", name: info.name};
            const selfRef: MachineType = {kind: "reference", referent: self};

            // The destructor. Compiler-generated: there is no syntax for one, and
            // there does not need to be — a class holding a `string` releases it
            // because the field's own type says so.
            bodies.push({
                kind: "destructor",
                info,
                bindings,
                builder: this.#declareClassFn(info.destructorSymbol, [selfRef], VOID, info.node),
            });

            // A constructor is emitted whenever there is construction to do, which is
            // not the same as whenever one is written: a class whose fields carry
            // initialisers has work to do without declaring one, and so does a class
            // that only derives from such a class.
            if (info.constructorSymbol !== undefined) {
                const params =
                    info.ctor === undefined ? [] : this.#classFnParams(info.ctor, bindings);
                if (params !== undefined) {
                    bodies.push({
                        kind: "constructor",
                        info,
                        bindings,
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

            // Accessors are methods and are emitted as ones; only the syntax that
            // reaches them differs.
            for (const method of [
                ...info.methods.values(),
                ...info.getters.values(),
                ...info.setters.values(),
            ]) {
                // An inherited method belongs to the class that declared it and is
                // emitted once, there.
                if (method.owner !== info.name) {
                    continue;
                }
                const params = this.#classFnParams(method.declaration, bindings, info);
                if (params === undefined) {
                    continue;
                }
                const signature = this.#checker.getSignatureFromDeclaration(method.declaration);
                const returns =
                    signature === undefined
                        ? undefined
                        : this.erase(
                            method.declaration.type ?? method.declaration,
                            this.#checker.getReturnTypeOfSignature(signature),
                            bindings,
                        );
                if (returns === undefined) {
                    this.unsupported(method.declaration, "a method tsc could not give a signature to");
                    continue;
                }
                bodies.push({
                    kind: "method",
                    info,
                    bindings,
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

            for (const method of [
                ...info.statics.values(),
                // A static accessor is a static method reached with property syntax, so
                // it is emitted here rather than beside the instance accessors: no
                // receiver, no slot, nothing to dispatch on.
                ...info.staticGetters.values(),
                ...info.staticSetters.values(),
            ]) {
                // Inherited statics belong to the class that declared them and are
                // emitted once, there.
                if (method.owner !== info.name) {
                    continue;
                }
                const params = this.#classFnParams(method.declaration, bindings);
                if (params === undefined) {
                    continue;
                }
                const signature = this.#checker.getSignatureFromDeclaration(method.declaration);
                const returns =
                    signature === undefined
                        ? undefined
                        : this.erase(
                            method.declaration.type ?? method.declaration,
                            this.#checker.getReturnTypeOfSignature(signature),
                            bindings,
                        );
                if (returns === undefined) {
                    this.unsupported(method.declaration, "a method tsc could not give a signature to");
                    continue;
                }
                // No receiver: a static method is a free function, so its parameters
                // are exactly what was written.
                bodies.push({
                    kind: "static",
                    info,
                    bindings,
                    node: method.declaration,
                    builder: this.#declareClassFn(
                        method.symbol,
                        params.map((p) => p.type),
                        returns,
                        method.declaration,
                        this.#addressTaken.has(method.declaration),
                    ),
                    params,
                    returns,
                });
            }
        }
        return bodies;
    }

    /**
     * Fill in a class's fields and vtable, once its functions exist.
     *
     * After {@link Lowerer.#declareClassMembers} and not before: the vtable
     * holds `FuncId`s, and those are made by declaring the methods.
     */
    #defineClassLayout(info: ClassInfo): void {
        {
            const id = this.#classIds.get(info.name);
            if (id === undefined) {
                return;
            }
            const vtable: FuncId[] = [];
            for (const symbol of info.slots) {
                const record = this.#functions.get(symbol);
                if (record === undefined || record.kind !== "defined") {
                    // Only reachable when a member failed to lower, which has already
                    // been reported. Leaving the class out keeps one bad method from
                    // becoming a second, more confusing error about a missing vtable.
                    return;
                }
                vtable.push(record.id);
            }

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

    }

    /**
     * Declared `implements`, registered eagerly and **after** `defineClass`,
     * which rewrites the list wholesale.
     *
     * A static conversion registers its own itab at the conversion site, so
     * this is not what makes those work. It is what makes a *dynamic* cast
     * work: `tryCast<Pet>(x)` searches the object's type descriptor, and a
     * class whose only mention of `Pet` is in another module — or in no module,
     * because nothing converted it statically — would have an empty table and
     * answer "no" to a question whose answer is yes.
     */
    #registerDeclaredInterfaces(info: ClassInfo): void {
        for (const clause of info.node.heritageClauses ?? []) {
            if (clause.token !== ts.SyntaxKind.ImplementsKeyword) {
                continue;
            }
            for (const expression of clause.types) {
                const contract = this.#contractFrom(expression, info.bindings);
                if (contract === undefined) {
                    continue;
                }
                this.tyOf(contract, expression);
                this.implement(info.name, contract, expression);
            }
        }
    }

    /**
     * A class that contains itself by value, directly or through other storage
     * that is laid out inline.
     *
     * The erasure answers this for every *other* type (`GF0307`), and cannot
     * answer it for a class: a class is nominal, so `erase` gives back its name
     * and never looks at its fields — which is exactly what stops a
     * `Pointer<Node>` inside `Node` from recursing there. The fields are known
     * here instead, flattened, so here is where the same question gets asked.
     *
     * It is the same question, and the same answer: a class laid out inside
     * itself has no size, and nothing downstream would say so. The backend's
     * layout pass would recurse until the stack ended, with no file and no line.
     */
    #refuseInlineCycles(): void {
        // Inline storage only. A pointer, a reference or a `T[]` is a machine
        // word whatever is behind it, so a cycle through one is an ordinary
        // linked structure and stops the walk — which is also what makes this
        // terminate over a struct type that contains itself through a pointer.
        const reaches = (type: MachineType, target: string, seen: Set<string>): boolean => {
            switch (type.kind) {
                case "class": {
                    if (type.name === target) {
                        return true;
                    }
                    if (seen.has(type.name)) {
                        return false;
                    }
                    seen.add(type.name);
                    const other = this.#classes.get(type.name);
                    return (
                        other !== undefined &&
                        other.fields.some((field) => reaches(field.type, target, seen))
                    );
                }
                case "struct":
                    return type.fields.some((field) => reaches(field.type, target, seen));
                case "fixedArray":
                    return reaches(type.element, target, seen);
                default:
                    return false;
            }
        };

        for (const info of this.#classes.values()) {
            const field = info.fields.find((candidate) =>
                reaches(candidate.type, info.name, new Set()),
            );
            if (field === undefined) {
                continue;
            }
            this.error(
                field.declaration,
                "GF0307",
                `\`${info.name}.${field.name}\` is a \`${renderType(field.type)}\`, so the ` +
                `layout of \`${info.name}\` would have to contain itself — as large as ` +
                "itself and then larger. A field is laid out inline, which is what makes " +
                "the bytes match C's, and an object's own storage is not somewhere it can " +
                `be. Hold a \`Pointer<${info.name}>\`, which is one machine word whatever ` +
                `is behind it, or \`${info.name}[]\`, which is a handle to a buffer ` +
                "elsewhere.",
            );
        }
    }

    /** The contract named by an `implements` clause entry, if it is one. */
    #contractFrom(
        expression: ts.ExpressionWithTypeArguments,
        bindings: Substitution,
    ): Extract<MachineType, { kind: "interface" }> | undefined {
        try {
            // Under the class's substitution: `class Box<T> implements
            // Container<T>` names a contract whose `T` is this instantiation's.
            // Erased without it, the clause reported `T` as a type parameter
            // nothing had bound — so a generic class could declare that it
            // implements a generic contract and never be able to.
            const contract = contractOf(
                this.#checker,
                this.#checker.getTypeAtLocation(expression),
                new Erasure(bindings),
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

    /**
     * The written parameters, which is not the same list as `node.parameters`.
     *
     * `receiver` is the class this body has a `this` in — `undefined` for a
     * `static` and for a constructor, neither of which has one.
     */
    #classFnParams(
        node: ts.ConstructorDeclaration | MethodBody,
        bindings: Substitution,
        receiver?: ClassInfo,
    ): { name: string; type: MachineType }[] | undefined {
        const params: { name: string; type: MachineType }[] = [];
        const declaredThis = thisParameterOf(node);
        if (
            declaredThis !== undefined &&
            !this.#checkDeclaredThis(declaredThis, receiver, bindings)
        ) {
            return undefined;
        }
        for (const parameter of node.parameters) {
            // The receiver, and not an argument. It is `parameters[0]` in the AST
            // and absent from tsc's signature, and here it is worse than off by
            // one: the receiver is local 1 and arguments start at 2, so leaving it
            // in would shift every argument a slot and declare a second `this`.
            if (parameter === declaredThis) {
                continue;
            }
            if (!ts.isIdentifier(parameter.name)) {
                this.unsupported(parameter, "a destructured parameter");
                return undefined;
            }
            if (parameter.questionToken || parameter.dotDotDotToken || parameter.initializer) {
                this.unsupported(parameter, "an optional, rest, or defaulted parameter");
                return undefined;
            }
            // `constructor(private x: i32)` is still an ordinary parameter here. The
            // *field* it also declares is collected in `classes.ts`, beside the ones
            // written the long way, and the constructor assigns one from the other —
            // so there is one place fields come from and one place they are laid out,
            // which is the property that mattered when this was refused.
            const type = this.erase(
                parameter,
                this.#checker.getTypeAtLocation(parameter),
                bindings,
            );
            if (type === undefined) {
                return undefined;
            }
            if (!this.requireValueForm(type, parameter, "a parameter")) {
                return undefined;
            }
            params.push({name: parameter.name.text, type});
        }
        return params;
    }

    /**
     * A declared receiver — `area(this: Reference<Circle>): f64`.
     *
     * It is a promise about what the *caller* supplies, and tsc is what keeps
     * it: a receiver whose type is not assignable to the declared one is
     * refused at the call site, which is the whole reason to write one. Nothing
     * here re-checks that. What this checks is the two ways the promise can be
     * one this compiler cannot keep.
     *
     * **A `static` and a constructor have no receiver.** tsc refuses the
     * constructor case itself (`TS2681`); a `static` it accepts, and the
     * annotation would then describe a `this` that nothing binds.
     *
     * **The receiver is this class, or one it derives from.** tsc believes a
     * declared `this` rather than checking it against the enclosing class, so
     * `this: Reference<Other>` type-checks and the body then reads `Other`'s
     * fields off a `Circle` — every offset wrong, no diagnostic. A *base* is
     * the case that has to stay legal: base fields are the prefix of the
     * derived layout, so `override read(this: Reference<Base>)` reads the right
     * offsets off a `Derived`, and narrowing an override's receiver to the base
     * is a reasonable thing to write. The erasure is what answers, so a
     * spelling that erases to the same reference passes whatever it is written
     * as.
     */
    #checkDeclaredThis(
        declared: ts.ParameterDeclaration,
        receiver: ClassInfo | undefined,
        bindings: Substitution,
    ): boolean {
        if (receiver === undefined) {
            this.error(
                declared,
                "GF0002",
                "there is no `this` here to describe: a `static` method has no receiver, " +
                "and nothing is bound to the name inside one. Drop the parameter, or " +
                "make this an instance method if it wants the object.",
            );
            return false;
        }
        const type = this.erase(
            declared,
            this.#checker.getTypeAtLocation(declared),
            bindings,
        );
        if (type === undefined) {
            return false;
        }
        if (type.kind !== "reference" || type.referent.kind !== "class") {
            this.error(
                declared,
                "GF0002",
                "a declared `this` is the receiver, and a receiver is an address — " +
                `write it as \`Reference<${receiver.name}>\`. Taking it by value would ` +
                "be a copy of the object the caller is calling a method on, which is " +
                "not what any call site means.",
            );
            return false;
        }
        const named = type.referent.name;
        for (let owner: ClassInfo | undefined = receiver; owner !== undefined; owner = owner.base) {
            if (owner.name === named) {
                return true;
            }
        }
        this.error(
            declared,
            "GF0002",
            `this is a method of \`${receiver.name}\`, so its receiver is a ` +
            `\`${receiver.name}\` or something \`${receiver.name}\` derives from — but ` +
            `it declares \`this\` as a \`${named}\`, which is neither. tsc believes a ` +
            "declared `this` rather than checking it against the enclosing class, so " +
            "the body would read the wrong fields off the right object and nothing " +
            "would say so.",
        );
        return false;
    }

    #declareClassFn(
        symbol: string,
        params: MachineType[],
        returns: MachineType,
        at: ts.Node,
        // A function whose address is taken is classified by the C rules, because
        // that is what a `FnPtr`'s signature is classified by and the two have to
        // agree. The *symbol* is unchanged — this is about the calling convention,
        // not about visibility.
        addressTaken = false,
    ): FunctionBuilder {
        const sig = this.#mir.sig({
            params: params.map((param) => ({ty: this.tyOf(param, at), name: null})),
            ret: this.tyOf(returns, at),
            abi: addressTaken ? "C" : "Internal",
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
                params: params.map((type, index) => ({name: index === 0 ? "this" : `p${index}`, type})),
                returns,
            },
        });
        return builder;
    }

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
        // An enum contributes no code either: every member is a constant, folded
        // where it is used. What it does contribute is a *width*, and members that
        // do not fit it, so it is checked here rather than only where it is read
        // — a member nothing mentions is still wrong.
        if (ts.isEnumDeclaration(statement)) {
            this.#checkEnum(statement);
            return undefined;
        }
        // `declare namespace E { type Underlying = u32 }` — the other half of an
        // enum's declaration, and ambient, so there is nothing to lower. A
        // namespace holding anything else is not something this language has.
        if (ts.isModuleDeclaration(statement)) {
            if (!this.#checkEnumNamespace(statement)) {
                return undefined;
            }
            return undefined;
        }
        // Handled by `#declareClasses`, which ran before this and needed to: a
        // function here may take a class as a parameter.
        if (ts.isClassDeclaration(statement)) {
            return undefined;
        }
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
            // A generic one is a rule rather than a gap. Monomorphisation
            // compiles a body once per set of type arguments, and there is no
            // body here to compile — the symbol on the other side was built by
            // a compiler that has never heard of this call.
            if (statement.typeParameters && statement.typeParameters.length > 0) {
                this.error(
                    statement.typeParameters[0]!,
                    "GF0403",
                    `\`${statement.name.text}\` is declared without a body, so it names a ` +
                    "symbol some other library defines — and it is generic, so there is " +
                    "no one symbol for it to name. A generic is compiled once for each " +
                    "set of type arguments, which needs a body to compile. Declare the " +
                    "concrete signatures you actually call.",
                );
                return undefined;
            }
            this.#declareImport(statement);
            return undefined;
        }
        // A generic is registered rather than declared. There is no code to
        // emit for one and no signature to give it: REWRITE-PLAN §11.7 is
        // answered by monomorphisation (GENERICS-PLAN), so what exists is one
        // copy per set of type arguments some call asks for, made in
        // `#instantiate` and lowered from `#drainPending`.
        //
        // A generic nothing calls therefore contributes nothing at all, which
        // is right and is also what C++ and Rust do: an uninstantiated template
        // has no object code.
        if (statement.typeParameters && statement.typeParameters.length > 0) {
            this.#declareTemplate(statement);
            return undefined;
        }

        const name = statement.name.text;
        const exported =
            statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        // `export` makes it importable; being an entry-module export makes it part
        // of the build's public ABI. Only the second is a C boundary.
        const isPublic = this.#isPublic(statement, exported);

        const signature = this.#signature(statement, NO_BINDINGS);
        if (signature === undefined) {
            return undefined;
        }

        const isEntry = isPublic && name === "main" && statement.body !== undefined;
        if (isEntry && !this.#checkEntryPoint(statement, signature)) {
            return undefined;
        }
        // `main(args: string[])` is emitted as C's `main(int, char **)`, because
        // that is what the platform runtime calls. The `string[]` is built from the
        // pair by the first thing the body does — so the written signature and the
        // emitted one differ here, and only here.
        const entryArgs = isEntry && signature.params.length === 1;
        const emitted: readonly { name: string; type: MachineType }[] = entryArgs
            ? [
                {name: "argc", type: {kind: "scalar", name: "i32"}},
                {
                    name: "argv",
                    type: {kind: "pointer", pointee: {kind: "pointer", pointee: {kind: "scalar", name: "u8"}}},
                },
            ]
            : signature.params;

        // An exported function is a boundary, so what crosses it has to be
        // something both sides can agree about. Checked here rather than left to
        // the backend's classifier: that one panics, and REWRITE-PLAN §8 says a
        // program tsc accepted must never reach it.
        //
        // `main` is checked against the *emitted* pair, not the written array: a
        // `string[]` cannot cross the C boundary and does not have to, because it
        // never does.
        if (isPublic && statement.body !== undefined) {
            let crossable = true;
            emitted.forEach((param, index) => {
                const at = statement.parameters[index] ?? statement;
                if (!this.#checkCBoundary(param.type, at, `the parameter \`${param.name}\``)) {
                    crossable = false;
                }
            });
            if (!this.#checkCBoundary(signature.returns, statement.type ?? statement, "the return")) {
                crossable = false;
            }
            if (!crossable) {
                return undefined;
            }
        }

        // An exported function is a C entry point: something outside this module
        // calls it by its symbol, so it is classified by the C rules. `main` in
        // particular is called by the platform C runtime.
        //
        // A function whose *address* is taken is classified the same way, because a
        // `FnPtr`'s signature is, and the call through the pointer and the
        // definition must agree. It stays internally linked under its own symbol —
        // only the convention changes.
        const addressTaken = this.#addressTaken.has(statement);
        const sig = this.#mir.sig({
            params: emitted.map((param) => ({
                ty: this.tyOf(param.type, statement),
                name: null,
            })),
            ret: this.tyOf(signature.returns, statement),
            abi: isPublic || addressTaken ? "C" : "Internal",
        });

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
        return {node: statement, builder};
    }

    /**
     * Record a generic function, so that a call can instantiate it.
     *
     * The declaration is not checked here beyond this, and that is not
     * laziness: tsc checks a generic body **once, at the declaration**, against
     * the constraints — so what a `T` may do is already settled before this
     * compiler sees the program, and there is nothing here that could be
     * checked without knowing what `T` is. Everything that needs a machine type
     * is checked per instantiation instead, where there is one.
     */
    #declareTemplate(node: ts.FunctionDeclaration): void {
        if (node.name === undefined) {
            return;
        }
        const parameters = typeParameterSymbolsOf(this.#checker, node);
        if (parameters === undefined) {
            this.unsupported(node, "a generic whose type parameters tsc could not resolve");
            return;
        }
        const key = this.#keyOf(node, node.name.text);
        this.#templates.set(key, {node, name: node.name.text, key, parameters});
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
    #declareImport(node: ts.FunctionDeclaration, symbol?: string): void {
        if (node.name === undefined) {
            return;
        }
        // The symbol, which is the name written unless a caller says otherwise.
        // Only {@link STD_MODULES} does, and only because the runtime
        // trampolines those under `gf_` names it can export from a shared
        // library on every platform.
        const name = symbol ?? node.name.text;
        const key = this.#keyOf(node, node.name.text);
        if (this.#functions.has(key)) {
            return;
        }

        // A body-less declaration is only an import when nothing in this build
        // defines it. TypeScript's overload signatures are body-less too, and they
        // belong to a function whose implementation is the very next declaration —
        // treating one as an `extern "C"` import drops the implementation and asks
        // the linker for a symbol the program was about to define itself.
        if (this.#hasImplementation(node)) {
            return;
        }

        // An `extern "C"` import. Never generic — a declaration with no body has
        // nothing to instantiate, which is why that is a rule rather than a gap.
        const signature = this.#signature(node, NO_BINDINGS);
        if (signature === undefined) {
            return;
        }

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

    /**
     * {@link STD_MODULES}, registered so that a call site resolves to one.
     *
     * They go through {@link #declareImport} like any other body-less
     * declaration, which is the whole point: an `mi_malloc` call is an ordinary
     * C call and `mi_malloc` written as a *value* is an ordinary code address,
     * because neither goes down a path that knows the name. That is what lets
     * the four SDL wants be passed to `SDL_SetMemoryFunctions` directly.
     *
     * Registered eagerly for the whole module rather than at the import that
     * names them, because {@link resolveCallee} looks the *declaration* up: an
     * imported name is an alias, and following it lands on the declaration in
     * the prelude whichever file did the importing. So there is nothing per
     * import to do, and a second module importing the same name finds the entry
     * already there.
     */
    #declarePreludeExterns(): void {
        for (const file of this.#program.getSourceFiles()) {
            if (!file.isDeclarationFile) {
                continue;
            }
            for (const statement of file.statements) {
                // `declare module "std/alloc" { … }` — an ambient module, whose
                // members are nested a level down rather than at the top of the
                // file the way a global `declare function` is.
                if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) {
                    continue;
                }
                const members = STD_MODULES.get(statement.name.text);
                if (members === undefined || statement.body === undefined) {
                    continue;
                }
                if (!ts.isModuleBlock(statement.body)) {
                    continue;
                }
                for (const declaration of statement.body.statements) {
                    if (!ts.isFunctionDeclaration(declaration) || declaration.name === undefined) {
                        continue;
                    }
                    const symbol = members.get(declaration.name.text);
                    if (symbol !== undefined) {
                        this.#declareImport(declaration, symbol);
                    }
                }
            }
        }
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
     * Whether a type may cross the C boundary, reporting if it may not.
     *
     * The same rule the backend's `require_plain_data` enforces, said in the
     * frontend where there is a node to point at. The backend keeps its copy as
     * defence in depth — it should now be unreachable.
     */
    #checkCBoundary(type: MachineType, at: ts.Node, what: string): boolean {
        // A `Reference<T>` crosses as `T *`, which the header already spells —
        // so what has to be checked is `T`, not the address. Without this an
        // owning struct sailed across behind one: `Reference<Held>` where
        // `Held` has a `string` field was accepted where a plain `Held` was
        // refused, and the reference is not what made the difference.
        //
        // Deliberately *not* done for `Pointer<T>`. That one is the escape
        // hatch — an address and nothing more, whose whole job is to carry
        // something this compiler will not vouch for.
        if (type.kind === "reference") {
            return this.#checkCBoundary(
                type.referent,
                at,
                `${what}, which is a reference to a value that`,
            );
        }

        // A callback is a boundary of its own: whatever C hands *back* through it
        // has to be spellable too. Checked one level in rather than assumed,
        // because the pointer itself is only a word and would otherwise sail
        // through carrying a signature nothing outside this build can call.
        if (type.kind === "fnptr") {
            let crossable = true;
            for (const param of type.params) {
                if (!this.#checkCBoundary(param, at, `${what}, which is a callback taking a value that`)) {
                    crossable = false;
                }
            }
            if (!this.#checkCBoundary(type.returns, at, `${what}, which is a callback returning a value that`)) {
                crossable = false;
            }
            return crossable;
        }

        // `string` is deliberately absent from this list. It is a valid,
        // nul-terminated `char *` — the runtime lays it out that way on purpose —
        // so C reads one with no conversion, and ownership becomes the documented,
        // manual thing it is in every C API that hands out memory. `T[]` is not:
        // its elements are laid out for this compiler and its header is a shape
        // nothing else knows.
        const reason =
            type.kind === "localfn"
                ? "is a closure: a code address paired with a pointer into this build's " +
                "own frame, passed by a convention no C caller knows. A plain " +
                "function type is a bare code address and crosses — give the callback " +
                "a `Pointer<unknown>` of its own if it needs state, which is the " +
                "arrangement C already uses"
                : type.kind === "array"
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
        if (reason === undefined) {
            return true;
        }
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

    #signature(node: ts.FunctionDeclaration, bindings: Substitution): FnSignature | undefined {
        const params: { name: string; type: MachineType }[] = [];
        // A free function has no receiver. tsc accepts the declaration — it is a
        // promise about a caller that would supply one through `call` or `bind`,
        // neither of which exists here — so `this` inside it is a name nothing
        // binds, and the annotation describes something that cannot happen.
        const declaredThis = thisParameterOf(node);
        if (declaredThis !== undefined) {
            this.error(
                declaredThis,
                "GF0002",
                "a free function has no receiver, so there is nothing for a declared " +
                "`this` to describe — the call sequence has no slot to pass one in. " +
                "Make it a method if it wants an object, or take the object as an " +
                "ordinary `Reference<T>` parameter.",
            );
            return undefined;
        }
        for (const parameter of node.parameters) {
            if (!ts.isIdentifier(parameter.name)) {
                this.unsupported(parameter, "a destructured parameter");
                return undefined;
            }
            if (parameter.questionToken || parameter.dotDotDotToken || parameter.initializer) {
                this.unsupported(parameter, "an optional, rest, or defaulted parameter");
                return undefined;
            }
            const type = this.erase(
                parameter,
                this.#checker.getTypeAtLocation(parameter),
                bindings,
            );
            if (type === undefined) {
                return undefined;
            }
            if (!this.requireValueForm(type, parameter, "a parameter")) {
                return undefined;
            }
            params.push({name: parameter.name.text, type});
        }

        const signature = this.#checker.getSignatureFromDeclaration(node);
        if (signature === undefined) {
            this.unsupported(node, "a function tsc could not give a signature to");
            return undefined;
        }
        const returns = this.erase(
            node.type ?? node,
            this.#checker.getReturnTypeOfSignature(signature),
            bindings,
        );
        if (returns === undefined) {
            return undefined;
        }
        if (!this.requireValueForm(returns, node.type ?? node, "a return type")) {
            return undefined;
        }
        if (!this.refuseEscape(returns, node.type ?? node, "a return type")) {
            return undefined;
        }

        return {params, returns};
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
        if (signature.params.length === 0) {
            return true;
        }

        const only = signature.params[0];
        if (
            signature.params.length !== 1 ||
            only === undefined ||
            only.type.kind !== "array" ||
            only.type.element.kind !== "string"
        ) {
            this.error(
                node.parameters[1] ?? node.parameters[0] ?? node,
                "GF0004",
                "`main` takes either nothing or one `string[]`: " +
                "`export function main(args: string[]): i32`. C's `argc`/`argv` pair " +
                "is what the platform hands over, and the runtime turns it into an " +
                "array before your first statement — there is nothing here to pass " +
                "the two halves to separately.",
            );
            return false;
        }
        return true;
    }

    /**
     * Whether this function is the entry point *and* asked for its arguments.
     *
     * The distinction matters twice: `main`'s emitted signature is C's
     * `(int, char **)` rather than the one that was written, and its first
     * statement is the call that turns the two into a `string[]`.
     */
    #entryTakesArgs(record: FnRecord): boolean {
        return (
            this.#requireMain &&
            record.kind === "defined" &&
            record.exported &&
            record.name === "main" &&
            record.signature.params.length === 1
        );
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
            referent: {kind: "class", name: body.info.name},
        };
        const scopes = new Scopes();

        // A `static` method has no receiver, so nothing is bound to `this` and its
        // parameters start at local 1. Reading `this` inside one then fails the way
        // it does in a free function — the name is not in scope — which is the
        // right complaint rather than a special-cased one.
        if (body.kind === "static") {
            body.params.forEach((param, index) => {
                scopes.declare(param.name, {
                    local: LocalId(index + 1),
                    type: param.type,
                    ty: this.tyOf(param.type, body.node),
                });
            });
            const lowerer = new BodyLowerer(
                this,
                body.builder,
                scopes,
                body.returns,
                body.bindings,
            );
            lowerer.setClassContext(body.info, false);
            if (body.node.body !== undefined) {
                lowerer.run(body.node.body);
            }
            return;
        }

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
        const lowerer = new BodyLowerer(this, body.builder, scopes, returns, body.bindings);
        lowerer.setClassContext(body.info, body.kind === "constructor");
        if (body.kind === "constructor") {
            lowerer.runConstructor(body.info, body.node?.body);
            return;
        }
        if (body.node?.body !== undefined) {
            lowerer.run(body.node.body);
        }
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
            if (!needsDrop(field.type)) {
                continue;
            }
            builder.push(block, {
                kind: "Drop",
                place: {
                    local: self,
                    projection: [{kind: "Deref"}, {kind: "Field", value: FieldId(index)}],
                },
                flag: null,
                unwind: {kind: "Unreachable"},
            });
        }

        if (info.base !== undefined) {
            const base = this.#functions.get(info.base.destructorSymbol);
            if (base !== undefined && base.kind === "defined") {
                const after = builder.block();
                builder.seal(block, {
                    kind: "Call",
                    callee: {kind: "Direct", value: {kind: "Local", value: base.id}},
                    args: [{kind: "Borrow", value: {local: self, projection: []}}],
                    destination: {place: {local: LocalId(0), projection: []}, target: after},
                    unwind: {kind: "Unreachable"},
                });
                builder.seal(after, {kind: "Return"});
                void scopes;
                return;
            }
        }

        builder.seal(block, {kind: "Return"});
        void scopes;
    }

    #lowerBody(node: ts.FunctionDeclaration, builder: FunctionBuilder): void {
        const record = this.#functions.get(this.#keyOf(node, node.name!.text));
        if (record === undefined || node.body === undefined) {
            return;
        }

        // The entry point, and only for a `bin`: a library has no `main` of its
        // own, and the program that does have one is somebody else's.
        const isEntry =
            this.#requireMain && record.kind === "defined" && record.exported && record.name === "main";
        // `main(args)` is emitted as `(argc, argv)`, so its declared parameter is
        // not a parameter at all — it is a local the body builds before its first
        // statement, and nothing may be bound to locals 1 and 2 under its name.
        const entryArgs = isEntry && this.#entryTakesArgs(record);

        const scopes = new Scopes();
        if (!entryArgs) {
            record.signature.params.forEach((param, index) => {
                scopes.declare(param.name, {
                    local: LocalId(index + 1),
                    type: param.type,
                    ty: this.tyOf(param.type, node),
                });
            });
        }

        const lowerer = new BodyLowerer(
            this,
            builder,
            scopes,
            record.signature.returns,
            NO_BINDINGS,
        );
        lowerer.run(node.body, isEntry, entryArgs ? record.signature.params[0] : undefined);
    }

    /**
     * One instantiation's body: the same AST, lowered again under a
     * substitution.
     *
     * Deliberately *not* `#lowerBody` with an argument. That one finds its
     * record by looking the declaration up, which is exactly what an
     * instantiation cannot do — there are several of them behind one
     * declaration, and the whole point is that they differ. It also cannot be
     * the entry point, cannot take `main`'s `argv` pair, and is never
     * exported, so the three branches that make `#lowerBody` long are all
     * answered before they are asked.
     */
    #lowerInstantiation(pending: PendingInstantiation): void {
        if (pending.node.body === undefined) {
            return;
        }
        const scopes = new Scopes();
        pending.record.signature.params.forEach((param, index) => {
            scopes.declare(param.name, {
                local: LocalId(index + 1),
                type: param.type,
                ty: this.tyOf(param.type, pending.node),
            });
        });
        new BodyLowerer(
            this,
            pending.builder,
            scopes,
            pending.record.signature.returns,
            pending.bindings,
        ).run(pending.node.body);
    }

    /**
     * Intern a struct type by its **identity**.
     *
     * By identity rather than by shape: erasure already decided what the type
     * is, and two types with the same fields in a different order are different
     * layouts. Interning by shape would silently merge them.
     *
     * And by {@link layoutKey} rather than by `name`, which is the fix for the
     * merge that was actually happening. A name is not unique — two files may
     * each declare an `interface Pair`, both are legal, and tsc says they are
     * different types — so keying on one made the second `Pair` find the first's
     * `TyId` and take its layout. Nothing was ill-formed, so nothing was
     * reported: a `Pair` of `u32` compared as `i32`, and `-1 < 0` came back
     * false.
     *
     * `sameType` compares the same key, so what the frontend calls one type and
     * what the module gives one `TyId` cannot drift apart. That matters in both
     * directions: keying more finely than `sameType` compares would refuse
     * `Point` → `Point` between two files that declare it identically, which is
     * an ordinary program and was the first attempt at this fix.
     *
     * The MIR still carries the readable `name`, because that is what the
     * generated C header declares and an exported struct's name is the contract
     * with whoever includes it.
     */
    #structTy(type: Extract<MachineType, { kind: "struct" }>, at: ts.Node): TyId {
        const key = layoutKey(type);
        const existing = this.#structs.get(key);
        if (existing !== undefined) {
            return existing;
        }

        // Fields are laid out **inline**, so a field with no size gives the struct
        // no size either — and the failure would land in the backend's layout pass
        // with no field to point at. `Pointer<FILE>` is the field anyone means.
        for (const field of type.fields) {
            if (!this.requireValueForm(field.type, at, `the field \`${field.name}\``)) {
                return this.#mir.ty({kind: "Void"});
            }
            if (!this.refuseEscape(field.type, at, `the field \`${field.name}\``)) {
                return this.#mir.ty({kind: "Void"});
            }
        }

        // A union's members share their storage, so nothing in the bytes says which
        // one is live and nothing can say which one to destroy. Refusing an owning
        // member is what keeps that question from ever being asked (DECISIONS §12).
        if (type.union === true) {
            for (const field of type.fields) {
                if (needsDrop(field.type)) {
                    this.error(
                        at,
                        "GF0303",
                        `\`${type.name}.${field.name}\` is a \`${renderType(field.type)}\`, which ` +
                        "owns what it points at. A union's members share their storage, so " +
                        "nothing in the bytes records which one is live — and so nothing could " +
                        "say which one to release. A union holds plain data.",
                    );
                    return this.#mir.ty({kind: "Void"});
                }
            }
        }

        // Declared and interned **before** the field types are, which is what
        // makes `interface Node { next: Pointer<Node> | null }` terminate:
        // interning that field comes back through here for `Node`, and finds it.
        //
        // The identity is registered at the same moment for the same reason — a
        // struct is interned by it (see above), and the recursive occurrence has
        // to find the id the enclosing one reserved rather than reserve a second
        // struct with the same identity and a different layout.
        const id = this.#mir.declareStruct({name: type.name, union: type.union === true});
        const ty = this.#mir.ty({kind: "Struct", value: id});
        this.#structs.set(key, ty);
        this.#mir.defineStruct(id, {
            fields: type.fields.map((field) => ({
                name: field.name,
                ty: this.tyOf(field.type, at),
            })),
        });
        return ty;
    }

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
        // Keyed by identity rather than by name, for the reason spelled out on
        // {@link Lowerer.#structTy}: two files may each declare an `interface
        // Speaker` with different methods, and those are two contracts with two
        // itables and two slot orders. The MIR keeps the readable name.
        const key = layoutKey(type);
        const existing = this.#interfaceTys.get(key);
        if (existing !== undefined) {
            return existing;
        }

        // The `key` is the contract's structural identity rather than a hash
        // of its name, for the reason the intern above gives: two files may
        // declare the same name with different methods, and a class's
        // descriptor and a `tryCast` have to agree about which is which. The
        // backend stores it beside each itab and asks for it by the same
        // value — see `InterfaceDef::key` in the MIR.
        const id = this.#mir.declareInterface({
            name: type.name,
            key: layoutKeyHash(type),
            span: this.span(at),
        });
        this.#interfaces.set(key, id);
        this.#interfaceInfo.set(key, type);
        const ty = this.#mir.ty({kind: "Interface", value: id});
        this.#interfaceTys.set(key, ty);

        const receiver = this.#mir.ty({
            kind: "Pointer",
            value: this.#mir.ty({kind: "Void"}),
        });
        this.#mir.defineInterface(
            id,
            type.methods.map((method) => ({
                name: method.name,
                sig: this.#mir.sig({
                    params: [
                        {ty: receiver, name: null},
                        ...method.params.map((param) => ({ty: this.tyOf(param, at), name: null})),
                    ],
                    ret: this.tyOf(method.returns, at),
                    abi: "Internal",
                }),
            })),
        );
        return ty;
    }

    /**
     * Check an enum: its underlying width, and that every member fits it.
     *
     * Nothing is lowered — the members are constants and are folded where they
     * are read. The check happens at the declaration anyway, because a member
     * that does not fit is wrong whether or not anything mentions it, and this is
     * the only place with the whole enum to point at.
     */
    #checkEnum(statement: ts.EnumDeclaration): void {
        const type = this.#checker.getTypeAtLocation(statement.name);
        const width = this.erase(statement.name, type, NO_BINDINGS);
        if (width === undefined || width.kind !== "scalar") {
            return;
        }

        const range = rangeOf(width.name);
        if (range === null) {
            return;
        }

        for (const member of statement.members) {
            // A string member is reported once, by erasure, against the enum as a
            // whole — a string enum is one decision rather than one per member.
            const value = this.#checker.getConstantValue(member);
            if (typeof value === "string") {
                return;
            }
            if (value === undefined) {
                // A computed member tsc could not fold. Every constant form folds, so
                // this is a member whose initialiser is not a constant at all.
                this.unsupported(member, "an enum member whose value is not a constant");
                continue;
            }
            if (!Number.isInteger(value)) {
                this.error(
                    member,
                    "GF0166",
                    `\`${statement.name.text}.${member.name.getText()}\` is ${value}, which is ` +
                    "not an integer. An enum holds integer constants.",
                );
                continue;
            }
            const exact = BigInt(value);
            if (exact < range.min || exact > range.max) {
                this.error(
                    member,
                    "GF0164",
                    `\`${statement.name.text}.${member.name.getText()}\` is ${exact}, which does ` +
                    `not fit in \`${width.name}\`, whose range is ${range.min} to ${range.max}. ` +
                    `The width comes from \`declare namespace ${statement.name.text} ` +
                    `{ type ${ENUM_UNDERLYING} = … }\`, or is \`${DEFAULT_ENUM_WIDTH}\` when ` +
                    "nothing declares one.",
                );
            }
        }
    }

    /**
     * `declare namespace E { type Underlying = u32 }`, and nothing else.
     *
     * A namespace is not a thing this language has — there is no module-level
     * storage for one to hold, and no runtime object for it to be. It is accepted
     * in exactly the one shape that carries an enum's width, because TypeScript
     * offers no other legal place to write it.
     */
    #checkEnumNamespace(statement: ts.ModuleDeclaration): boolean {
        const merged = this.#checker.getSymbolAtLocation(statement.name);
        const mergesWithEnum = merged?.declarations?.some((declaration) =>
            ts.isEnumDeclaration(declaration),
        );
        if (mergesWithEnum !== true) {
            this.unsupported(
                statement,
                `a namespace — the only one this language has is ` +
                `\`declare namespace E { type ${ENUM_UNDERLYING} = … }\`, which gives an ` +
                `enum its width`,
            );
            return false;
        }

        const body = statement.body;
        if (body === undefined || !ts.isModuleBlock(body)) {
            return true;
        }
        for (const inner of body.statements) {
            if (ts.isTypeAliasDeclaration(inner) && inner.name.text === ENUM_UNDERLYING) {
                continue;
            }
            this.unsupported(
                inner,
                `\`${statement.name.getText()}\` is an enum's width declaration, so ` +
                `\`type ${ENUM_UNDERLYING} = …\` is the only thing it may contain`,
            );
            return false;
        }
        return true;
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
