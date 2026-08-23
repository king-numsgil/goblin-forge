/**
 * `std/linalg`'s integer and boolean vectors, and every comparison.
 *
 * DECISIONS §22. **Nothing here touches the vector unit.** AVX2 has no 64-bit
 * integer multiply and no integer division at all, so a vectorised `lvec` would
 * be part vectorised and part not — a performance cliff nothing in the type
 * admits to. Doing all of them scalar means one lowering rule, and integer
 * vectors are for indices and counts rather than for hot arithmetic.
 *
 * So an `ivec3` is three `i32` in a struct and `a.add(b)` is three `add i32`
 * against three field projections. There is no `SimdLoad`, no lane, and no
 * padded form to want — padding exists to fill a register, and none of these
 * ever reaches one.
 *
 * **Comparisons live here too, for both element families.** A comparison
 * produces a `bvec` — a struct of one-byte booleans — rather than a mask, and
 * §22 keeps masks out of the MIR entirely: they would be a second
 * representation of a boolean, live only inside vector expressions, and need a
 * conversion at every boundary. So `dvec3.lessThan` is three `fcmp` and three
 * stores, exactly as `ivec3.lessThan` is three `icmp`, and the two paths are
 * one path.
 */

import { FieldId, type Operand } from "@goblin-forge/backend";
import {
    type LinalgOp,
    type LinalgType,
    type MachineType,
    relatedType,
} from "@goblin-forge/checker";
import ts from "typescript";

import { MatrixLowerer } from "./linalg-matrix.ts";
import type { LinalgCall } from "./linalg.ts";
import type { Typed } from "./types.ts";

export abstract class ScalarVectorLowerer extends MatrixLowerer {
    /**
     * One component of a linear-algebra value, by field projection.
     *
     * The scalar counterpart of a lane read: for a type with no vector form
     * there is nothing to extract *from*, so the component is reached where it
     * lives.
     */
    protected componentOf(
        at: ts.Node,
        subject: Typed,
        type: LinalgType,
        index: number,
    ): Typed | undefined {
        const place = this.linalgPlace(at, subject);
        if (place === undefined) {
            return undefined;
        }
        return {
            operand: {
                kind: "Copy",
                value: {
                    ...place,
                    projection: [...place.projection, {kind: "Field", value: FieldId(index)}],
                },
            },
            type: this.componentType(type),
        };
    }

    /** Every component of a value, in order. */
    protected componentsOf(
        at: ts.Node,
        subject: Typed,
        type: LinalgType,
    ): Typed[] | undefined {
        const out: Typed[] = [];
        for (let index = 0; index < type.components.length; index += 1) {
            const component = this.componentOf(at, subject, type, index);
            if (component === undefined) {
                return undefined;
            }
            out.push(component);
        }
        return out;
    }

    /**
     * A component-wise comparison, producing a `bvec`.
     *
     * Works for every element type, because it never reads a lane: the operands
     * are components wherever they live — extracted from a vector for a `dvec3`,
     * projected from a field for an `ivec3` — and the result is an aggregate of
     * `bool`.
     */
    protected compareComponents(
        at: ts.Node,
        op: Extract<LinalgOp, { kind: "compare" }>,
        type: LinalgType,
        left: readonly Typed[],
        right: readonly Typed[],
    ): Typed | undefined {
        const result = relatedType(type, "boolVector");
        if (result === undefined) {
            this.outer.unsupported(at, `a comparison on \`${type.name}\``);
            return undefined;
        }
        const bool: MachineType = {kind: "bool"};
        const flags = left.map((component, index) =>
            this.forRead(
                this.temporaryTyped(at, bool, {
                    kind: "Binary",
                    op: op.op,
                    lhs: this.forRead(component),
                    rhs: this.forRead(right[index]!),
                }),
            ),
        );
        return this.buildValue(at, result, flags);
    }

    /**
     * Every operation on a type with no vector form.
     *
     * Deliberately a smaller set than the float path: no `length`, no
     * `normalize`, no `lerp`. Each of those is a question about a square root
     * or a fractional part, and an integer answer to either is a different
     * type wearing this one's name.
     */
    protected scalarCompose(
        at: ts.Node,
        call: LinalgCall,
        self: Typed,
        args: readonly Typed[],
    ): { value: Typed } | undefined {
        const {op, type} = call;
        const left = this.componentsOf(at, self, type);
        if (left === undefined) {
            return undefined;
        }

        const rightOf = (index: number): Typed[] | undefined => {
            const argument = args[index];
            return argument === undefined
                ? undefined
                : this.componentsOf(at, argument, type);
        };

        switch (op.kind) {
            // `Min` and `Max` are the one place integers cost more than floats:
            // there is no integer `llvm.minnum`, so each is a compare and a
            // select. Everything else is one instruction per component.
            case "elementwise": {
                const right = rightOf(0);
                if (right === undefined) {
                    return undefined;
                }
                if (op.op === "Min" || op.op === "Max") {
                    return {
                        value: this.buildValue(
                            at,
                            type,
                            left.map((a, index) =>
                                this.pick(at, type, op.op === "Min" ? "Lt" : "Gt", a, right[index]!),
                            ),
                        ),
                    };
                }
                return {
                    value: this.buildValue(
                        at,
                        type,
                        left.map((a, index) =>
                            this.forRead(this.scalarBinary(at, type, op.op, a, right[index]!)),
                        ),
                    ),
                };
            }

            case "bitwise": {
                const right = rightOf(0);
                if (right === undefined) {
                    return undefined;
                }
                return {
                    value: this.buildValue(
                        at,
                        type,
                        left.map((a, index) =>
                            this.forRead(this.scalarBinary(at, type, op.op, a, right[index]!)),
                        ),
                    ),
                };
            }

            case "scaled": {
                const scalar = args[0];
                if (scalar === undefined) {
                    return undefined;
                }
                const factor = this.repeatable(scalar);
                return {
                    value: this.buildValue(
                        at,
                        type,
                        left.map((a) =>
                            this.forRead(
                                this.scalarBinary(at, type, op.op, a, {
                                    operand: factor,
                                    type: this.componentType(type),
                                }),
                            ),
                        ),
                    ),
                };
            }

            // `not` on a boolean is logical, not two's-complement: `bvec`'s
            // components are one byte holding 0 or 1, and a bitwise complement
            // of 1 is 254, which is true and is not what anyone means. The
            // table spells it `Neg` for lack of a better name in a union shared
            // with the float unary operations; the meaning is decided here.
            case "unary": {
                if (type.element === "bool") {
                    return {
                        value: this.buildValue(
                            at,
                            type,
                            left.map((a) =>
                                this.forRead(
                                    this.temporaryTyped(at, {kind: "bool"}, {
                                        kind: "Unary",
                                        op: "Not",
                                        operand: this.forRead(a),
                                    }),
                                ),
                            ),
                        ),
                    };
                }
                if (op.op === "Neg") {
                    return {
                        value: this.buildValue(
                            at,
                            type,
                            left.map((a) =>
                                this.forRead(
                                    this.temporaryTyped(at, this.componentType(type), {
                                        kind: "Unary",
                                        op: "Neg",
                                        operand: this.forRead(a),
                                    }),
                                ),
                            ),
                        ),
                    };
                }
                // `abs` is `max(a, -a)` — a compare and a select against the
                // negation. There is no integer `llvm.fabs`, and the branchless
                // form is what the hardware does anyway.
                //
                // `Gt`, not `Lt`: picking the *smaller* of a value and its
                // negation is the negative one every time, which is a sign flip
                // wearing an absolute value's name.
                if (op.op === "Abs") {
                    return {
                        value: this.buildValue(
                            at,
                            type,
                            left.map((a) => {
                                const negated = this.temporaryTyped(
                                    at,
                                    this.componentType(type),
                                    {kind: "Unary", op: "Neg", operand: this.forRead(this.reread(a))},
                                );
                                return this.pick(at, type, "Gt", this.reread(a), negated);
                            }),
                        ),
                    };
                }
                this.outer.unsupported(at, `\`${op.name}\` on a \`${type.name}\``);
                return undefined;
            }

            case "compare": {
                const right = rightOf(0);
                if (right === undefined) {
                    return undefined;
                }
                const compared = this.compareComponents(at, op, type, left, right);
                return compared === undefined ? undefined : {value: compared};
            }

            case "clamp": {
                const low = rightOf(0);
                const high = rightOf(1);
                if (low === undefined || high === undefined) {
                    return undefined;
                }
                return {
                    value: this.buildValue(
                        at,
                        type,
                        left.map((a, index) => {
                            const lifted = this.pickOperand(
                                at,
                                type,
                                "Gt",
                                a,
                                low[index]!,
                            );
                            return this.pick(at, type, "Lt", lifted, high[index]!);
                        }),
                    ),
                };
            }

            case "dot":
            case "lengthSq": {
                const right = op.kind === "dot" ? rightOf(0) : left.map((a) => this.reread(a));
                if (right === undefined) {
                    return undefined;
                }
                const source = op.kind === "dot" ? left : left.map((a) => this.reread(a));
                let total: Typed | undefined;
                for (const [index, a] of source.entries()) {
                    const term = this.scalarBinary(at, type, "Mul", a, right[index]!);
                    total =
                        total === undefined
                            ? term
                            : this.scalarBinary(at, type, "Add", total, term);
                }
                return total === undefined ? undefined : {value: total};
            }

            case "equals": {
                const right = rightOf(0);
                if (right === undefined) {
                    return undefined;
                }
                return {value: this.andAll(at, left, right, "Eq")};
            }

            // `any` and `all` reduce a `bvec` the two ways there are: an `or`
            // chain and an `and` chain. Neither short-circuits, because every
            // component has already been computed and a branch would cost more
            // than the operation it skipped.
            case "anyOf":
            case "allOf": {
                const bool: MachineType = {kind: "bool"};
                let total: Typed | undefined;
                for (const component of left) {
                    total =
                        total === undefined
                            ? component
                            : this.temporaryTyped(at, bool, {
                                kind: "Binary",
                                op: op.kind === "anyOf" ? "BitOr" : "BitAnd",
                                lhs: this.forRead(total),
                                rhs: this.forRead(component),
                            });
                }
                return total === undefined ? undefined : {value: total};
            }

            default:
                this.outer.unsupported(at, `\`${op.name}\` on a \`${type.name}\``);
                return undefined;
        }
    }

    /** One scalar binary operation between two components. */
    private scalarBinary(
        at: ts.Node,
        type: LinalgType,
        op: string,
        lhs: Typed,
        rhs: Typed,
    ): Typed {
        return this.temporaryTyped(at, this.componentType(type), {
            kind: "Binary",
            // The table's op names are the MIR's own, checked against a closed
            // union at the table rather than here.
            op: op as never,
            lhs: this.forRead(lhs),
            rhs: this.forRead(rhs),
        });
    }

    /** `a <op> b ? a : b`, branchless. */
    private pickOperand(
        at: ts.Node,
        type: LinalgType,
        op: "Lt" | "Gt",
        a: Typed,
        b: Typed,
    ): Typed {
        const left = this.reread(a);
        const right = this.reread(b);
        const cond = this.temporaryTyped(at, {kind: "bool"}, {
            kind: "Binary",
            op,
            lhs: this.forRead(this.reread(a)),
            rhs: this.forRead(this.reread(b)),
        });
        return this.temporaryTyped(at, this.componentType(type), {
            kind: "Select",
            cond: this.forRead(cond),
            ifTrue: this.forRead(left),
            ifFalse: this.forRead(right),
        });
    }

    /** {@link pickOperand}, as an operand ready to be stored. */
    private pick(
        at: ts.Node,
        type: LinalgType,
        op: "Lt" | "Gt",
        a: Typed,
        b: Typed,
    ): Operand {
        return this.forRead(this.pickOperand(at, type, op, a, b));
    }

    /** `a[0] <op> b[0] && a[1] <op> b[1] && …`, without the short-circuit. */
    private andAll(
        at: ts.Node,
        left: readonly Typed[],
        right: readonly Typed[],
        op: "Eq",
    ): Typed {
        const bool: MachineType = {kind: "bool"};
        let all: Typed | undefined;
        for (const [index, component] of left.entries()) {
            const same = this.temporaryTyped(at, bool, {
                kind: "Binary",
                op,
                lhs: this.forRead(component),
                rhs: this.forRead(right[index]!),
            });
            all =
                all === undefined
                    ? same
                    : this.temporaryTyped(at, bool, {
                        kind: "Binary",
                        op: "BitAnd",
                        lhs: this.forRead(all),
                        rhs: this.forRead(same),
                    });
        }
        return all ?? this.temporaryTyped(at, bool, {kind: "Default"});
    }
}
