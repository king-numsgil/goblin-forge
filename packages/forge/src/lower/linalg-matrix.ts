/**
 * `std/linalg`'s matrices, lowered.
 *
 * DECISIONS §22. Split from `linalg.ts` because it is one subject and a long
 * one; the dispatch — which spelling was written, where the result goes — stays
 * there and reaches this through two hooks, so there is exactly one copy of it.
 *
 * **A matrix is columns of a vector type, and every algorithm here is written
 * in terms of columns.** That is what made matrices cheap: `dmat3` is a struct
 * of three `dvec3`, so a column is an ordinary field projection, `add` is the
 * vector `add` three times, and a matrix–vector product is a multiply and two
 * fused multiply-adds over whole columns rather than nine scalar multiplies.
 *
 * **Column-major, with column vectors.** `A.mul(B)` is `A * B`, so `B` is
 * applied first; `m.c0` is the first column. GLM's convention, and therefore
 * what every shader and every piece of reference code assumes.
 *
 * The one place that is deliberately *not* clever is `determinant` and
 * `inverse`: cofactor expansion over extracted scalars, memoised on the
 * sub-determinant. A 4x4 inverse is a few hundred instructions that way. The
 * alternative is a hand-written 4x4 formula per order, which is three
 * unrelated bodies of arithmetic nobody can check by reading — and this is
 * arithmetic where being right matters more than being quick, because a wrong
 * inverse produces a plausible matrix.
 */

import type { LocalId } from "@goblin-forge/backend";
import {
    type LinalgCtor,
    type LinalgType,
    columnTypeOf,
} from "@goblin-forge/checker";
import ts from "typescript";

import { type LinalgCall, LinalgLowerer } from "./linalg.ts";
import type { Typed } from "./types.ts";

/** A matrix taken apart into scalars, indexed `[column][row]`. */
type Entries = Typed[][];

export abstract class MatrixLowerer extends LinalgLowerer {
    /**
     * Every matrix operation, given the receiver and its evaluated arguments.
     *
     * Hands back either a finished value — for the operations that produce
     * something other than a matrix — or the result's columns, which the caller
     * writes into a temporary or back through the receiver according to which
     * spelling was used.
     */
    protected matrixCompose(
        at: ts.Node,
        call: LinalgCall,
        self: Typed,
        args: readonly Typed[],
    ): { value: Typed } | { columns: LocalId[] } | undefined {
        const {op, type} = call;
        const column = columnTypeOf(type);
        if (column === undefined) {
            this.outer.unsupported(at, `\`${type.name}\`, which has no column type`);
            return undefined;
        }
        const columns = this.loadColumns(at, self, type, column);
        if (columns === undefined) {
            return undefined;
        }

        const other = (index: number): LocalId[] | undefined => {
            const argument = args[index];
            return argument === undefined
                ? undefined
                : this.loadColumns(at, argument, type, column);
        };

        switch (op.kind) {
            // The four that are the *vector* operation of the same name, once
            // per column. No matrix-specific arithmetic at all.
            case "elementwise": {
                const rhs = other(0);
                if (rhs === undefined) {
                    return undefined;
                }
                return {
                    columns: columns.map((left, index) =>
                        this.simdLocal(at, column, {
                            kind: "SimdBinary",
                            op: op.op,
                            lhs: this.simdRead(left),
                            rhs: this.simdRead(rhs[index]!),
                        }),
                    ),
                };
            }
            case "scaled": {
                const scalar = args[0];
                if (scalar === undefined) {
                    return undefined;
                }
                // Splatted once and reused for every column, rather than once
                // per column: the broadcast is the same value each time.
                const factor = this.splat(at, this.forRead(scalar), column);
                return {
                    columns: columns.map((left) =>
                        this.simdLocal(at, column, {
                            kind: "SimdBinary",
                            op: op.op,
                            lhs: this.simdRead(left),
                            rhs: this.simdRead(factor),
                        }),
                    ),
                };
            }
            case "unary":
                return {
                    columns: columns.map((left) =>
                        this.simdLocal(at, column, {
                            kind: "SimdUnary",
                            op: op.op,
                            operand: this.simdRead(left),
                        }),
                    ),
                };

            // `A * B`: each output column is `A` applied to the corresponding
            // column of `B`, which is exactly `mulVec` — so one implementation
            // serves both, and the matrix product is the vector product run
            // once per column.
            case "matMul": {
                const rhs = other(0);
                if (rhs === undefined) {
                    return undefined;
                }
                return {
                    columns: rhs.map((vector) =>
                        this.applyTo(at, type, column, columns, vector),
                    ),
                };
            }
            case "matMulVec": {
                const argument = args[0];
                if (argument === undefined) {
                    return undefined;
                }
                const vector = this.loadVector(at, argument, column);
                if (vector === undefined) {
                    return undefined;
                }
                const result = this.applyTo(at, type, column, columns, vector);
                return {value: this.storeVector(at, result, column)};
            }

            case "transpose":
                return {columns: this.transpose(at, type, column, columns)};

            case "determinant": {
                const entries = this.entriesOf(at, type, column, columns);
                return {value: this.determinant(at, type, entries)};
            }

            case "inverse":
                return this.inverse(at, type, column, columns);

            // Column-wise equality, and-ed. The padding lane of an `aligned_`
            // column is never read, because the vector `equals` compares
            // components rather than lanes.
            case "equals": {
                const rhs = other(0);
                if (rhs === undefined) {
                    return undefined;
                }
                let all: Typed | undefined;
                for (const [index, left] of columns.entries()) {
                    const same = this.laneWiseEquals(at, left, rhs[index]!, column);
                    all =
                        all === undefined
                            ? same
                            : this.temporaryTyped(at, {kind: "bool"}, {
                                kind: "Binary",
                                op: "BitAnd",
                                lhs: this.forRead(all),
                                rhs: this.forRead(same),
                            });
                }
                return all === undefined ? undefined : {value: all};
            }

            default:
                this.outer.unsupported(at, `\`${op.name}\` on a \`${type.name}\``);
                return undefined;
        }
    }

    /**
     * `M * v`, as a multiply and `order - 1` fused multiply-adds.
     *
     * The column-major form is what makes this the cheap one: the result is a
     * linear combination of `M`'s *columns*, weighted by `v`'s components, so
     * every operation is over whole vectors and nothing is transposed. A
     * row-major matrix would need a dot product per row instead — the same
     * arithmetic with a horizontal add in the middle of it.
     */
    private applyTo(
        at: ts.Node,
        type: LinalgType,
        column: LinalgType,
        columns: readonly LocalId[],
        vector: LocalId,
    ): LocalId {
        let accumulator: LocalId | undefined;
        for (const [index, matrixColumn] of columns.entries()) {
            const weight = this.splat(at, this.forRead(this.laneOf(at, column, vector, index)), column);
            accumulator =
                accumulator === undefined
                    ? this.simdLocal(at, column, {
                        kind: "SimdBinary",
                        op: "Mul",
                        lhs: this.simdRead(matrixColumn),
                        rhs: this.simdRead(weight),
                    })
                    // Fused, so a transform chain rounds once per term rather
                    // than twice. §22 emits no fast-math flags, so this is the
                    // only way the contraction happens — and it happens where
                    // it is written.
                    : this.simdLocal(at, column, {
                        kind: "SimdFma",
                        a: this.simdRead(matrixColumn),
                        b: this.simdRead(weight),
                        c: this.simdRead(accumulator),
                    });
        }
        // Unreachable: no matrix has zero columns.
        return accumulator ?? this.splat(at, this.componentConst(at, column, 0), column);
    }

    /**
     * The transpose, built lane by lane.
     *
     * Output column `i` is made of lane `i` of every input column. The 4x4
     * shuffle-based transpose is four `unpck` pairs and would be faster; this
     * is written out because it is the same code for orders two, three and four
     * and because a transpose is rarely in an inner loop. It is a clearly
     * marked place to optimise later rather than a hidden one.
     */
    private transpose(
        at: ts.Node,
        type: LinalgType,
        column: LinalgType,
        columns: readonly LocalId[],
    ): LocalId[] {
        return type.components.map((_, row) =>
            this.vectorFromLanes(
                at,
                column,
                columns.map((source) => this.laneOf(at, column, source, row)),
            ),
        );
    }

    /** The matrix as scalars, indexed `[column][row]`. */
    private entriesOf(
        at: ts.Node,
        type: LinalgType,
        column: LinalgType,
        columns: readonly LocalId[],
    ): Entries {
        return columns.map((vector) =>
            type.components.map((_, row) => this.laneOf(at, column, vector, row)),
        );
    }

    /**
     * `det(M)`, by cofactor expansion along the first remaining row.
     *
     * Memoised on the set of rows and columns still in play, which is what
     * keeps a 4x4 from recomputing the same 2x2 sub-determinants dozens of
     * times: sixteen cofactors share nine of them.
     */
    private determinant(at: ts.Node, type: LinalgType, entries: Entries): Typed {
        const order = entries.length;
        const all = Array.from({length: order}, (_, index) => index);
        return this.minor(at, type, entries, all, all, new Map());
    }

    /**
     * The determinant of the submatrix keeping `rows` and `cols`.
     *
     * `entries[c][r]` is the entry at column `c`, row `r`, so a *matrix* row
     * index selects a lane and a *matrix* column index selects a vector. Both
     * appear here and mixing them up is the whole hazard, which is why they are
     * never abbreviated to `i` and `j`.
     */
    private minor(
        at: ts.Node,
        type: LinalgType,
        entries: Entries,
        rows: readonly number[],
        cols: readonly number[],
        memo: Map<string, Typed>,
    ): Typed {
        const key = `${rows.join(",")}|${cols.join(",")}`;
        const cached = memo.get(key);
        if (cached !== undefined) {
            // Re-read rather than reused as-is: a `Typed` from `temporaryTyped`
            // may be a move-once operand, and a shared sub-determinant is by
            // definition read more than once.
            return {operand: this.repeatable(cached), type: cached.type};
        }

        if (rows.length === 1) {
            const only = entries[cols[0]!]![rows[0]!]!;
            const value = {operand: this.repeatable(only), type: only.type};
            memo.set(key, only);
            return value;
        }

        const row = rows[0]!;
        const rest = rows.slice(1);
        let total: Typed | undefined;
        for (const [position, col] of cols.entries()) {
            const sub = this.minor(
                at,
                type,
                entries,
                rest,
                cols.filter((candidate) => candidate !== col),
                memo,
            );
            const entry = entries[col]![row]!;
            const term = this.scalarOp(at, "Mul", type, {
                operand: this.repeatable(entry),
                type: entry.type,
            }, sub);
            total =
                total === undefined
                    ? (position % 2 === 0 ? term : this.scalarNeg(at, type, term))
                    : this.scalarOp(at, position % 2 === 0 ? "Add" : "Sub", type, total, term);
        }
        const answer = total ?? this.scalarConst(at, type, 0);
        memo.set(key, answer);
        return answer;
    }

    /**
     * `M⁻¹`, as the adjugate over the determinant.
     *
     * `inv[c][r] = (-1)^(c+r) * minor(row c, col r) / det`, which is the
     * adjugate — the *transpose* of the cofactor matrix — and the transpose is
     * why the indices read crossed over. Getting it the other way round yields
     * the inverse of the transpose, which is a matrix, is invertible, and is
     * wrong.
     *
     * A singular matrix divides by zero and gives infinities and NaNs, exactly
     * as every other total operation in this language does (DECISIONS §21).
     * There is no error to return and nothing to raise into.
     */
    private inverse(
        at: ts.Node,
        type: LinalgType,
        column: LinalgType,
        columns: readonly LocalId[],
    ): { columns: LocalId[] } {
        const entries = this.entriesOf(at, type, column, columns);
        const order = entries.length;
        const all = Array.from({length: order}, (_, index) => index);
        const memo = new Map<string, Typed>();

        const determinant = this.minor(at, type, entries, all, all, memo);
        const one = this.scalarConst(at, type, 1);
        // Reciprocal once, then a multiply per entry: one division instead of
        // sixteen. The rounding differs from dividing each entry, and by less
        // than the cofactor expansion itself already costs.
        const reciprocal = this.scalarOp(at, "Div", type, one, determinant);

        const result = all.map((c) =>
            this.vectorFromLanes(
                at,
                column,
                all.map((r) => {
                    const sub = this.minor(
                        at,
                        type,
                        entries,
                        all.filter((row) => row !== c),
                        all.filter((col) => col !== r),
                        memo,
                    );
                    const signed = (c + r) % 2 === 0 ? sub : this.scalarNeg(at, type, sub);
                    return this.scalarOp(at, "Mul", type, signed, {
                        operand: this.repeatable(reciprocal),
                        type: reciprocal.type,
                    });
                }),
            ),
        );
        return {columns: result};
    }

    // -- constructors ---------------------------------------------------------

    /**
     * `dmat4.identity()`, `dmat4.perspective(…)` and the rest.
     *
     * Every one builds its columns as scalars and packs them, because that is
     * what these matrices are: mostly zeroes, a few ones, and a handful of terms
     * that have to be in exactly the right slot. Writing them as columns of
     * named scalars is the form in which they can be checked against a
     * reference.
     */
    protected matrixCtor(
        expression: ts.CallExpression,
        type: LinalgType,
        ctor: LinalgCtor,
        args: readonly ts.Expression[],
    ): Typed | undefined {
        const column = columnTypeOf(type);
        if (column === undefined) {
            this.outer.unsupported(expression, `\`${type.name}\`, which has no column type`);
            return undefined;
        }
        const order = type.components.length;
        const zero = () => this.scalarConst(expression, type, 0);
        const one = () => this.scalarConst(expression, type, 1);

        /** Pack rows of scalars — written row by row, as the maths is. */
        const fromRows = (rows: readonly (readonly Typed[])[]): Typed =>
            this.matrixValue(
                expression,
                type,
                Array.from({length: order}, (_, c) =>
                    this.vectorFromLanes(
                        expression,
                        column,
                        rows.map((row) => row[c]!),
                    ),
                ),
            );

        switch (ctor.kind) {
            case "zero":
                return this.matrixValue(
                    expression,
                    type,
                    type.components.map(() =>
                        this.splat(expression, this.componentConst(expression, column, 0), column),
                    ),
                );

            case "identity":
                return this.matrixValue(
                    expression,
                    type,
                    type.components.map((_, index) =>
                        this.vectorFromLanes(
                            expression,
                            column,
                            type.components.map((__, row) =>
                                this.scalarConst(expression, type, row === index ? 1 : 0),
                            ),
                        ),
                    ),
                );

            case "columns": {
                const columns: LocalId[] = [];
                for (const [index, argument] of args.entries()) {
                    if (index >= order) {
                        break;
                    }
                    const value = this.value(argument, this.linalgStructOf(column));
                    const vector = value && this.loadVector(expression, value, column);
                    if (vector === undefined) {
                        return undefined;
                    }
                    columns.push(vector);
                }
                if (columns.length !== order) {
                    this.outer.error(
                        expression,
                        "GF0002",
                        `\`${type.name}.fromColumns\` takes ${order} columns, and was ` +
                        `given ${args.length}.`,
                    );
                    return undefined;
                }
                return this.matrixValue(expression, type, columns);
            }

            case "scaling": {
                const axis = this.axisComponents(expression, type, args[0]);
                if (axis === undefined) {
                    return undefined;
                }
                return this.matrixValue(
                    expression,
                    type,
                    type.components.map((_, index) =>
                        this.vectorFromLanes(
                            expression,
                            column,
                            type.components.map((__, row) => {
                                if (row !== index) {
                                    return zero();
                                }
                                // The fourth diagonal entry of a `mat4` scale is
                                // 1: it scales the axes, not the homogeneous
                                // coordinate.
                                return index < 3 ? axis[index]! : one();
                            }),
                        ),
                    ),
                );
            }

            case "translation": {
                const offset = this.axisComponents(expression, type, args[0]);
                if (offset === undefined) {
                    return undefined;
                }
                return this.matrixValue(expression, type, [
                    this.vectorFromLanes(expression, column, [one(), zero(), zero(), zero()]),
                    this.vectorFromLanes(expression, column, [zero(), one(), zero(), zero()]),
                    this.vectorFromLanes(expression, column, [zero(), zero(), one(), zero()]),
                    this.vectorFromLanes(expression, column, [
                        offset[0]!,
                        offset[1]!,
                        offset[2]!,
                        one(),
                    ]),
                ]);
            }

            case "rotation2D": {
                const angle = this.angleOf(expression, type, args[0]);
                if (angle === undefined) {
                    return undefined;
                }
                // Columns, so this reads transposed from the usual
                // `[[c, -s], [s, c]]`: the first column is `(c, s)`.
                return this.matrixValue(expression, type, [
                    this.vectorFromLanes(expression, column, [angle.cos, angle.sin]),
                    this.vectorFromLanes(expression, column, [
                        this.scalarNeg(expression, type, angle.sin),
                        angle.cos,
                    ]),
                ]);
            }

            case "rotationX":
            case "rotationY":
            case "rotationZ": {
                const angle = this.angleOf(expression, type, args[0]);
                if (angle === undefined) {
                    return undefined;
                }
                const {cos, sin} = angle;
                const negSin = () => this.scalarNeg(expression, type, sin);
                // Written as **rows**, which is how every reference states them,
                // and packed into columns by `fromRows`. Writing them as columns
                // here would mean transposing three matrices by hand in the one
                // place where a transposition is invisible.
                const rows: Typed[][] =
                    ctor.kind === "rotationX"
                        ? [
                            [one(), zero(), zero()],
                            [zero(), cos, negSin()],
                            [zero(), sin, cos],
                        ]
                        : ctor.kind === "rotationY"
                            ? [
                                [cos, zero(), sin],
                                [zero(), one(), zero()],
                                [negSin(), zero(), cos],
                            ]
                            : [
                                [cos, negSin(), zero()],
                                [sin, cos, zero()],
                                [zero(), zero(), one()],
                            ];
                return fromRows(this.homogeneous(expression, type, rows));
            }

            case "axisAngle": {
                const axis = this.axisComponents(expression, type, args[0], true);
                const angle = this.angleOf(expression, type, args[1]);
                if (axis === undefined || angle === undefined) {
                    return undefined;
                }
                const {cos, sin} = angle;
                const [x, y, z] = axis as [Typed, Typed, Typed];
                const t = this.scalarOp(expression, "Sub", type, one(), cos);
                const term = (a: Typed, b: Typed): Typed =>
                    this.scalarOp(
                        expression,
                        "Mul",
                        type,
                        this.scalarOp(expression, "Mul", type, this.reread(t), a),
                        b,
                    );
                const s = (component: Typed): Typed =>
                    this.scalarOp(expression, "Mul", type, this.reread(sin), component);
                // Rodrigues' rotation formula, as rows.
                const rows: Typed[][] = [
                    [
                        this.scalarOp(expression, "Add", type, term(this.reread(x), this.reread(x)), this.reread(cos)),
                        this.scalarOp(expression, "Sub", type, term(this.reread(x), this.reread(y)), s(this.reread(z))),
                        this.scalarOp(expression, "Add", type, term(this.reread(x), this.reread(z)), s(this.reread(y))),
                    ],
                    [
                        this.scalarOp(expression, "Add", type, term(this.reread(x), this.reread(y)), s(this.reread(z))),
                        this.scalarOp(expression, "Add", type, term(this.reread(y), this.reread(y)), this.reread(cos)),
                        this.scalarOp(expression, "Sub", type, term(this.reread(y), this.reread(z)), s(this.reread(x))),
                    ],
                    [
                        this.scalarOp(expression, "Sub", type, term(this.reread(x), this.reread(z)), s(this.reread(y))),
                        this.scalarOp(expression, "Add", type, term(this.reread(y), this.reread(z)), s(this.reread(x))),
                        this.scalarOp(expression, "Add", type, term(this.reread(z), this.reread(z)), this.reread(cos)),
                    ],
                ];
                return fromRows(this.homogeneous(expression, type, rows));
            }

            case "lookAt":
                return this.lookAt(expression, type, column, args);

            case "perspective":
                return this.perspective(expression, type, column, args);

            case "ortho":
                return this.ortho(expression, type, column, args);

            default:
                this.outer.unsupported(expression, `\`${ctor.name}\` on \`${type.name}\``);
                return undefined;
        }
    }

    /**
     * Pad a 3x3 block of rows out to a `mat4`'s four, affinely.
     *
     * A rotation is a 3x3 thing; a `mat4` carries it in the upper-left block
     * with a zero translation and a 1 in the corner. Doing it here means the
     * rotation builders above are written once and are the same arithmetic at
     * both orders.
     */
    private homogeneous(
        at: ts.Node,
        type: LinalgType,
        rows: readonly (readonly Typed[])[],
    ): Typed[][] {
        const order = type.components.length;
        if (order === 3) {
            return rows.map((row) => [...row]);
        }
        const zero = () => this.scalarConst(at, type, 0);
        const padded = rows.map((row) => [...row, zero()]);
        padded.push([zero(), zero(), zero(), this.scalarConst(at, type, 1)]);
        return padded;
    }

    /** A value that is about to be read again. */
    private reread(value: Typed): Typed {
        return {operand: this.repeatable(value), type: value.type};
    }

    /** `sin` and `cos` of one angle argument, each computed once. */
    private angleOf(
        at: ts.CallExpression,
        type: LinalgType,
        argument: ts.Expression | undefined,
    ): { sin: Typed; cos: Typed } | undefined {
        const operand = this.scalarArgument(at, type, argument);
        if (operand === undefined) {
            return undefined;
        }
        const angle: Typed = {operand, type: this.componentType(type)};
        const sin = this.mathCall(at, type, "sin", angle);
        const cos = this.mathCall(at, type, "cos", {
            operand: this.repeatable(angle),
            type: angle.type,
        });
        if (sin === undefined || cos === undefined) {
            return undefined;
        }
        return {sin: this.reread(sin), cos: this.reread(cos)};
    }

    /**
     * The three components of a `vec3` argument, optionally normalised first.
     *
     * `fromAxisAngle` normalises, because a rotation about a non-unit axis is
     * not a rotation and silently scales — a shear that looks almost right.
     */
    private axisComponents(
        at: ts.CallExpression,
        type: LinalgType,
        argument: ts.Expression | undefined,
        normalise = false,
    ): Typed[] | undefined {
        if (argument === undefined) {
            this.outer.unsupported(at, `a \`${type.name}\` axis argument that is missing`);
            return undefined;
        }
        const axisType = this.linalgOf(this.outer.tryErase(argument));
        if (axisType === undefined || axisType.family !== "vec") {
            this.outer.unsupported(argument, "an axis that is not a vector");
            return undefined;
        }
        const value = this.value(argument, this.linalgStructOf(axisType));
        if (value === undefined) {
            return undefined;
        }
        const loaded = this.loadVector(at, value, axisType);
        if (loaded === undefined) {
            return undefined;
        }
        const vector = normalise ? this.normalize(at, loaded, axisType) : loaded;
        return axisType.components.map((_, lane) =>
            this.reread(this.laneOf(at, axisType, vector, lane)),
        );
    }

    /** Four scalar arguments, in order. */
    private scalars(
        at: ts.CallExpression,
        type: LinalgType,
        args: readonly ts.Expression[],
        count: number,
    ): Typed[] | undefined {
        const out: Typed[] = [];
        for (let index = 0; index < count; index += 1) {
            const operand = this.scalarArgument(at, type, args[index]);
            if (operand === undefined) {
                return undefined;
            }
            out.push({operand, type: this.componentType(type)});
        }
        return out;
    }

    /**
     * A right-handed view matrix.
     *
     * `f` looks from the eye towards the centre, `s` is the right-hand side and
     * `u` is the corrected up. The basis goes in as *rows*, because a view
     * matrix is the inverse of a rigid transform and the inverse of a rotation
     * is its transpose; the translation column is the negated dot of each basis
     * vector with the eye, which is that same inverse applied to the position.
     */
    private lookAt(
        expression: ts.CallExpression,
        type: LinalgType,
        column: LinalgType,
        args: readonly ts.Expression[],
    ): Typed | undefined {
        const vec3 = this.linalgOf(this.outer.tryErase(args[0] ?? expression));
        if (vec3 === undefined) {
            this.outer.unsupported(expression, "`lookAt` without vector arguments");
            return undefined;
        }
        const load = (index: number): LocalId | undefined => {
            const argument = args[index];
            if (argument === undefined) {
                this.outer.unsupported(expression, "`lookAt` with too few arguments");
                return undefined;
            }
            const value = this.value(argument, this.linalgStructOf(vec3));
            return value === undefined ? undefined : this.loadVector(expression, value, vec3);
        };
        const eye = load(0);
        const centre = load(1);
        const up = load(2);
        if (eye === undefined || centre === undefined || up === undefined) {
            return undefined;
        }

        const forward = this.normalize(
            expression,
            this.simdLocal(expression, vec3, {
                kind: "SimdBinary",
                op: "Sub",
                lhs: this.simdRead(centre),
                rhs: this.simdRead(eye),
            }),
            vec3,
        );
        const side = this.normalize(expression, this.cross(expression, forward, up, vec3), vec3);
        const upward = this.cross(expression, side, forward, vec3);

        const lane = (vector: LocalId, index: number): Typed =>
            this.reread(this.laneOf(expression, vec3, vector, index));
        const negate = (value: Typed): Typed => this.scalarNeg(expression, type, value);
        const dotWithEye = (vector: LocalId): Typed =>
            this.reread(this.dot(expression, vector, eye, vec3));

        const zero = this.scalarConst(expression, type, 0);
        const one = this.scalarConst(expression, type, 1);
        const columns = [
            [lane(side, 0), lane(upward, 0), negate(lane(forward, 0)), zero],
            [lane(side, 1), lane(upward, 1), negate(lane(forward, 1)), zero],
            [lane(side, 2), lane(upward, 2), negate(lane(forward, 2)), zero],
            [
                negate(dotWithEye(side)),
                negate(dotWithEye(upward)),
                dotWithEye(forward),
                one,
            ],
        ];
        return this.matrixValue(
            expression,
            type,
            columns.map((lanes) => this.vectorFromLanes(expression, column, lanes)),
        );
    }

    /**
     * A right-handed perspective projection with depth in `[0, 1]`.
     *
     * SDL3's GPU API on Vulkan, which is what DECISIONS §22 pinned: near maps
     * to 0, far to 1, and `+Y` stays up — so there is deliberately **no** Y
     * flip here, which a Vulkan-native projection would carry. Getting that
     * wrong produces a black screen and no diagnostic, which is why the
     * convention is written down rather than defaulted.
     */
    private perspective(
        expression: ts.CallExpression,
        type: LinalgType,
        column: LinalgType,
        args: readonly ts.Expression[],
    ): Typed | undefined {
        const values = this.scalars(expression, type, args, 4);
        if (values === undefined) {
            return undefined;
        }
        const [fovY, aspect, near, far] = values as [Typed, Typed, Typed, Typed];
        const two = this.scalarConst(expression, type, 2);
        const one = this.scalarConst(expression, type, 1);
        const zero = this.scalarConst(expression, type, 0);

        const half = this.scalarOp(expression, "Div", type, fovY, two);
        const tanHalf = this.mathCall(expression, type, "tan", half);
        if (tanHalf === undefined) {
            return undefined;
        }
        const tan = this.reread(tanHalf);

        // 1 / (aspect * tan(fovY/2)) and 1 / tan(fovY/2).
        const x = this.scalarOp(
            expression,
            "Div",
            type,
            one,
            this.scalarOp(expression, "Mul", type, aspect, this.reread(tan)),
        );
        const y = this.scalarOp(expression, "Div", type, this.scalarConst(expression, type, 1), tan);

        // far / (near - far), and -(far * near) / (far - near).
        const z = this.scalarOp(
            expression,
            "Div",
            type,
            this.reread(far),
            this.scalarOp(expression, "Sub", type, this.reread(near), this.reread(far)),
        );
        const w = this.scalarNeg(
            expression,
            type,
            this.scalarOp(
                expression,
                "Div",
                type,
                this.scalarOp(expression, "Mul", type, this.reread(far), this.reread(near)),
                this.scalarOp(expression, "Sub", type, this.reread(far), this.reread(near)),
            ),
        );

        const minusOne = this.scalarConst(expression, type, -1);
        return this.matrixValue(expression, type, [
            this.vectorFromLanes(expression, column, [x, zero, zero, zero]),
            this.vectorFromLanes(expression, column, [zero, y, zero, zero]),
            this.vectorFromLanes(expression, column, [zero, zero, z, minusOne]),
            this.vectorFromLanes(expression, column, [zero, zero, w, zero]),
        ]);
    }

    /** A right-handed orthographic projection with depth in `[0, 1]`. */
    private ortho(
        expression: ts.CallExpression,
        type: LinalgType,
        column: LinalgType,
        args: readonly ts.Expression[],
    ): Typed | undefined {
        const values = this.scalars(expression, type, args, 6);
        if (values === undefined) {
            return undefined;
        }
        const [left, right, bottom, top, near, far] = values as [
            Typed, Typed, Typed, Typed, Typed, Typed,
        ];
        const zero = this.scalarConst(expression, type, 0);
        const one = this.scalarConst(expression, type, 1);
        const two = this.scalarConst(expression, type, 2);

        const width = this.scalarOp(expression, "Sub", type, this.reread(right), this.reread(left));
        const height = this.scalarOp(expression, "Sub", type, this.reread(top), this.reread(bottom));
        const depth = this.scalarOp(expression, "Sub", type, this.reread(far), this.reread(near));

        const x = this.scalarOp(expression, "Div", type, two, this.reread(width));
        const y = this.scalarOp(
            expression,
            "Div",
            type,
            this.scalarConst(expression, type, 2),
            this.reread(height),
        );
        const z = this.scalarNeg(
            expression,
            type,
            this.scalarOp(expression, "Div", type, one, this.reread(depth)),
        );

        const tx = this.scalarNeg(
            expression,
            type,
            this.scalarOp(
                expression,
                "Div",
                type,
                this.scalarOp(expression, "Add", type, this.reread(right), this.reread(left)),
                this.reread(width),
            ),
        );
        const ty = this.scalarNeg(
            expression,
            type,
            this.scalarOp(
                expression,
                "Div",
                type,
                this.scalarOp(expression, "Add", type, this.reread(top), this.reread(bottom)),
                this.reread(height),
            ),
        );
        const tz = this.scalarNeg(
            expression,
            type,
            this.scalarOp(expression, "Div", type, this.reread(near), this.reread(depth)),
        );

        return this.matrixValue(expression, type, [
            this.vectorFromLanes(expression, column, [x, zero, zero, zero]),
            this.vectorFromLanes(expression, column, [zero, y, zero, zero]),
            this.vectorFromLanes(expression, column, [zero, zero, z, zero]),
            this.vectorFromLanes(expression, column, [tx, ty, tz, this.scalarConst(expression, type, 1)]),
        ]);
    }
}
