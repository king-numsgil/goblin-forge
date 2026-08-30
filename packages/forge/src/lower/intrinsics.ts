/**
 * The prelude's memory operations, lowered.
 *
 * `alloc`, `free`, `FixedArray`, the pointer methods, and array push and pop.
 * What they have in common is that each one is a *shape the frontend knows how
 * to emit* rather than a call it can forward — the size and alignment are the
 * compiler's to supply, because the runtime hands out bytes and has no idea
 * what is going in them.
 */

import { FieldId, type Operand, type Place } from "@goblin-forge/backend";
import { type MachineType, renderType } from "@goblin-forge/checker";
import ts from "typescript";
import { NATIVE_ALIGN_OF, NATIVE_SIZE_OF, NATIVE_ZEROED, NO_UNWIND, RUNTIME } from "./tables.ts";
import { ISIZE, type Typed, USIZE, VOID } from "./types.ts";
import { needsDrop, placeOf } from "./util.ts";
import { WidthPass } from "./width.ts";

export abstract class IntrinsicLowerer extends WidthPass {
    /**
     * `sizeOf<T>()` / `alignOf<T>()`.
     *
     * The type argument is read from tsc rather than from the expression, because
     * there is no expression — it is written only in the angle brackets.
     */
    protected layoutQuery(expression: ts.CallExpression, size: boolean): Typed | undefined {
        const argument = expression.typeArguments?.[0];
        if (argument === undefined) {
            this.outer.error(
                expression,
                "GF0002",
                `\`${size ? NATIVE_SIZE_OF : NATIVE_ALIGN_OF}\` needs the type written out: ` +
                `\`${size ? NATIVE_SIZE_OF : NATIVE_ALIGN_OF}<i32>()\`.`,
            );
            return undefined;
        }
        const type = this.erase(argument, this.outer.checker.getTypeAtLocation(argument));
        if (type === undefined) {
            return undefined;
        }
        const query = size ? NATIVE_SIZE_OF : NATIVE_ALIGN_OF;
        if (!this.outer.requireKnownLayout(type, argument, `\`${query}\``)) {
            return undefined;
        }
        const ty = this.outer.tyOf(type, argument);
        return this.temporaryTyped(expression, USIZE, size ? {kind: "SizeOf", value: ty} : {
            kind: "AlignOf",
            value: ty,
        });
    }

    /**
     * `zeroed<T>()` — a `T` whose bytes are all zero.
     *
     * What `alloc<T>()` gives on the heap, given on the stack instead, and built
     * from the same `Default` a class gets before its constructor runs.
     *
     * It exists because a union has no other way to come into being: an object
     * literal would have to supply every member at once (`GF0304`), and a binding
     * without an initialiser is not a thing yet. Zero is a valid starting state
     * for every member of a union:
     *
     *     let event = zeroed<SDL_Event>();
     *     event.type = SDL_EventType.Quit;
     *
     * By value only. A C function that *fills* a union takes a pointer, and
     * nothing takes the address of a local, so that case is `alloc<SDL_Event>()`
     * — which zeroes the same way and hands back something passable.
     *
     * Useful well beyond unions — a zeroed struct is a common enough thing to
     * want — which is why it is spelled generally rather than as a union ritual.
     */
    protected zeroed(expression: ts.CallExpression, natural: MachineType): Typed | undefined {
        const argument = expression.typeArguments?.[0];
        const at = argument ?? expression;
        // The written type argument wins, and the contextual type stands in when it
        // is absent, so `const e: SDL_Event = zeroed()` reads as well as the
        // explicit spelling.
        const type =
            argument === undefined
                ? natural
                : this.erase(argument, this.outer.checker.getTypeAtLocation(argument));
        if (type === undefined) {
            return undefined;
        }
        if (!this.outer.requireKnownLayout(type, at, `\`${NATIVE_ZEROED}\``)) {
            return undefined;
        }

        // A class is the one thing this must not make. `Default` would zero it and
        // install its vtable — a constructed-looking object whose constructor never
        // ran — and the language already has the spelling that does run it.
        if (type.kind === "class") {
            this.outer.error(
                at,
                "GF0002",
                `\`${NATIVE_ZEROED}<${renderType(type)}>()\` would produce a \`${renderType(type)}\` ` +
                "whose constructor never ran. Write `new " +
                `${renderType(type)}(…)\`, which is the spelling that runs it.`,
            );
            return undefined;
        }

        return this.temporaryTyped(expression, type, {kind: "Default"});
    }

    /**
     * `alloc(C, …args)` — construct a `C` on the heap, and hand back its address.
     *
     * C++'s `new C(…)`, and built from parts rather than from a node of its own:
     * ask the runtime for storage the size and alignment of a `C`, zero it and
     * install its vtable with the same `Default` a stack object gets, then run
     * the constructor through a reference to it. The only thing the backend has
     * to supply is the layout, and `SizeOf`/`AlignOf` already do that.
     *
     * Where `new C(…)` gives a value its scope releases, this gives a pointer
     * that outlives the scope and leaks if you drop it — the same distinction
     * C++ draws, and the reason `free()` is something you write.
     */
    protected alloc(expression: ts.CallExpression, natural: MachineType): Typed | undefined {
        const [klass, ...args] = expression.arguments;

        // `alloc<T>()` — no class, so nothing to construct beyond zeroing. One
        // operation with two spellings rather than two operations: the storage is
        // default-initialised either way, so `free()` has something well-defined
        // to destroy in both.
        if (klass === undefined) {
            if (
                natural.kind === "pointer" &&
                !this.outer.requireKnownLayout(natural.pointee, expression, "`alloc`")
            ) {
                return undefined;
            }
            return this.#allocDefault(expression, natural);
        }

        // `alloc<T>({ … })` — the same zeroed storage, with the fields the
        // initialiser names written into it afterwards. Discriminated on the
        // syntax rather than on the type, because the class spelling's first
        // argument is a name and this one's is a literal, so there is nothing to
        // infer.
        if (ts.isObjectLiteralExpression(klass)) {
            if (args.length > 0) {
                // The initialiser overload takes exactly one argument, so tsc rejects
                // this first. Reaching it means the two disagree.
                this.outer.unsupported(expression, "`alloc` with an initialiser and more arguments");
                return undefined;
            }
            if (
                natural.kind === "pointer" &&
                !this.outer.requireKnownLayout(natural.pointee, expression, "`alloc`")
            ) {
                return undefined;
            }
            return this.#allocInit(expression, natural, klass);
        }

        if (!ts.isIdentifier(klass)) {
            this.outer.error(
                expression,
                "GF0002",
                "`alloc` takes a class and its constructor's arguments, a type " +
                "argument and nothing, or a type argument and an initialiser: " +
                "`alloc(Rect, 6, 7)`, `alloc<i32>()`, or `alloc<Rect>({ w: 6 })`.",
            );
            return undefined;
        }
        // The class comes from the **erasure of the call**, not from the
        // identifier's text: `alloc(Box, n)` where `Box` is generic makes a
        // `Box<i32>`, and `Box` on its own is not a class this build has. tsc
        // has already inferred the argument from the constructor's parameters,
        // so the call's own type is the instantiation — the same route `new`
        // takes, and for the same reason.
        const allocated = this.erase(
            expression,
            this.outer.checker.getTypeAtLocation(expression),
        );
        const object: MachineType | undefined =
            allocated?.kind === "pointer" && allocated.pointee.kind === "class"
                ? allocated.pointee
                : undefined;
        if (object === undefined) {
            this.outer.unsupported(expression, `\`alloc(${klass.text}, …)\``);
            return undefined;
        }
        const pointer: MachineType =
            natural.kind === "pointer" ? natural : {kind: "pointer", pointee: object};
        // Interning is also what instantiates a generic class, so it happens
        // before `classInfo` is asked.
        const ty = this.outer.tyOf(object, expression);
        const info = this.outer.classInfo(object.name);
        if (info === undefined) {
            this.outer.unsupported(expression, `\`alloc(${object.name}, …)\``);
            return undefined;
        }

        const size = this.temporaryTyped(expression, USIZE, {kind: "SizeOf", value: ty});
        const align = this.temporaryTyped(expression, USIZE, {kind: "AlignOf", value: ty});
        if (size === undefined || align === undefined) {
            return undefined;
        }

        const raw = this.callRuntime(expression, RUNTIME.alloc, [size, align], pointer);
        if (raw === undefined) {
            return undefined;
        }

        // The storage is uninitialised, so this is the same two-step a stack object
        // gets: `Default` zeroes it and installs the vtable — making it
        // dispatchable, and therefore destructible, before the constructor runs a
        // line — and then the constructor is an ordinary call.
        const place = this.placeOfSubject(expression, raw);
        if (place === undefined) {
            return undefined;
        }
        const target: Place = {local: place.local, projection: [...place.projection, {kind: "Deref"}]};
        this.push({kind: "Init", place: target, rvalue: {kind: "Default"}});

        const marshalled = this.classCallArgs(
            expression,
            info,
            info.constructorSymbol,
            args,
            {kind: "Copy", value: place},
        );
        if (marshalled === undefined) {
            return undefined;
        }
        if (marshalled === null) {
            if (args.length > 0) {
                this.outer.error(
                    expression,
                    "GF0002",
                    `\`${info.name}\` declares no constructor, so \`alloc\` takes no arguments after it.`,
                );
                return undefined;
            }
            return {operand: raw.operand, type: pointer};
        }

        const record = this.outer.fn(info.constructorSymbol!);
        if (record === undefined || record.kind !== "defined") {
            return undefined;
        }
        this.callDirect(record.id, marshalled, undefined);
        return {operand: raw.operand, type: pointer};
    }

    /**
     * `alloc<T>()` — storage for one `T`, default-initialised.
     *
     * The same `Default` a local gets, and for the same reason: there is no
     * uninitialised form anywhere in this language, because a destructor releases
     * what a slot holds and on uninitialised memory that is a garbage pointer.
     * `alloc<string>()` followed by `free()` has to be well defined, and zeroing
     * is what makes it so.
     */
    #allocDefault(expression: ts.CallExpression, natural: MachineType): Typed | undefined {
        const pointee =
            natural.kind === "pointer"
                ? natural.pointee
                : this.erase(expression, this.outer.checker.getTypeAtLocation(expression));
        if (pointee === undefined) {
            return undefined;
        }
        if (pointee.kind === "pointer") {
            // `erase` gave the whole `Pointer<T>` back rather than the pointee, which
            // means tsc could not work out what `T` is.
            this.outer.error(
                expression,
                "GF0002",
                "`alloc` needs the type written out when there is no class: `alloc<i32>()`.",
            );
            return undefined;
        }

        // A class with a constructor reached this way would be allocated and never
        // constructed, which is a trap rather than a shorthand.
        if (pointee.kind === "class") {
            const info = this.outer.classInfo(pointee.name);
            if (info?.ctor !== undefined) {
                this.outer.error(
                    expression,
                    "GF0002",
                    `\`${pointee.name}\` has a constructor, so write \`alloc(${pointee.name}, …)\` ` +
                    "— naming the type instead would allocate it without constructing it.",
                );
                return undefined;
            }
        }

        const pointer: MachineType = {kind: "pointer", pointee};
        const ty = this.outer.tyOf(pointee, expression);
        const size = this.temporaryTyped(expression, USIZE, {kind: "SizeOf", value: ty});
        const align = this.temporaryTyped(expression, USIZE, {kind: "AlignOf", value: ty});
        if (size === undefined || align === undefined) {
            return undefined;
        }

        const raw = this.callRuntime(expression, RUNTIME.alloc, [size, align], pointer);
        if (raw === undefined) {
            return undefined;
        }

        const place = this.placeOfSubject(expression, raw);
        if (place === undefined) {
            return undefined;
        }
        this.push({
            kind: "Init",
            place: {local: place.local, projection: [...place.projection, {kind: "Deref"}]},
            rvalue: {kind: "Default"},
        });
        return {operand: raw.operand, type: pointer};
    }

    /**
     * `alloc<T>({ … })` — zeroed storage, then the fields the initialiser names.
     *
     * Sugar over the two operations that were already there, and emitted as
     * exactly those two: `#allocDefault` for the storage, then one `Assign` per
     * named leaf — the same statement `p.field = v` produces. Nothing new
     * reaches the backend, which is why this is a frontend change and the wire
     * format did not move.
     *
     * The `Assign` is what makes the shorthand safe rather than merely short. A
     * field the initialiser names holds a *live* zero by the time it is written,
     * so an owning field's old value is destroyed before the new one lands —
     * and destroying a zeroed `string` is `gf_string_free`'s null check, which
     * is the same well-definedness `alloc<string>()` followed by `free()` already
     * rests on.
     */
    #allocInit(
        expression: ts.CallExpression,
        natural: MachineType,
        literal: ts.ObjectLiteralExpression,
    ): Typed | undefined {
        const allocated = this.#allocDefault(expression, natural);
        if (allocated === undefined || allocated.type.kind !== "pointer") {
            return undefined;
        }

        // Nothing is emitted for `alloc<T>({})`, and that is the honest answer
        // rather than a special case: the storage is already zero.
        if (literal.properties.length === 0) {
            return allocated;
        }

        const place = this.placeOfSubject(expression, allocated);
        if (place === undefined) {
            return undefined;
        }
        const target: Place = {local: place.local, projection: [...place.projection, {kind: "Deref"}]};
        if (!this.#initFields(literal, allocated.type.pointee, target)) {
            return undefined;
        }
        return allocated;
    }

    /**
     * The initialiser's named fields, written into `target`.
     *
     * A nested literal recurses with a longer projection rather than building an
     * aggregate and copying it in, so `{ a: { b: { c: 1 } } }` is one store to
     * `(*p).a.b.c` and nothing else. The intermediate levels need no work
     * precisely because they are already zero — which is the property the whole
     * shorthand is built on.
     */
    #initFields(
        literal: ts.ObjectLiteralExpression,
        type: MachineType,
        target: Place,
    ): boolean {
        if (type.kind !== "struct") {
            // A class reaches here through `alloc<C>({…})`, whose fields sit past a
            // constructor that never ran. Everything else is a shape an object
            // literal was never going to describe.
            const advice =
                type.kind === "class"
                    ? ` Write \`alloc(${type.name}, …)\`, which runs the constructor.`
                    : "";
            this.outer.error(
                literal,
                "GF0161",
                `an object literal cannot initialise a \`${renderType(type)}\`.${advice}`,
            );
            return false;
        }

        for (const property of literal.properties) {
            if (!ts.isPropertyAssignment(property)) {
                this.outer.unsupported(property, "a shorthand or spread in an initialiser");
                return false;
            }
            const name = property.name.getText();
            const index = this.fieldIndex(type, name);
            const field = type.fields[index];
            if (field === undefined) {
                // tsc rejects a field that is not there, so reaching this means the
                // two disagree about the shape.
                this.outer.unsupported(property, `the field \`${name}\``);
                return false;
            }

            const slot: Place = {
                local: target.local,
                projection: [...target.projection, {kind: "Field", value: FieldId(index)}],
            };
            const initialiser = property.initializer;

            // A union is the one nesting this must not walk into: its members share
            // storage, so "the fields you named" is not a well-defined set. The
            // ordinary object-literal path refuses it by name, with `GF0304`, so
            // this falls through to say it there rather than saying it twice.
            if (
                ts.isObjectLiteralExpression(initialiser) &&
                field.type.kind === "struct" &&
                field.type.union !== true
            ) {
                if (!this.#initFields(initialiser, field.type, slot)) {
                    return false;
                }
                continue;
            }

            const value = this.expressionTyped(initialiser, field.type);
            if (value === undefined) {
                return false;
            }
            this.push({
                kind: "Assign",
                place: slot,
                rvalue: {kind: "Use", value: this.forStorage(value)},
            });
        }
        return true;
    }

    /**
     * `p.free()` — run the destructor, then hand the storage back.
     *
     * C++'s `delete`, and just as unchecked. A **direct** destructor call rather
     * than a virtual one would be wrong here in a way it is not for a stack
     * object: `Drop` on the pointee dispatches through the vtable, so deleting
     * through a `Pointer<Base>` runs the derived destructor.
     */
    #free(expression: ts.CallExpression, subject: Typed): Typed | undefined {
        if (expression.arguments.length !== 0) {
            this.outer.error(expression, "GF0002", "`free` takes no arguments.");
            return undefined;
        }
        if (subject.type.kind !== "pointer") {
            this.outer.error(
                expression,
                "GF0002",
                `\`free\` releases a \`Pointer<T>\`; this is a \`${renderType(subject.type)}\`.`,
            );
            return undefined;
        }

        const place = this.placeOfSubject(expression, subject);
        if (place === undefined) {
            return undefined;
        }
        const pointee = subject.type.pointee;

        // The value first, then its storage — a destructor is still reading live
        // memory when it runs.
        //
        // For a class this is a **virtual** call to slot 0, which is C++'s virtual
        // destructor and is the one place destruction has to dispatch. Everywhere
        // else the compiler destroys a value whose storage was laid out for exactly
        // its static type, so the dynamic type *is* the static one — but a
        // `Pointer<Base>` may address a `Derived`, and a direct call to `Base$~drop`
        // would leave the derived class's own fields unreleased.
        if (pointee.kind === "class") {
            const info = this.outer.classInfo(pointee.name);
            const destructor = info === undefined ? undefined : this.outer.fn(info.destructorSymbol);
            if (info === undefined || destructor === undefined) {
                this.outer.unsupported(expression, `\`free\` of a \`${renderType(pointee)}\``);
                return undefined;
            }
            this.emitCall(
                expression,
                {kind: "Virtual", slot: 0, sig: destructor.sig},
                [{kind: "Copy", value: place}],
                VOID,
            );
        } else if (needsDrop(pointee)) {
            this.push({
                kind: "Drop",
                place: {local: place.local, projection: [...place.projection, {kind: "Deref"}]},
                flag: null,
                unwind: NO_UNWIND,
            });
        }

        return this.callRuntime(
            expression,
            RUNTIME.free,
            [{operand: {kind: "Copy", value: place}, type: subject.type}],
            VOID,
        );
    }

    /** A runtime call's result, pinned into a local so it can be read twice. */
    #pin(at: ts.Expression, value: Typed): Place | undefined {
        const local = this.f.addLocal({
            ty: this.outer.tyOf(value.type, at),
            storage: "Owned",
        });
        this.push({kind: "StorageLive", value: local});
        this.push({kind: "Init", place: placeOf(local), rvalue: {kind: "Use", value: value.operand}});
        return placeOf(local);
    }

    /**
     * `allocArray<T>(n)` — storage for `n` elements, every one initialised.
     *
     * C++'s `new T[n]`, and built from the same parts `alloc` is: the runtime
     * hands out bytes and remembers how many elements were asked for, and the
     * loop that constructs into them is emitted here, because only this side
     * knows what constructing a `T` means.
     *
     * `Default` per element, exactly as `alloc<T>()` does for its one — there is
     * no uninitialised form anywhere in this language, because a destructor
     * releases what a slot holds and on uninitialised memory that is a garbage
     * pointer. That also means the loop is not optional: `allocArray<string>(4)`
     * followed by `freeArray()` has to be well defined.
     */
    protected allocArray(expression: ts.CallExpression, natural: MachineType): Typed | undefined {
        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(expression, "GF0002", "`allocArray` takes exactly one element count.");
            return undefined;
        }
        if (natural.kind !== "pointer") {
            this.outer.error(
                expression,
                "GF0002",
                "`allocArray` needs the element type written out: `allocArray<i32>(n)`.",
            );
            return undefined;
        }
        const element = natural.pointee;
        if (!this.outer.requireKnownLayout(element, expression, "`allocArray`")) {
            return undefined;
        }

        // The same trap `alloc<T>()` refuses, for the same reason: there is nowhere
        // to put the constructor's arguments, so every element would be allocated
        // and never constructed. C++ says the same thing — `new T[n]` needs a
        // default constructor — it just says it about a constructor this language
        // does not have.
        if (element.kind === "class" && this.outer.classInfo(element.name)?.ctor !== undefined) {
            this.outer.error(
                expression,
                "GF0002",
                `\`${element.name}\` has a constructor, and \`allocArray\` has nowhere to ` +
                "put its arguments. Allocate the elements one at a time with " +
                `\`alloc(${element.name}, …)\`.`,
            );
            return undefined;
        }

        const count = this.expressionTyped(argument, USIZE);
        if (count === undefined) {
            return undefined;
        }
        const ty = this.outer.tyOf(element, expression);
        const size = this.temporaryTyped(expression, USIZE, {kind: "SizeOf", value: ty});
        const align = this.temporaryTyped(expression, USIZE, {kind: "AlignOf", value: ty});
        if (size === undefined || align === undefined) {
            return undefined;
        }

        // Pinned because it is read twice — once by the allocation and once as the
        // loop's bound — and the second read must see the same number the first
        // did, whatever the argument expression was.
        const limit = this.#pin(expression, count);
        if (limit === undefined) {
            return undefined;
        }

        const raw = this.callRuntime(
            expression,
            RUNTIME.allocArray,
            [{operand: {kind: "Copy", value: limit}, type: USIZE}, size, align],
            natural,
        );
        if (raw === undefined) {
            return undefined;
        }
        const place = this.placeOfSubject(expression, raw);
        if (place === undefined) {
            return undefined;
        }

        this.countedLoop(expression, {kind: "Copy", value: limit}, (counter) => {
            this.push({
                kind: "Init",
                place: {
                    local: place.local,
                    projection: [...place.projection, {kind: "Index", value: counter}],
                },
                rvalue: {kind: "Default"},
            });
        });

        return {operand: raw.operand, type: natural};
    }

    /**
     * `p.freeArray()` — destroy every element, then release the run.
     *
     * C++'s `delete[]`, and distinct from `free` for exactly the reason C++ keeps
     * them distinct: one destructor has to run per element, and only the cookie
     * knows how many there are. Calling the wrong one is undefined behaviour here
     * as it is there.
     *
     * The elements are destroyed with `Drop`, which is a **direct** call — the
     * opposite of {@link #free}, which dispatches through the vtable. That is not
     * an inconsistency: a run of `T` strides by `T`'s size, so a
     * `Pointer<Base>` into an array of `Derived` is already addressing the wrong
     * elements before anything is destroyed. C++ makes that undefined for the
     * same reason, and a virtual call here would destroy the right objects at the
     * wrong addresses, which is a worse answer than the wrong destructor.
     */
    #freeArray(expression: ts.CallExpression, subject: Typed): Typed | undefined {
        if (expression.arguments.length !== 0) {
            this.outer.error(expression, "GF0002", "`freeArray` takes no arguments.");
            return undefined;
        }
        if (subject.type.kind !== "pointer") {
            return undefined;
        }
        const element = subject.type.pointee;

        const place = this.placeOfSubject(expression, subject);
        if (place === undefined) {
            return undefined;
        }
        const pointer: Typed = {operand: {kind: "Copy", value: place}, type: subject.type};

        if (needsDrop(element)) {
            const count = this.callRuntime(
                expression,
                RUNTIME.allocArrayCount,
                [pointer],
                USIZE,
            );
            if (count === undefined) {
                return undefined;
            }
            const limit = this.#pin(expression, count);
            if (limit === undefined) {
                return undefined;
            }

            this.countedLoop(expression, {kind: "Copy", value: limit}, (counter) => {
                this.push({
                    kind: "Drop",
                    place: {
                        local: place.local,
                        projection: [...place.projection, {kind: "Index", value: counter}],
                    },
                    flag: null,
                    unwind: NO_UNWIND,
                });
            });
        }

        // The elements first, then the storage — a destructor is still reading live
        // memory when it runs.
        return this.callRuntime(expression, RUNTIME.freeArray, [pointer], VOID);
    }

    /**
     * One of {@link POINTER_METHODS}, with the receiver already lowered.
     *
     * All six are implemented. The width pass sees the same call first and
     * refuses through the same helpers, so anything arriving here has already
     * passed the rules — which is also why a refusal is reported once rather
     * than once per pass.
     */
    protected pointerMethod(
        expression: ts.CallExpression,
        access: ts.PropertyAccessExpression,
        subject: Typed,
    ): Typed | undefined {
        // The two that only relabel the address, before the guard that the other
        // four have to pass. See {@link #reinterpret} for the rule.
        if (
            subject.type.kind === "pointer" &&
            (access.name.text === "erase" || access.name.text === "reify")
        ) {
            const target = this.reinterpret(expression, access, subject.type);
            if (target === undefined) {
                return undefined;
            }
            // A `Cast` rather than the operand relabelled, unlike the implicit
            // erasure in `#coerce`: this one was written, and the MIR should show
            // where. It costs nothing — `PtrToPtr` is the identity in the backend.
            return this.temporaryTyped(expression, target, {
                kind: "Cast",
                op: "PtrToPtr",
                operand: this.forRead(subject),
                to: this.outer.tyOf(target, expression),
            });
        }

        // Every one of these needs the pointee's layout — a stride to step by, a
        // size and an alignment to return to the allocator, a shape to read
        // through. `address` is the member that does not, which is why it is a
        // property and not here.
        if (
            subject.type.kind === "pointer" &&
            !this.outer.requireKnownLayout(
                subject.type.pointee,
                access,
                `\`${access.name.text}\``,
            )
        ) {
            return undefined;
        }

        switch (access.name.text) {
            case "free":
                return this.#free(expression, subject);
            case "freeArray":
                return this.#freeArray(expression, subject);
            case "deref":
                return this.#deref(expression, subject);
            case "offset":
                return this.#offset(expression, subject);
            default:
                this.outer.unsupported(access, `\`${access.name.text}\` on a pointer`);
                return undefined;
        }
    }

    /**
     * `p.deref()` — the pointee, borrowed.
     *
     * A retype and nothing else at runtime: a `Pointer<T>` and a `Reference<T>`
     * are the same machine word holding the same address. It is written out as
     * `Ref` of the dereferenced place rather than handed back as the pointer's
     * own operand so that the local really has the reference's type — the ABI
     * classifies a call's arguments from the MIR types, and a pointer wearing a
     * reference's label is exactly the kind of thing that agrees until it does
     * not.
     *
     * Needed where the auto-dereference cannot reach: `draw(p)` is `GF0161`,
     * because a pointer is not a reference, and `draw(p.deref())` is how you say
     * you meant to borrow rather than to copy.
     */
    #deref(expression: ts.CallExpression, subject: Typed): Typed | undefined {
        if (expression.arguments.length !== 0) {
            this.outer.error(expression, "GF0002", "`deref` takes no arguments.");
            return undefined;
        }
        if (subject.type.kind !== "pointer") {
            return undefined;
        }
        const pointee = subject.type.pointee;

        const place = this.placeOfSubject(expression, subject);
        if (place === undefined) {
            return undefined;
        }
        const target: Place = {
            local: place.local,
            projection: [...place.projection, {kind: "Deref"}],
        };
        return {
            operand: this.refTo(expression, target, pointee),
            type: {kind: "reference", referent: pointee},
        };
    }

    /**
     * `p.offset(n)` — `p + n`, in units of `T`.
     *
     * The address of `p[n]`, which is what C's pointer arithmetic means and is
     * also literally how it is built: the same `Index` projection indexing emits,
     * with `AddrOf` instead of a load. So the stride comes from the layout engine
     * and this function does no arithmetic of its own.
     *
     * The count is an `isize` because it counts backwards too. On a 64-bit target
     * that is already pointer width, so a negative offset scales and wraps to the
     * right address without a widening step to get wrong.
     */
    #offset(expression: ts.CallExpression, subject: Typed): Typed | undefined {
        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(expression, "GF0002", "`offset` takes exactly one element count.");
            return undefined;
        }
        if (subject.type.kind !== "pointer") {
            return undefined;
        }

        const count = this.expressionTyped(argument, ISIZE);
        if (count === undefined) {
            return undefined;
        }
        const base = this.placeOfSubject(expression, subject);
        if (base === undefined) {
            return undefined;
        }

        // Materialised into a local because `Projection::Index` names one — the
        // same step `#elementPlace` takes, and for the same reason: a projection
        // must not refer back to an operand.
        const slot = this.f.addLocal({
            ty: this.outer.tyOf(ISIZE, expression),
            storage: "Temporary",
        });
        this.temporaries.push(slot);
        this.push({kind: "StorageLive", value: slot});
        this.push({
            kind: "Init",
            place: placeOf(slot),
            rvalue: {kind: "Use", value: count.operand},
        });

        return this.temporaryTyped(expression, subject.type, {
            kind: "AddrOf",
            value: {
                local: base.local,
                projection: [...base.projection, {kind: "Index", value: slot}],
            },
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
    protected arrayPush(
        expression: ts.CallExpression,
        array: Typed,
        element: MachineType,
    ): Typed | undefined {
        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(expression, "GF0002", "`push` takes exactly one element.");
            return undefined;
        }
        const resolved = this.asArray(expression, array);
        if (resolved === undefined) {
            return undefined;
        }
        const place = resolved.place;

        const value = this.expressionTyped(argument, element);
        if (value === undefined) {
            return undefined;
        }

        const pointer: MachineType = {kind: "pointer", pointee: element};
        const slot = this.f.addLocal({
            ty: this.outer.tyOf(pointer, expression),
            storage: "Temporary",
            span: this.outer.span(expression),
        });
        this.push({kind: "StorageLive", value: slot});
        this.push({
            kind: "Init",
            place: placeOf(slot),
            rvalue: {kind: "ArrayPushSlot", value: place},
        });
        // `Init`, not `Assign`: the slot is fresh storage the runtime just made
        // room for, so there is no previous element in it to destroy.
        this.push({
            kind: "Init",
            place: {local: slot, projection: [{kind: "Deref"}]},
            rvalue: {kind: "Use", value: this.forStorage(value)},
        });
        this.push({kind: "StorageDead", value: slot});
        return {operand: {kind: "Const", value: this.boolConst(true)}, type: VOID};
    }

    /**
     * `xs.reserve(n)` — make room for `n`, without adding an element.
     *
     * A plain runtime call, where `push` needed a node of its own. The reason is
     * what each has to be told: `push` has to be told where to *put* something,
     * which is a slot only the backend can compute, and this only has to be told
     * how big an element is — which `SizeOf` and `AlignOf` already answer for
     * any type.
     *
     * The **address** of the handle goes across, not the handle. Growing can
     * move the buffer, so the local holding it has to be reseated, and a copy of
     * the handle would leave the caller pointing at the old block. That is the
     * same argument `ArrayPushSlot` makes, arriving at a `Ref` here because this
     * is an ordinary call.
     */
    protected arrayReserve(
        expression: ts.CallExpression,
        array: Typed,
        element: MachineType,
    ): Typed | undefined {
        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(expression, "GF0002", "`reserve` takes exactly one capacity.");
            return undefined;
        }
        const resolved = this.asArray(expression, array);
        if (resolved === undefined) {
            return undefined;
        }

        const capacity = this.expressionTyped(argument, USIZE);
        if (capacity === undefined) {
            return undefined;
        }

        // The array *type*, rather than whatever `array.type` was: the value may
        // have arrived as a `Reference<T[]>`, and `asArray` has already stepped
        // through that indirection, so the place is a handle either way.
        const handle: MachineType = {kind: "array", element};
        const ty = this.outer.tyOf(element, expression);
        const slot = this.temporaryTyped(expression, {kind: "pointer", pointee: handle}, {
            kind: "Ref",
            value: resolved.place,
        });
        const size = this.temporaryTyped(expression, USIZE, {kind: "SizeOf", value: ty});
        const align = this.temporaryTyped(expression, USIZE, {kind: "AlignOf", value: ty});
        if (slot === undefined || size === undefined || align === undefined) {
            return undefined;
        }

        this.callRuntime(expression, RUNTIME.arrayReserve, [slot, capacity, size, align], VOID);
        return {operand: {kind: "Const", value: this.boolConst(true)}, type: VOID};
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
    protected arrayPop(
        expression: ts.CallExpression,
        array: Typed,
        element: MachineType,
    ): Typed | undefined {
        if (expression.arguments.length !== 0) {
            this.outer.error(expression, "GF0002", "`pop` takes no arguments.");
            return undefined;
        }
        const resolved = this.asArray(expression, array);
        if (resolved === undefined) {
            return undefined;
        }
        const place = resolved.place;

        // `length - 1`, in a local, because a projection indexes by local.
        const length = this.temporaryTyped(expression, USIZE, {kind: "Len", value: place});
        if (length === undefined) {
            return undefined;
        }
        const last = this.temporaryTyped(expression, USIZE, {
            kind: "Binary",
            op: "Sub",
            lhs: length.operand,
            rhs: {
                kind: "Const",
                value: {kind: "Int", bits: 1n, ty: this.outer.tyOf(USIZE, expression)},
            },
        });
        if (last === undefined) {
            return undefined;
        }
        const index = this.f.addLocal({
            ty: this.outer.tyOf(USIZE, expression),
            storage: "Temporary",
            span: this.outer.span(expression),
        });
        this.push({kind: "StorageLive", value: index});
        this.push({
            kind: "Init",
            place: placeOf(index),
            rvalue: {kind: "Use", value: last.operand},
        });

        const slot = {local: place.local, projection: [...place.projection, {kind: "Index" as const, value: index}]};
        const taken = this.temporaryTyped(expression, element, {
            kind: "Use",
            value: {kind: "Move", value: slot},
        });
        if (taken === undefined) {
            return undefined;
        }

        // After the element has been taken, never before: shortening first would
        // leave the last slot outside the array while it is still being read.
        this.callRuntime(
            expression,
            RUNTIME.arrayPop,
            [{operand: {kind: "Copy", value: place}, type: array.type}],
            VOID,
        );
        this.push({kind: "StorageDead", value: index});
        return taken;
    }

    /**
     * A `LocalFn` argument, as the place its two words occupy.
     *
     * The expected type comes from **tsc's contextual type**, not from the
     * lambda: a lambda has no type of its own, and the prelude's declaration is
     * what says the parameter is a `LocalFn<(value: T) => void>` with `T`
     * substituted. Erasing that is what turns `(x) => …` into a closure value
     * rather than a `GF0001` about a construct with nowhere to land.
     */
    protected closureArgument(
        argument: ts.Expression,
    ): { place: Place; type: Extract<MachineType, { kind: "localfn" }> } | undefined {
        const contextual = this.outer.checker.getContextualType(argument);
        const expected =
            contextual === undefined ? undefined : this.erase(argument, contextual);
        if (expected === undefined || expected.kind !== "localfn") {
            this.outer.unsupported(argument, "a callback that is not a `LocalFn`");
            return undefined;
        }
        const value = this.expressionTyped(argument, expected);
        if (value === undefined) {
            return undefined;
        }
        if (value.operand.kind === "Const") {
            // A closure is two words in a frame slot; there is no constant form
            // of one, so this is a shape nothing produces rather than a rule.
            this.outer.unsupported(argument, "a callback with no address");
            return undefined;
        }
        return {place: value.operand.value, type: expected};
    }

    /**
     * Call a `LocalFn` whose arguments are already lowered.
     *
     * The environment goes first, exactly as {@link BodyLowerer.localFnCall}
     * puts it there for a written call: field 0 is the code address and field 1
     * the environment, and a lifted body takes the environment as its own
     * parameter zero.
     */
    protected invokeClosure(
        at: ts.CallExpression,
        callback: { place: Place; type: Extract<MachineType, { kind: "localfn" }> },
        args: readonly Operand[],
    ): Typed | undefined {
        const field = (index: number): Place => ({
            local: callback.place.local,
            projection: [...callback.place.projection, {kind: "Field", value: FieldId(index)}],
        });
        return this.emitCall(
            at,
            {
                kind: "Indirect",
                operand: {kind: "Copy", value: field(0)},
                sig: this.outer.localFnSig(callback.type, at),
            },
            [{kind: "Copy", value: field(1)}, ...args],
            callback.type.returns,
        );
    }

    /**
     * `xs.forEach(f)` — call `f` with each element, in order.
     *
     * The loop is emitted here rather than run in the runtime, and that is what
     * makes it possible at all: the runtime would need the element's stride and
     * a way to pass a value it has no type for, while the frontend knows both.
     * It is the loop {@link fixedArray} emits, over a length read from the
     * handle instead of a constant.
     *
     * **The length is read once, before the first call.** So growing or
     * shrinking the array from inside `f` is undefined here in exactly the way
     * mutating a `std::vector` while iterating it is — and the alternative,
     * re-reading `Len` every turn, turns a `push` inside `f` into a loop that
     * does not end.
     *
     * The element is **copied** into the call, because the callback's parameter
     * is a `T` by value and a by-value argument of an owning type is a copy
     * everywhere else in the language. `Reference<T>` is the parameter to write
     * where that copy is not wanted.
     */
    protected arrayForEach(
        expression: ts.CallExpression,
        array: Typed,
        element: MachineType,
    ): Typed | undefined {
        const argument = expression.arguments[0];
        if (expression.arguments.length !== 1 || argument === undefined) {
            this.outer.error(expression, "GF0002", "`forEach` takes exactly one function.");
            return undefined;
        }
        const callback = this.closureArgument(argument);
        if (callback === undefined) {
            return undefined;
        }
        if (callback.type.params.length !== 1) {
            this.outer.unsupported(argument, "a `forEach` callback that does not take one argument");
            return undefined;
        }
        const resolved = this.asArray(expression, array);
        if (resolved === undefined) {
            return undefined;
        }

        this.eachElement(expression, resolved.place, element, (slot) => {
            this.invokeClosure(expression, callback, [{kind: "Copy", value: slot}]);
        });
        return {operand: {kind: "Const", value: {kind: "Unit"}}, type: VOID};
    }

    /**
     * The loop every array method shares: `i` from zero to the length it had
     * when the loop began, with `body` emitted over each element's place.
     */
    protected eachElement(
        at: ts.Expression,
        array: Place,
        element: MachineType,
        body: (slot: Place) => void,
    ): void {
        void element;
        const usizeTy = this.outer.tyOf(USIZE, at);
        const one: Operand = {kind: "Const", value: {kind: "Int", bits: 1n, ty: usizeTy}};
        const zero: Operand = {kind: "Const", value: {kind: "Int", bits: 0n, ty: usizeTy}};

        // Read once, into its own local: the loop's range is decided before the
        // first call, not renegotiated on every turn.
        const limit = this.f.addLocal({ty: usizeTy, storage: "Owned"});
        this.push({kind: "StorageLive", value: limit});
        this.push({kind: "Init", place: placeOf(limit), rvalue: {kind: "Len", value: array}});

        const counter = this.f.addLocal({ty: usizeTy, storage: "Owned"});
        const test = this.f.addLocal({ty: this.boolTy(), storage: "Temporary"});

        const head = this.f.block();
        const step = this.f.block();
        const exit = this.f.block();

        this.push({kind: "StorageLive", value: counter});
        this.push({kind: "Init", place: placeOf(counter), rvalue: {kind: "Use", value: zero}});
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
                rhs: {kind: "Copy", value: placeOf(limit)},
            },
        });
        this.seal({kind: "Branch", cond: {kind: "Copy", value: placeOf(test)}, thenBlock: step, elseBlock: exit});

        this.current = step;
        body({local: array.local, projection: [...array.projection, {kind: "Index", value: counter}]});
        this.push({
            kind: "Assign",
            place: placeOf(counter),
            rvalue: {
                kind: "Binary",
                op: "Add",
                lhs: {kind: "Copy", value: placeOf(counter)},
                rhs: one,
            },
        });
        this.seal({kind: "Goto", value: head});

        this.current = exit;
        this.push({kind: "StorageDead", value: test});
        this.push({kind: "StorageDead", value: counter});
        this.push({kind: "StorageDead", value: limit});
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
    protected fixedArray(expression: ts.CallExpression, natural: MachineType): Typed | undefined {
        if (natural.kind !== "fixedArray") {
            this.outer.error(
                expression,
                "GF0161",
                `\`fixedArray\` builds a \`FixedArray<T, N>\`, not a ` +
                `\`${renderType(natural)}\`.`,
            );
            return undefined;
        }
        const fillExpression = expression.arguments[1];
        if (expression.arguments.length !== 2 || fillExpression === undefined) {
            this.outer.error(
                expression,
                "GF0001",
                "`fixedArray` takes a length and a fill value.",
            );
            return undefined;
        }

        const ty = this.outer.tyOf(natural, expression);
        const array = this.f.addLocal({ty, storage: "Temporary"});
        this.temporaries.push(array);
        this.push({kind: "StorageLive", value: array});
        this.push({kind: "Init", place: placeOf(array), rvalue: {kind: "Default"}});

        if (natural.length > 0) {
            const fill = this.expressionTyped(fillExpression, natural.element);
            if (fill === undefined) {
                return undefined;
            }

            const counter = this.f.addLocal({
                ty: this.outer.tyOf(USIZE, expression),
                storage: "Owned",
            });
            const test = this.f.addLocal({
                ty: this.boolTy(),
                storage: "Temporary",
            });
            const usizeTy = this.outer.tyOf(USIZE, expression);
            const limit: Operand = {
                kind: "Const",
                value: {kind: "Int", bits: BigInt(natural.length), ty: usizeTy},
            };
            const one: Operand = {
                kind: "Const",
                value: {kind: "Int", bits: 1n, ty: usizeTy},
            };
            const zero: Operand = {
                kind: "Const",
                value: {kind: "Int", bits: 0n, ty: usizeTy},
            };

            const head = this.f.block();
            const body = this.f.block();
            const exit = this.f.block();

            this.push({kind: "StorageLive", value: counter});
            this.push({kind: "Init", place: placeOf(counter), rvalue: {kind: "Use", value: zero}});
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
                thenBlock: body,
                elseBlock: exit,
            });

            this.current = body;
            // `Init`, not `Assign`: the slot was zeroed and holds nothing, so there
            // is nothing to destroy first.
            //
            // And `Copy`, not the usual move-out-of-a-temporary: the loop runs `N`
            // times and each element needs its own value. Moving would put the fill
            // in the first element and leave every other one holding the empty value
            // the move left behind.
            this.push({
                kind: "Init",
                place: {local: array, projection: [{kind: "Index", value: counter}]},
                rvalue: {kind: "Use", value: this.repeatable(fill)},
            });
            this.push({
                kind: "Assign",
                place: placeOf(counter),
                rvalue: {
                    kind: "Binary",
                    op: "Add",
                    lhs: {kind: "Copy", value: placeOf(counter)},
                    rhs: one,
                },
            });
            this.seal({kind: "Goto", value: head});

            this.current = exit;
            this.push({kind: "StorageDead", value: test});
            this.push({kind: "StorageDead", value: counter});
        }

        return {
            operand: {kind: "Borrow", value: placeOf(array)},
            type: natural,
            temporary: array,
        };
    }
}
