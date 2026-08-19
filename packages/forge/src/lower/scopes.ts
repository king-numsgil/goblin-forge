/**
 * The lexical scope stack, and the loop frames that unwind it.
 *
 * REWRITE-PLAN §10. A scope has an **identity** and `break` names the one it is
 * unwinding to, because arithmetic on scope depth is v1's `switch` double free.
 * Kept together in one file so that the identity rule and the unwind that
 * depends on it cannot drift apart.
 */

import { type BlockId, LocalId, type TyId } from "@goblin-forge/backend";
import type { MachineType } from "@goblin-forge/checker";

export interface Binding {
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
export interface Scope {
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
export class Scopes {
    #nextId = 0;
    readonly #stack: Scope[] = [];

    constructor() {
        this.push();
    }

    get innermost(): Scope {
        return this.#stack[this.#stack.length - 1]!;
    }

    push(): Scope {
        const scope: Scope = {id: this.#nextId++, bindings: new Map(), locals: []};
        this.#stack.push(scope);
        return scope;
    }

    pop(): Scope {
        if (this.#stack.length === 1) {
            throw new Error("popped the outermost scope");
        }
        return this.#stack.pop()!;
    }

    declare(name: string, binding: Binding): void {
        const scope = this.innermost;
        scope.bindings.set(name, binding);
        scope.locals.push(binding.local);
    }

    lookup(name: string): Binding | undefined {
        for (let index = this.#stack.length - 1; index >= 0; index -= 1) {
            const found = this.#stack[index]!.bindings.get(name);
            if (found !== undefined) {
                return found;
            }
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
            if (scope.id === until.id) {
                return out;
            }
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
export interface LoopFrame {
    readonly breakTo: BlockId;
    /**
     * Where `continue` goes, or `undefined` when this frame is not a loop.
     *
     * A `switch` and a labelled block are both breakable and neither is
     * continuable, which is exactly JavaScript's rule: `continue` inside a
     * `switch` continues the loop *around* the switch. Recording that as an
     * absent target rather than as a second kind of frame means the search skips
     * it for free.
     */
    readonly continueTo: BlockId | undefined;
    /**
     * The scope the loop statement itself lives in. Everything opened inside it
     * is released on the way out; it is not.
     */
    readonly enclosing: Scope;
    /** The label this frame was introduced with, for `break outer`. */
    readonly label?: string | undefined;
}
