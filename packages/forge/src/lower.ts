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
 * {@link WidthPass.width} answers *what width is this expression, on its own
 * terms* — bottom-up, memoised, and the only place a width diagnostic is
 * raised. It reports one of three things: a definite type, **polymorphic**
 * (built only from literals, so it takes its width from context), or an error
 * already reported.
 *
 * `value` then lowers top-down, with the expected type known, so a literal is
 * range-checked against the width it is actually becoming and a promotion is
 * emitted as an explicit `Cast` rather than assumed.
 *
 * Doing it in one pass is what forces a compiler to guess at `a * b < c`. The
 * rules themselves live in `@goblin-forge/checker`'s width tables, not here:
 * REWRITE-PLAN §7 asks for one table-driven place, and scattering them back
 * through lowering is how they stop agreeing with each other.
 *
 * ## Where things are
 *
 * Lowering was one 9,000-line file. This map is here so that changing one thing
 * means opening one file.
 *
 * Two halves, and the boundary between them is already narrow:
 *
 * * `lower/module.ts` — {@link Lowerer}. Declarations, classes, interfaces, and
 *   the type interning every body shares. Runs first, and answers questions.
 * * `lower/body.ts` and the four files below it — `BodyLowerer`. Statements and
 *   expressions, to basic blocks. Runs second, and asks them: a body reaches
 *   the module through some 25 public members of `Lowerer` and nothing else.
 *
 * The body half is a chain of classes, each its own file, each extending the
 * one before it:
 *
 * ```text
 * emit.ts → width.ts → intrinsics.ts → c-boundary.ts → body.ts
 * ```
 *
 * * `emit.ts` — the block cursor and the primitives everything builds with.
 * * `width.ts` — the width pass described above.
 * * `intrinsics.ts` — the prelude's memory operations: `alloc`, `free`,
 *   `FixedArray`, the pointer methods, array push and pop.
 * * `c-boundary.ts` — where a value crosses to C: `cstring`, the string
 *   conversions, `reify<U>()`, and `cast`.
 * * `body.ts` — statements, scopes, and the value and coercion rules the rest
 *   of the chain calls back into.
 *
 * **`protected` means "another file in this chain reads this".** Everything
 * else stays a `#private` name, and a member that stops crossing a file should
 * go back to being one. Calls run *down* the chain freely; the ones that run
 * **up** are declared as `protected abstract` in `emit.ts`, which is therefore
 * the complete list of what a lower layer is allowed to want from a higher one.
 *
 * Supporting files, in no layer: `lower/tables.ts` (data), `lower/types.ts`
 * (shared shapes), `lower/scopes.ts` (the scope stack), `lower/util.ts` (small
 * answers about a type).
 */

import ts from "typescript";

import { Lowerer } from "./lower/module.ts";
import type { LowerResult } from "./lower/types.ts";

export type { LowerResult };

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
