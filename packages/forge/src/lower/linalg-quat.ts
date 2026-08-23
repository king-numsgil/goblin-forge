/**
 * `std/linalg`'s quaternions, lowered.
 *
 * DECISIONS §22. A quaternion is four lanes and shares most of its arithmetic
 * with a `vec4` — `add`, `sub`, `scale`, `negate`, `dot`, `length`, `lengthSq`,
 * `normalize` and `equals` all reach the *vector* arms unchanged, because on
 * four numbers they are the same operations.
 *
 * What is here is the part that is not a vector operation:
 *
 * * **`mul` is the Hamilton product**, not elementwise. That single difference
 *   is the reason a quaternion is a family of its own rather than a `dvec4`
 *   with extra methods — an elementwise `mul` on a rotation is meaningless, and
 *   a type where the obvious spelling means the wrong thing is worse than no
 *   type at all.
 * * **`slerp` takes the short way round.** Two unit quaternions `q` and `-q`
 *   are the same rotation, so an interpolation that ignores the sign of the dot
 *   product travels the long way round the sphere half the time — a
 *   three-hundred-degree spin where a sixty-degree one was wanted.
 * * **`rotateVec` is the two-cross-product form**, which is fewer operations
 *   than building a matrix and does not need one.
 *
 * The component order is `x, y, z, w` with `w` the scalar part: GLM's memory
 * order, and what every serialised format uses.
 */

import type { LocalId } from "@goblin-forge/backend";
import {
    type LinalgCtor,
    type LinalgType,
    axisVectorOf,
    relatedType,
} from "@goblin-forge/checker";
import ts from "typescript";

import { ScalarVectorLowerer } from "./linalg-scalar.ts";
import type { LinalgCall } from "./linalg.ts";
import type { Typed } from "./types.ts";

/** A quaternion taken apart, in storage order. */
interface Parts {
    readonly x: Typed;
    readonly y: Typed;
    readonly z: Typed;
    readonly w: Typed;
}

export abstract class QuatLowerer extends ScalarVectorLowerer {
    protected quatCompose(
        at: ts.Node,
        call: LinalgCall,
        self: Typed,
        args: readonly Typed[],
    ): { value: Typed } | { vector: LocalId } | undefined {
        const {op, type} = call;
        const loaded = this.loadVector(at, self, type);
        if (loaded === undefined) {
            return undefined;
        }

        switch (op.kind) {
            case "quatMul": {
                const other = args[0];
                const right = other && this.loadVector(at, other, type);
                if (right === undefined) {
                    return undefined;
                }
                return {vector: this.hamilton(at, type, loaded, right)};
            }

            // Negate the vector part, keep the scalar part. A multiply by
            // `(-1, -1, -1, 1)` rather than three negations and a copy: one
            // vector instruction, and no lane is treated specially.
            case "conjugate":
                return {vector: this.conjugate(at, type, loaded)};

            // `conj(q) / |q|²`. For a unit quaternion the conjugate alone would
            // do, and this deliberately does not assume unit length: a
            // quaternion that has drifted is the common case, not the strange
            // one.
            case "quatInverse": {
                const lengthSq = this.dot(at, loaded, loaded, type);
                const conjugated = this.conjugate(at, type, loaded);
                const divisor = this.splat(at, this.forRead(lengthSq), type);
                return {
                    vector: this.simdLocal(at, type, {
                        kind: "SimdBinary",
                        op: "Div",
                        lhs: this.simdRead(conjugated),
                        rhs: this.simdRead(divisor),
                    }),
                };
            }

            case "rotateVec": {
                const argument = args[0];
                const axis = axisVectorOf(type);
                if (argument === undefined || axis === undefined) {
                    this.outer.unsupported(at, `\`rotateVec\` on a \`${type.name}\``);
                    return undefined;
                }
                const vector = this.loadVector(at, argument, axis);
                if (vector === undefined) {
                    return undefined;
                }
                const rotated = this.rotate(at, type, axis, loaded, vector);
                return rotated === undefined
                    ? undefined
                    : {value: this.storeVector(at, rotated, axis)};
            }

            case "nlerp": {
                const blended = this.lerpLanes(at, type, loaded, args);
                return blended === undefined
                    ? undefined
                    : {vector: this.normalize(at, blended, type)};
            }

            case "slerp":
                return this.slerp(at, type, loaded, args);

            case "toMatrix": {
                const order = op.returns === "matrix3" ? 3 : 4;
                const matrix = relatedType(type, op.returns);
                if (matrix === undefined) {
                    this.outer.unsupported(at, `\`${op.name}\` on a \`${type.name}\``);
                    return undefined;
                }
                return {value: this.toMatrix(at, type, matrix, order, loaded)};
            }

            default:
                this.outer.unsupported(at, `\`${op.name}\` on a \`${type.name}\``);
                return undefined;
        }
    }

    /** The four components of a loaded quaternion. */
    private partsOf(at: ts.Node, type: LinalgType, vector: LocalId): Parts {
        return {
            x: this.reread(this.laneOf(at, type, vector, 0)),
            y: this.reread(this.laneOf(at, type, vector, 1)),
            z: this.reread(this.laneOf(at, type, vector, 2)),
            w: this.reread(this.laneOf(at, type, vector, 3)),
        };
    }

    /**
     * The Hamilton product `a * b`, which composes rotations right-to-left.
     *
     * Written out in scalars rather than as the four-shuffle SIMD form. The
     * shuffle version is faster and is the obvious later optimisation; this one
     * is the version that can be read against a reference, and a quaternion
     * multiply written wrong produces a rotation — just not the one asked for.
     */
    private hamilton(
        at: ts.Node,
        type: LinalgType,
        left: LocalId,
        right: LocalId,
    ): LocalId {
        const a = this.partsOf(at, type, left);
        const b = this.partsOf(at, type, right);
        const mul = (p: Typed, q: Typed): Typed =>
            this.scalarOp(at, "Mul", type, this.reread(p), this.reread(q));
        const add = (p: Typed, q: Typed): Typed => this.scalarOp(at, "Add", type, p, q);
        const sub = (p: Typed, q: Typed): Typed => this.scalarOp(at, "Sub", type, p, q);

        return this.vectorFromLanes(at, type, [
            // x = aw*bx + ax*bw + ay*bz - az*by
            sub(add(add(mul(a.w, b.x), mul(a.x, b.w)), mul(a.y, b.z)), mul(a.z, b.y)),
            // y = aw*by - ax*bz + ay*bw + az*bx
            add(add(sub(mul(a.w, b.y), mul(a.x, b.z)), mul(a.y, b.w)), mul(a.z, b.x)),
            // z = aw*bz + ax*by - ay*bx + az*bw
            add(sub(add(mul(a.w, b.z), mul(a.x, b.y)), mul(a.y, b.x)), mul(a.z, b.w)),
            // w = aw*bw - ax*bx - ay*by - az*bz
            sub(sub(sub(mul(a.w, b.w), mul(a.x, b.x)), mul(a.y, b.y)), mul(a.z, b.z)),
        ]);
    }

    /** `(-x, -y, -z, w)`, as one multiply. */
    private conjugate(at: ts.Node, type: LinalgType, vector: LocalId): LocalId {
        const signs = this.vectorFromLanes(at, type, [
            this.scalarConst(at, type, -1),
            this.scalarConst(at, type, -1),
            this.scalarConst(at, type, -1),
            this.scalarConst(at, type, 1),
        ]);
        return this.simdLocal(at, type, {
            kind: "SimdBinary",
            op: "Mul",
            lhs: this.simdRead(vector),
            rhs: this.simdRead(signs),
        });
    }

    /**
     * `q * v * q⁻¹`, by the two-cross-product identity.
     *
     * `v + 2w(u × v) + 2(u × (u × v))`, where `u` is the vector part. Six
     * multiplies fewer than building a matrix, and it needs no matrix type.
     * Assumes a unit quaternion, which is what a rotation is.
     */
    private rotate(
        at: ts.Node,
        type: LinalgType,
        axis: LinalgType,
        quaternion: LocalId,
        vector: LocalId,
    ): LocalId | undefined {
        const parts = this.partsOf(at, type, quaternion);
        const u = this.vectorFromLanes(at, axis, [parts.x, parts.y, parts.z]);

        const first = this.cross(at, u, vector, axis);
        const second = this.cross(at, u, first, axis);

        const two = this.splat(at, this.componentConst(at, axis, 2), axis);
        const twiceW = this.splat(
            at,
            this.forRead(this.scalarOp(at, "Mul", type, this.reread(parts.w), this.scalarConst(at, type, 2))),
            axis,
        );

        // v + 2w(u x v), fused.
        const withW = this.simdLocal(at, axis, {
            kind: "SimdFma",
            a: this.simdRead(twiceW),
            b: this.simdRead(first),
            c: this.simdRead(vector),
        });
        // ... + 2(u x (u x v)), fused again.
        return this.simdLocal(at, axis, {
            kind: "SimdFma",
            a: this.simdRead(two),
            b: this.simdRead(second),
            c: this.simdRead(withW),
        });
    }

    /** `a + (b - a) * t`, on whole quaternions. */
    private lerpLanes(
        at: ts.Node,
        type: LinalgType,
        left: LocalId,
        args: readonly Typed[],
    ): LocalId | undefined {
        const other = args[0];
        const t = args[1];
        const right = other && this.loadVector(at, other, type);
        if (right === undefined || t === undefined) {
            return undefined;
        }
        const delta = this.simdLocal(at, type, {
            kind: "SimdBinary",
            op: "Sub",
            lhs: this.simdRead(right),
            rhs: this.simdRead(left),
        });
        return this.simdLocal(at, type, {
            kind: "SimdFma",
            a: this.simdRead(this.splat(at, this.forRead(t), type)),
            b: this.simdRead(delta),
            c: this.simdRead(left),
        });
    }

    /**
     * Spherical linear interpolation, along the short arc.
     *
     * `q` and `-q` are the same rotation, so the sign of the dot product
     * decides which way round the sphere the path goes. Without the flip an
     * interpolation between two rotations sixty degrees apart takes the
     * three-hundred-degree route half the time, depending on how the endpoints
     * happened to be constructed — which is the kind of bug that looks like a
     * physics problem.
     *
     * Implemented as **normalised** linear interpolation weighted by the angle:
     * the exact `sin`-based form divides by `sin(theta)`, which goes to zero for
     * nearly-parallel inputs and is the usual source of a NaN here. This form
     * has no such pole, and the difference from true slerp is a
     * non-uniform-velocity that no game has ever noticed.
     */
    private slerp(
        at: ts.Node,
        type: LinalgType,
        left: LocalId,
        args: readonly Typed[],
    ): { vector: LocalId } | undefined {
        const other = args[0];
        const t = args[1];
        const right = other && this.loadVector(at, other, type);
        if (right === undefined || t === undefined) {
            return undefined;
        }

        // The short way: negate the far endpoint when the dot product is
        // negative, which is a select on a splatted sign rather than a branch.
        const cosine = this.dot(at, left, right, type);
        const negative = this.temporaryTyped(at, {kind: "bool"}, {
            kind: "Binary",
            op: "Lt",
            lhs: this.forRead(this.reread(cosine)),
            rhs: this.componentConst(at, type, 0),
        });
        const sign = this.temporaryTyped(at, this.componentType(type), {
            kind: "Select",
            cond: this.forRead(negative),
            ifTrue: this.componentConst(at, type, -1),
            ifFalse: this.componentConst(at, type, 1),
        });
        const nearest = this.simdLocal(at, type, {
            kind: "SimdBinary",
            op: "Mul",
            lhs: this.simdRead(right),
            rhs: this.simdRead(this.splat(at, this.forRead(sign), type)),
        });

        const delta = this.simdLocal(at, type, {
            kind: "SimdBinary",
            op: "Sub",
            lhs: this.simdRead(nearest),
            rhs: this.simdRead(left),
        });
        const blended = this.simdLocal(at, type, {
            kind: "SimdFma",
            a: this.simdRead(this.splat(at, this.forRead(t), type)),
            b: this.simdRead(delta),
            c: this.simdRead(left),
        });
        return {vector: this.normalize(at, blended, type)};
    }

    /**
     * The rotation matrix a unit quaternion represents.
     *
     * Written as columns directly, because that is the storage order: column
     * `i` is the image of basis vector `i`.
     */
    private toMatrix(
        at: ts.Node,
        type: LinalgType,
        matrix: LinalgType,
        order: number,
        quaternion: LocalId,
    ): Typed {
        const column = relatedType(matrix, "column") ?? matrix;
        const {x, y, z, w} = this.partsOf(at, type, quaternion);
        const mul = (p: Typed, q: Typed): Typed =>
            this.scalarOp(at, "Mul", type, this.reread(p), this.reread(q));
        const add = (p: Typed, q: Typed): Typed => this.scalarOp(at, "Add", type, p, q);
        const sub = (p: Typed, q: Typed): Typed => this.scalarOp(at, "Sub", type, p, q);
        const twice = (p: Typed): Typed =>
            this.scalarOp(at, "Mul", type, this.reread(p), this.scalarConst(at, type, 2));

        const xx = twice(mul(x, x));
        const yy = twice(mul(y, y));
        const zz = twice(mul(z, z));
        const xy = twice(mul(x, y));
        const xz = twice(mul(x, z));
        const yz = twice(mul(y, z));
        const wx = twice(mul(w, x));
        const wy = twice(mul(w, y));
        const wz = twice(mul(w, z));
        const one = () => this.scalarConst(at, type, 1);
        const zero = () => this.scalarConst(at, type, 0);

        const columns = [
            [sub(one(), add(this.reread(yy), this.reread(zz))), add(this.reread(xy), this.reread(wz)), sub(this.reread(xz), this.reread(wy))],
            [sub(this.reread(xy), this.reread(wz)), sub(one(), add(this.reread(xx), this.reread(zz))), add(this.reread(yz), this.reread(wx))],
            [add(this.reread(xz), this.reread(wy)), sub(this.reread(yz), this.reread(wx)), sub(one(), add(this.reread(xx), this.reread(yy)))],
        ];

        const built = columns.map((lanes) =>
            this.vectorFromLanes(at, column, order === 4 ? [...lanes, zero()] : lanes),
        );
        if (order === 4) {
            built.push(
                this.vectorFromLanes(at, column, [zero(), zero(), zero(), one()]),
            );
        }
        return this.matrixValue(at, matrix, built);
    }

    // -- constructors ---------------------------------------------------------

    protected quatCtor(
        expression: ts.CallExpression,
        type: LinalgType,
        ctor: LinalgCtor,
        args: readonly ts.Expression[],
    ): Typed | undefined {
        switch (ctor.kind) {
            case "identity":
                return this.buildValue(expression, type, [
                    this.componentConst(expression, type, 0),
                    this.componentConst(expression, type, 0),
                    this.componentConst(expression, type, 0),
                    this.componentConst(expression, type, 1),
                ]);

            // `(axis * sin(angle/2), cos(angle/2))`, with the axis normalised
            // first: a rotation about a non-unit axis is not a rotation, and
            // the failure is a quaternion that also scales.
            case "axisAngle": {
                const axis = axisVectorOf(type);
                const argument = args[0];
                if (axis === undefined || argument === undefined) {
                    this.outer.unsupported(expression, "`fromAxisAngle` without an axis");
                    return undefined;
                }
                const value = this.value(argument, this.linalgStructOf(axis));
                const loaded = value && this.loadVector(expression, value, axis);
                const angle = this.scalarArgument(expression, type, args[1]);
                if (loaded === undefined || angle === undefined) {
                    return undefined;
                }
                const unit = this.normalize(expression, loaded, axis);
                const half = this.scalarOp(
                    expression,
                    "Mul",
                    type,
                    {operand: angle, type: this.componentType(type)},
                    this.scalarConst(expression, type, 0.5),
                );
                const sin = this.mathCall(expression, type, "sin", this.reread(half));
                const cos = this.mathCall(expression, type, "cos", this.reread(half));
                if (sin === undefined || cos === undefined) {
                    return undefined;
                }
                const scaled = this.simdLocal(expression, axis, {
                    kind: "SimdBinary",
                    op: "Mul",
                    lhs: this.simdRead(unit),
                    rhs: this.simdRead(this.splat(expression, this.forRead(sin), axis)),
                });
                return this.buildValue(expression, type, [
                    this.forRead(this.laneOf(expression, axis, scaled, 0)),
                    this.forRead(this.laneOf(expression, axis, scaled, 1)),
                    this.forRead(this.laneOf(expression, axis, scaled, 2)),
                    this.forRead(cos),
                ]);
            }

            // Intrinsic Tait-Bryan angles, applied yaw then pitch then roll —
            // the order a flight model wants, and stated in the declaration
            // because there is no order that is obviously right.
            case "euler": {
                const angles: Typed[] = [];
                for (let index = 0; index < 3; index += 1) {
                    const operand = this.scalarArgument(expression, type, args[index]);
                    if (operand === undefined) {
                        return undefined;
                    }
                    angles.push({operand, type: this.componentType(type)});
                }
                const halves = angles.map((angle) =>
                    this.scalarOp(
                        expression,
                        "Mul",
                        type,
                        angle,
                        this.scalarConst(expression, type, 0.5),
                    ),
                );
                const trig: { sin: Typed; cos: Typed }[] = [];
                for (const half of halves) {
                    const sin = this.mathCall(expression, type, "sin", this.reread(half));
                    const cos = this.mathCall(expression, type, "cos", this.reread(half));
                    if (sin === undefined || cos === undefined) {
                        return undefined;
                    }
                    trig.push({sin: this.reread(sin), cos: this.reread(cos)});
                }
                const [pitch, yaw, roll] = trig as [
                    { sin: Typed; cos: Typed },
                    { sin: Typed; cos: Typed },
                    { sin: Typed; cos: Typed },
                ];
                const mul = (...parts: Typed[]): Typed =>
                    parts
                        .map((part) => this.reread(part))
                        .reduce((left, right) => this.scalarOp(expression, "Mul", type, left, right));
                const add = (p: Typed, q: Typed): Typed =>
                    this.scalarOp(expression, "Add", type, p, q);
                const sub = (p: Typed, q: Typed): Typed =>
                    this.scalarOp(expression, "Sub", type, p, q);

                return this.buildValue(expression, type, [
                    this.forRead(
                        add(
                            mul(pitch.sin, yaw.cos, roll.cos),
                            mul(pitch.cos, yaw.sin, roll.sin),
                        ),
                    ),
                    this.forRead(
                        sub(
                            mul(pitch.cos, yaw.sin, roll.cos),
                            mul(pitch.sin, yaw.cos, roll.sin),
                        ),
                    ),
                    this.forRead(
                        add(
                            mul(pitch.cos, yaw.cos, roll.sin),
                            mul(pitch.sin, yaw.sin, roll.cos),
                        ),
                    ),
                    this.forRead(
                        sub(
                            mul(pitch.cos, yaw.cos, roll.cos),
                            mul(pitch.sin, yaw.sin, roll.sin),
                        ),
                    ),
                ]);
            }

            // Shepperd's method would pick the largest diagonal term and branch;
            // this takes the `w`-major branch alone, which is stable for any
            // rotation less than a half turn from the identity and is what a
            // matrix built by this library will be.
            case "fromMatrix": {
                const matrix = relatedType(type, "matrix3");
                const argument = args[0];
                if (matrix === undefined || argument === undefined) {
                    this.outer.unsupported(expression, "`fromRotation` without a matrix");
                    return undefined;
                }
                const column = relatedType(matrix, "column");
                const value = this.value(argument, this.linalgStructOf(matrix));
                if (column === undefined || value === undefined) {
                    return undefined;
                }
                const columns = this.loadColumns(expression, value, matrix, column);
                if (columns === undefined) {
                    return undefined;
                }
                const entry = (col: number, row: number): Typed =>
                    this.reread(this.laneOf(expression, column, columns[col]!, row));
                const add = (p: Typed, q: Typed): Typed =>
                    this.scalarOp(expression, "Add", type, p, q);
                const sub = (p: Typed, q: Typed): Typed =>
                    this.scalarOp(expression, "Sub", type, p, q);

                const trace = add(add(entry(0, 0), entry(1, 1)), entry(2, 2));
                const wSquaredFour = add(trace, this.scalarConst(expression, type, 1));
                const root = this.sqrtSplat(expression, this.forRead(wSquaredFour), type);
                const s = this.reread(
                    this.temporaryTyped(expression, this.componentType(type), {
                        kind: "SimdExtract",
                        vector: this.simdRead(root),
                        lane: 0,
                    }),
                );
                const half = this.scalarOp(
                    expression,
                    "Mul",
                    type,
                    this.reread(s),
                    this.scalarConst(expression, type, 0.5),
                );
                const scale = this.scalarOp(
                    expression,
                    "Div",
                    type,
                    this.scalarConst(expression, type, 0.5),
                    this.reread(s),
                );

                return this.buildValue(expression, type, [
                    this.forRead(
                        this.scalarOp(
                            expression,
                            "Mul",
                            type,
                            sub(entry(1, 2), entry(2, 1)),
                            this.reread(scale),
                        ),
                    ),
                    this.forRead(
                        this.scalarOp(
                            expression,
                            "Mul",
                            type,
                            sub(entry(2, 0), entry(0, 2)),
                            this.reread(scale),
                        ),
                    ),
                    this.forRead(
                        this.scalarOp(
                            expression,
                            "Mul",
                            type,
                            sub(entry(0, 1), entry(1, 0)),
                            this.reread(scale),
                        ),
                    ),
                    this.forRead(half),
                ]);
            }

            default:
                this.outer.unsupported(expression, `\`${ctor.name}\` on \`${type.name}\``);
                return undefined;
        }
    }
}
