/**
 * `std/linalg`, lowered.
 *
 * DECISIONS §22. **Every algorithm lives here**, not in the backend. `dot` is a
 * multiply, three lane reads and two adds emitted by this file; the backend
 * receives primitives and selects an instruction for each by lookup. So adding
 * `slerp` is a case in {@link LinalgLowerer.compose} and a row in the table,
 * and it is never a change to `crates/goblin-codegen`.
 *
 * Two things shape everything below.
 *
 * **A `dvec3` is a struct, and only a struct.** Its storage is three `f64`,
 * which is what an array of them holds, what `sizeOf` reports and what crosses
 * the C boundary. The vector form exists between the `SimdLoad` that reads one
 * and the `SimdStore` that writes it back, and nothing else in the compiler
 * knows it exists.
 *
 * **The lane count is the true one.** A packed `dvec3` is three lanes and a
 * padded `aligned_dvec3` is four, so a reduction over a padded type must skip
 * the lane that means nothing. That is done by reading only the *component*
 * lanes — {@link LinalgLowerer.reduce} — rather than by maintaining "the pad is
 * always zero", which `div` breaks: zero over zero is a NaN, and a NaN in an
 * ignored lane poisons the next `dot` that reads it.
 */

import {
    FieldId,
    type LocalId,
    type Operand,
    type Place,
    type Rvalue,
    type SimdBinOp,
    type TyId,
} from "@goblin-forge/backend";
import {
    columnTypeOf,
    type LinalgCtor,
    type LinalgOp,
    type LinalgType,
    type MachineType,
    linalgCtorOf,
    linalgFromMachine,
    linalgMethodOf,
    linalgNamedBy,
    linalgStruct,
    relatedType,
} from "@goblin-forge/checker";
import ts from "typescript";

import { IntrinsicLowerer } from "./intrinsics.ts";
import type { Typed } from "./types.ts";
import { placeOf } from "./util.ts";

/**
 * The operation kinds a quaternion does *not* share with a vector.
 *
 * Everything outside this set — `add`, `scale`, `dot`, `normalize`, `equals` —
 * is the vector operation of the same name on the same four lanes, and reaches
 * the same arm. Only these seven need arithmetic of their own, and `mul` is the
 * one that would be silently wrong if it did not: an elementwise product of two
 * rotations is not a rotation.
 */
const QUAT_ONLY_KINDS: ReadonlySet<string> = new Set([
    "quatMul",
    "conjugate",
    "quatInverse",
    "rotateVec",
    "slerp",
    "nlerp",
    "toMatrix",
]);

/** An operation, and which of its three spellings was written. */
export interface LinalgCall {
    readonly op: LinalgOp;
    readonly type: LinalgType;
    /** `a.addMut(b)` — writes through the receiver and hands back a reference. */
    readonly mutating: boolean;
}

export abstract class LinalgLowerer extends IntrinsicLowerer {
    /** The linear-algebra type a value has, through a reference if need be. */
    protected linalgOf(type: MachineType | undefined): LinalgType | undefined {
        return linalgFromMachine(type);
    }

    /** The linear-algebra type an expression *names*, as opposed to holds. */
    protected linalgNamed(expression: ts.Expression): LinalgType | undefined {
        return linalgNamedBy(this.outer.checker, expression);
    }

    /** The operation a method name names, or `undefined` when it names none. */
    protected linalgMethod(name: string, type: LinalgType): LinalgCall | undefined {
        const found = linalgMethodOf(name, type);
        return found === undefined
            ? undefined
            : {op: found.op, type, mutating: found.mutating};
    }

    /** The MIR type of this vector's arithmetic form. */
    protected simdTy(type: LinalgType): TyId {
        return this.outer.simdTy(type.element === "f32" ? "F32" : "F64", type.fields.length);
    }

    /** The struct a linear-algebra value actually is. */
    protected linalgStructOf(type: LinalgType): MachineType {
        return linalgStruct(type);
    }

    /** The scalar one component is. */
    protected componentType(type: LinalgType): MachineType {
        return type.element === "bool"
            ? {kind: "bool"}
            : {kind: "scalar", name: type.element};
    }

    /**
     * A vector-typed local holding `rvalue`.
     *
     * Not registered as a temporary: a vector is lanes of float, so its
     * category is `Trivial` and drop elaboration would insert nothing for it
     * anyway. Registering one would put a `Drop` in every MIR dump of every
     * vector expression, saying nothing.
     */
    protected simdLocal(at: ts.Node, type: LinalgType, rvalue: Rvalue): LocalId {
        const local = this.f.addLocal({
            ty: this.simdTy(type),
            storage: "Owned",
            span: this.outer.span(at),
        });
        this.push({kind: "StorageLive", value: local});
        this.push({kind: "Init", place: placeOf(local), rvalue});
        return local;
    }

    /** Read a vector-typed local. */
    protected simdRead(local: LocalId): Operand {
        return {kind: "Copy", value: placeOf(local)};
    }

    /**
     * The place of the struct itself, through a reference when there is one.
     *
     * `a.addMut(b)` hands back a `Reference<dvec3>` so that mutations chain, so
     * the receiver of the *second* call in `a.addMut(b).scaleMut(2)` is a
     * reference rather than a value. Its place holds an address, not three
     * doubles — loading a vector out of it without the `Deref` would read the
     * pointer's own bytes as the first component.
     */
    protected linalgPlace(at: ts.Node, subject: Typed): Place | undefined {
        const place = this.placeOfSubject(at, subject);
        if (place === undefined || subject.type.kind !== "reference") {
            return place;
        }
        return {...place, projection: [...place.projection, {kind: "Deref"}]};
    }

    /** Load a linear-algebra value into a vector. */
    protected loadVector(at: ts.Node, subject: Typed, type: LinalgType): LocalId | undefined {
        const place = this.linalgPlace(at, subject);
        if (place === undefined) {
            return undefined;
        }
        return this.simdLocal(at, type, {
            kind: "SimdLoad",
            source: place,
            ty: this.simdTy(type),
        });
    }

    /** Put a vector into a fresh value of the linear-algebra type. */
    protected storeVector(at: ts.Node, vector: LocalId, type: LinalgType): Typed {
        return this.temporaryTyped(at, this.linalgStructOf(type), {
            kind: "SimdStore",
            vector: this.simdRead(vector),
        });
    }

    // -- the algorithms -------------------------------------------------------

    /**
     * A vector holding the same scalar in every lane.
     *
     * One `SimdSplat`, which the backend emits as an insert and a broadcast
     * shuffle — the idiom LLVM turns into `vbroadcastsd`.
     */
    protected splat(at: ts.Node, value: Operand, type: LinalgType): LocalId {
        return this.simdLocal(at, type, {
            kind: "SimdSplat",
            value,
            ty: this.simdTy(type),
        });
    }

    /**
     * Sum the **component** lanes of a vector, leaving any padding lane out.
     *
     * A left-to-right tree of ordinary scalar adds, because it is the ordering
     * the equivalent scalar code has and this module emits no `reassoc`: a
     * `dot` has to give the same bits every time it runs, on every machine.
     *
     * Reading only the component lanes is where a padded type's dead lane is
     * masked. It is done at the read rather than by keeping the lane zero,
     * because `div` does not keep it zero and nothing would notice until a
     * length came back NaN.
     */
    protected reduce(at: ts.Node, vector: LocalId, type: LinalgType): Typed {
        const component = this.componentType(type);
        let total: Typed | undefined;
        for (let lane = 0; lane < type.components.length; lane += 1) {
            const value = this.temporaryTyped(at, component, {
                kind: "SimdExtract",
                vector: this.simdRead(vector),
                lane,
            });
            total =
                total === undefined
                    ? value
                    : this.temporaryTyped(at, component, {
                        kind: "Binary",
                        op: "Add",
                        lhs: this.forRead(total),
                        rhs: this.forRead(value),
                    });
        }
        if (total === undefined) {
            // Unreachable: no vector type has zero components. Written as a
            // value rather than a `!` so a future one-component type is a wrong
            // answer here rather than a crash somewhere else.
            return this.temporaryTyped(at, component, {kind: "Default"});
        }
        return total;
    }

    /**
     * `a · b`, as a scalar.
     *
     * Multiply, then sum the component lanes. There is no `llvm.vector.reduce`
     * here on purpose: the ordered form of it is what this already is, and the
     * unordered form needs a fast-math flag this module does not emit.
     */
    protected dot(at: ts.Node, left: LocalId, right: LocalId, type: LinalgType): Typed {
        const product = this.simdLocal(at, type, {
            kind: "SimdBinary",
            op: "Mul",
            lhs: this.simdRead(left),
            rhs: this.simdRead(right),
        });
        return this.reduce(at, product, type);
    }

    /**
     * `sqrt(splat(x))` — a scalar square root, taken in the vector domain.
     *
     * There is no scalar `sqrt` node in the MIR and this is why there needs to
     * be none: LLVM folds `extractelement(sqrt(splat x), 0)` back to a single
     * `vsqrtsd`, and `normalize` wants the splatted form anyway. Verified in
     * the probe recorded in §22 rather than assumed.
     */
    protected sqrtSplat(at: ts.Node, value: Operand, type: LinalgType): LocalId {
        const splatted = this.splat(at, value, type);
        return this.simdLocal(at, type, {
            kind: "SimdUnary",
            op: "Sqrt",
            operand: this.simdRead(splatted),
        });
    }

    /**
     * `|v|` — the length, as a scalar.
     *
     * Lane 0 of the vector square root, which costs nothing over a scalar one.
     */
    protected length(at: ts.Node, vector: LocalId, type: LinalgType): Typed {
        const lengthSq = this.dot(at, vector, vector, type);
        const root = this.sqrtSplat(at, this.forRead(lengthSq), type);
        return this.temporaryTyped(at, this.componentType(type), {
            kind: "SimdExtract",
            vector: this.simdRead(root),
            lane: 0,
        });
    }

    /**
     * `v / |v|`.
     *
     * Divided by the *splatted* root rather than multiplied by a reciprocal:
     * one rounding instead of two, and no special case for a zero-length vector
     * — which divides to NaN or infinity, exactly as the scalar code would and
     * as every other total operation in this language does (DECISIONS §21).
     */
    protected normalize(at: ts.Node, vector: LocalId, type: LinalgType): LocalId {
        const lengthSq = this.dot(at, vector, vector, type);
        const root = this.sqrtSplat(at, this.forRead(lengthSq), type);
        return this.simdLocal(at, type, {
            kind: "SimdBinary",
            op: "Div",
            lhs: this.simdRead(vector),
            rhs: this.simdRead(root),
        });
    }

    /**
     * `a × b`, for three-component vectors.
     *
     * The two-shuffle form: `(a.yzx * b.zxy) - (a.zxy * b.yzx)`. Written with
     * shuffles rather than six lane reads and three subtractions because the
     * shuffles *are* the operation on a vector unit, and the scalar form would
     * have to be recognised and re-vectorised by LLVM to get back here.
     *
     * The mask indexes the concatenation of the two operands, so the entries
     * below all name the first one.
     */
    protected cross(at: ts.Node, left: LocalId, right: LocalId, type: LinalgType): LocalId {
        const yzx = (vector: LocalId): LocalId =>
            this.shuffle(at, vector, [1, 2, 0], type);
        const zxy = (vector: LocalId): LocalId =>
            this.shuffle(at, vector, [2, 0, 1], type);

        const first = this.simdLocal(at, type, {
            kind: "SimdBinary",
            op: "Mul",
            lhs: this.simdRead(yzx(left)),
            rhs: this.simdRead(zxy(right)),
        });
        const second = this.simdLocal(at, type, {
            kind: "SimdBinary",
            op: "Mul",
            lhs: this.simdRead(zxy(left)),
            rhs: this.simdRead(yzx(right)),
        });
        return this.simdLocal(at, type, {
            kind: "SimdBinary",
            op: "Sub",
            lhs: this.simdRead(first),
            rhs: this.simdRead(second),
        });
    }

    /**
     * One operation, given a loaded receiver and its evaluated arguments.
     *
     * The whole of `std/linalg`'s semantics, in one switch. Every arm composes
     * primitives — there is no arm here that hands the backend a named
     * operation to expand, which is the property that keeps the backend a
     * lookup table and lets a new operation be a new case.
     */
    protected compose(
        at: ts.Node,
        call: LinalgCall,
        self: LocalId,
        args: readonly Typed[],
    ): { vector: LocalId } | { scalar: Typed } | undefined {
        const {op, type} = call;
        const vectorArg = (index: number): LocalId | undefined => {
            const arg = args[index];
            return arg === undefined ? undefined : this.loadVector(at, arg, type);
        };
        const scalarArg = (index: number): Operand | undefined => {
            const arg = args[index];
            return arg === undefined ? undefined : this.forRead(arg);
        };
        const binary = (name: SimdBinOp, lhs: LocalId, rhs: LocalId): LocalId =>
            this.simdLocal(at, type, {
                kind: "SimdBinary",
                op: name,
                lhs: this.simdRead(lhs),
                rhs: this.simdRead(rhs),
            });

        switch (op.kind) {
            case "elementwise": {
                const other = vectorArg(0);
                return other === undefined ? undefined : {vector: binary(op.op, self, other)};
            }
            case "scaled": {
                const scalar = scalarArg(0);
                if (scalar === undefined) {
                    return undefined;
                }
                return {vector: binary(op.op, self, this.splat(at, scalar, type))};
            }
            case "unary":
                return {
                    vector: this.simdLocal(at, type, {
                        kind: "SimdUnary",
                        op: op.op,
                        operand: this.simdRead(self),
                    }),
                };
            // `self + other * t`, fused: one rounding rather than two, and the
            // only place in this file that asks for a contraction by name.
            case "addScaled": {
                const other = vectorArg(0);
                const t = scalarArg(1);
                if (other === undefined || t === undefined) {
                    return undefined;
                }
                return {
                    vector: this.simdLocal(at, type, {
                        kind: "SimdFma",
                        a: this.simdRead(this.splat(at, t, type)),
                        b: this.simdRead(other),
                        c: this.simdRead(self),
                    }),
                };
            }
            // `self + (other - self) * t`. This form rather than
            // `self*(1-t) + other*t` because it returns exactly `other` at
            // t = 1, which the other form does not.
            case "lerp": {
                const other = vectorArg(0);
                const t = scalarArg(1);
                if (other === undefined || t === undefined) {
                    return undefined;
                }
                const delta = binary("Sub", other, self);
                return {
                    vector: this.simdLocal(at, type, {
                        kind: "SimdFma",
                        a: this.simdRead(this.splat(at, t, type)),
                        b: this.simdRead(delta),
                        c: this.simdRead(self),
                    }),
                };
            }
            case "clamp": {
                const low = vectorArg(0);
                const high = vectorArg(1);
                if (low === undefined || high === undefined) {
                    return undefined;
                }
                return {vector: binary("Min", binary("Max", self, low), high)};
            }
            case "normalize":
                return {vector: this.normalize(at, self, type)};
            case "cross": {
                const other = vectorArg(0);
                return other === undefined ? undefined : {vector: this.cross(at, self, other, type)};
            }
            case "dot": {
                const other = vectorArg(0);
                return other === undefined ? undefined : {scalar: this.dot(at, self, other, type)};
            }
            case "lengthSq":
                return {scalar: this.dot(at, self, self, type)};
            case "length":
                return {scalar: this.length(at, self, type)};
            case "distanceSq": {
                const other = vectorArg(0);
                if (other === undefined) {
                    return undefined;
                }
                const delta = binary("Sub", self, other);
                return {scalar: this.dot(at, delta, delta, type)};
            }
            case "distance": {
                const other = vectorArg(0);
                if (other === undefined) {
                    return undefined;
                }
                return {scalar: this.length(at, binary("Sub", self, other), type)};
            }
            // Component-wise `===`, and-ed together. Exact equality, with no
            // tolerance anywhere near it: a NaN component makes this false, and
            // an `approxEquals` that picked an epsilon for the caller would be
            // picking wrong for most of them.
            case "equals": {
                const other = vectorArg(0);
                if (other === undefined) {
                    return undefined;
                }
                return {scalar: this.laneWiseEquals(at, self, other, type)};
            }
        }
    }

    /** `a.x === b.x && a.y === b.y && …`, without the short-circuit. */
    protected laneWiseEquals(
        at: ts.Node,
        left: LocalId,
        right: LocalId,
        type: LinalgType,
    ): Typed {
        const component = this.componentType(type);
        const bool: MachineType = {kind: "bool"};
        let all: Typed | undefined;
        for (let lane = 0; lane < type.components.length; lane += 1) {
            const a = this.temporaryTyped(at, component, {
                kind: "SimdExtract",
                vector: this.simdRead(left),
                lane,
            });
            const b = this.temporaryTyped(at, component, {
                kind: "SimdExtract",
                vector: this.simdRead(right),
                lane,
            });
            const same = this.temporaryTyped(at, bool, {
                kind: "Binary",
                op: "Eq",
                lhs: this.forRead(a),
                rhs: this.forRead(b),
            });
            // `BitAnd` rather than `&&`: a `bool` is one byte here, every lane
            // has already been compared, and short-circuiting would be control
            // flow bought for nothing.
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

    // -- what matrices need from here -----------------------------------------
    //
    // The matrix algorithms live in `linalg-matrix.ts`: one subject, and one
    // long enough that keeping it here would have doubled this file. They are
    // reached through these two hooks rather than by the dispatch moving down a
    // level, because the dispatch is the same for both families and there
    // should be exactly one of it.

    /** `A.mul(B)`, `m.transpose()`, `m.inverse()` — see `linalg-matrix.ts`. */
    protected abstract matrixCompose(
        at: ts.Node,
        call: LinalgCall,
        self: Typed,
        args: readonly Typed[],
    ): { value: Typed } | { columns: LocalId[] } | undefined;

    /** `dmat4.perspective(…)` and its siblings — see `linalg-matrix.ts`. */
    protected abstract matrixCtor(
        expression: ts.CallExpression,
        type: LinalgType,
        ctor: LinalgCtor,
        args: readonly ts.Expression[],
    ): Typed | undefined;

    /**
     * Every operation on a type with no vector form — see `linalg-scalar.ts`.
     *
     * Integer and boolean vectors, and every component-wise comparison whatever
     * the element is.
     */
    protected abstract scalarCompose(
        at: ts.Node,
        call: LinalgCall,
        self: Typed,
        args: readonly Typed[],
    ): { value: Typed } | undefined;

    /** `q.mul(r)`, `q.slerp(r, t)`, `q.toMat4()` — see `linalg-quat.ts`. */
    protected abstract quatCompose(
        at: ts.Node,
        call: LinalgCall,
        self: Typed,
        args: readonly Typed[],
    ): { value: Typed } | { vector: LocalId } | undefined;

    /** `dquat.fromAxisAngle(…)` and its siblings — see `linalg-quat.ts`. */
    protected abstract quatCtor(
        expression: ts.CallExpression,
        type: LinalgType,
        ctor: LinalgCtor,
        args: readonly ts.Expression[],
    ): Typed | undefined;

    /**
     * `m[0]` and `v[1]` — a **constant** index into a linear-algebra type.
     *
     * A field projection, because these are structs rather than arrays: `m[0]`
     * is `m.c0` written the way a shader writes it, and it costs no arithmetic.
     *
     * A *computed* index is deliberately refused. Components are not at a
     * uniform stride once a padded type is involved — an `aligned_dvec3`'s
     * three components sit in four lanes — so `v[i]` would need either a bounds
     * check this language does not have for structs or a stride that is a lie
     * for half the types. Naming the component is always available and always
     * correct.
     */
    protected linalgElementPlace(
        expression: ts.ElementAccessExpression,
        subject: Typed,
        type: LinalgType,
    ): { place: Place; element: MachineType } | undefined {
        const argument = expression.argumentExpression;
        if (!ts.isNumericLiteral(argument) || /[.eE]/.test(argument.getText())) {
            this.outer.error(
                argument,
                "GF0002",
                `a \`${type.name}\` can only be indexed by a literal, because its ` +
                `${type.family === "mat" ? "columns" : "components"} are fields rather than ` +
                "elements at a stride. Name the " +
                `${type.family === "mat" ? "column" : "component"} — ` +
                `\`${type.family === "mat" ? "m.c0" : "v.x"}\` — or index by a constant.`,
            );
            return undefined;
        }

        const index = Number(argument.getText());
        if (!Number.isInteger(index) || index < 0 || index >= type.components.length) {
            this.outer.error(
                argument,
                "GF0164",
                `\`${type.name}\` has ${type.components.length} ` +
                `${type.family === "mat" ? "columns" : "components"}, so \`${index}\` is ` +
                "outside it." +
                (type.padded
                    ? " Its padding is not a component and cannot be reached."
                    : ""),
            );
            return undefined;
        }

        const place = this.linalgPlace(expression, subject);
        if (place === undefined) {
            return undefined;
        }
        const column = columnTypeOf(type);
        return {
            place: this.columnPlace(place, index),
            element:
                column === undefined ? this.componentType(type) : this.linalgStructOf(column),
        };
    }

    /** One evaluated scalar argument, coerced to the element type. */
    protected scalarArgument(
        at: ts.Node,
        type: LinalgType,
        argument: ts.Expression | undefined,
    ): Operand | undefined {
        if (argument === undefined) {
            this.outer.unsupported(at, `a \`${type.name}\` argument that is missing`);
            return undefined;
        }
        const component = this.componentType(type);
        const value = this.value(argument, component);
        const coerced = value && this.coerce(argument, value, component);
        if (coerced === undefined) {
            return undefined;
        }
        // Read repeatedly, so the operand has to be one that can be: a
        // temporary consumed once would be moved out of by its first use.
        return this.repeatable(coerced);
    }

    /** A `Reference<T>` to a place, which is what a `…Mut` hands back. */
    protected referenceTo(at: ts.Node, place: Place, type: LinalgType): Typed {
        const referent = this.linalgStructOf(type);
        return {
            operand: this.refTo(at, place, referent),
            type: {kind: "reference", referent},
        };
    }

    /**
     * Store a computed value back through the receiver, for a `…Mut` form on a
     * path that produced a whole value rather than lanes.
     */
    protected writeBack(
        at: ts.Node,
        receiver: Typed,
        type: LinalgType,
        value: Typed,
    ): Typed | undefined {
        const place = this.linalgPlace(at, receiver);
        if (place === undefined) {
            return undefined;
        }
        this.push({kind: "Assign", place, rvalue: {kind: "Use", value: this.forStorage(value)}});
        return this.referenceTo(at, place, type);
    }

    /**
     * A value that is about to be read again.
     *
     * A `Typed` from `temporaryTyped` may be a move-once operand, and the
     * algorithms here read the same intermediate several times — `sin` appears
     * six times in a Rodrigues rotation. Passing one through twice without this
     * moves out of it the first time.
     */
    protected reread(value: Typed): Typed {
        return {operand: this.repeatable(value), type: value.type};
    }

    /** A scalar binary operation on two element-typed values. */
    protected scalarOp(
        at: ts.Node,
        op: "Add" | "Sub" | "Mul" | "Div",
        type: LinalgType,
        lhs: Typed,
        rhs: Typed,
    ): Typed {
        return this.temporaryTyped(at, this.componentType(type), {
            kind: "Binary",
            op,
            lhs: this.forRead(lhs),
            rhs: this.forRead(rhs),
        });
    }

    /** `-x`, on an element-typed value. */
    protected scalarNeg(at: ts.Node, type: LinalgType, value: Typed): Typed {
        return this.temporaryTyped(at, this.componentType(type), {
            kind: "Unary",
            op: "Neg",
            operand: this.forRead(value),
        });
    }

    /** An element-typed literal. */
    protected scalarConst(at: ts.Node, type: LinalgType, value: number): Typed {
        return {operand: this.componentConst(at, type, value), type: this.componentType(type)};
    }

    /** One lane of a vector, as a scalar. */
    protected laneOf(at: ts.Node, type: LinalgType, vector: LocalId, lane: number): Typed {
        return this.temporaryTyped(at, this.componentType(type), {
            kind: "SimdExtract",
            vector: this.simdRead(vector),
            lane,
        });
    }

    /**
     * `gf_dsin` and friends, at the element's width.
     *
     * The transform builders are the only part of `std/linalg` that needs a
     * transcendental, and they get it from the same runtime `std/math` calls a
     * user would — DECISIONS §21's surface, reached from the inside.
     */
    protected mathCall(at: ts.Expression, type: LinalgType, fn: string, x: Typed): Typed | undefined {
        const prefix = type.element === "f32" ? "f" : "d";
        return this.callRuntime(at, `gf_${prefix}${fn}`, [x], this.componentType(type));
    }

    /**
     * The place of one column of a matrix.
     *
     * An ordinary field projection, because a matrix *is* a struct of columns —
     * which is the whole reason matrices needed so little new machinery.
     */
    protected columnPlace(place: Place, column: number): Place {
        return {...place, projection: [...place.projection, {kind: "Field", value: FieldId(column)}]};
    }

    /** Load every column of a matrix into its own vector. */
    protected loadColumns(
        at: ts.Node,
        subject: Typed,
        type: LinalgType,
        column: LinalgType,
    ): LocalId[] | undefined {
        const place = this.linalgPlace(at, subject);
        if (place === undefined) {
            return undefined;
        }
        return type.components.map((_, index) =>
            this.simdLocal(at, column, {
                kind: "SimdLoad",
                source: this.columnPlace(place, index),
                ty: this.simdTy(column),
            }),
        );
    }

    /**
     * Build a matrix value from its columns.
     *
     * Each column is written with an `Init` through a field projection rather
     * than the whole matrix being assembled as one aggregate, because the
     * columns are already *in vector registers* — going through an aggregate
     * would mean storing each one to a temporary and copying it back in.
     */
    protected matrixValue(at: ts.Node, type: LinalgType, columns: readonly LocalId[]): Typed {
        const machine = this.linalgStructOf(type);
        const local = this.f.addLocal({
            ty: this.outer.tyOf(machine, at),
            storage: "Temporary",
            span: this.outer.span(at),
        });
        this.temporaries.push(local);
        this.push({kind: "StorageLive", value: local});
        for (const [index, column] of columns.entries()) {
            this.push({
                kind: "Init",
                place: this.columnPlace(placeOf(local), index),
                rvalue: {kind: "SimdStore", vector: this.simdRead(column)},
            });
        }
        return {
            operand: {kind: "Copy", value: placeOf(local)},
            type: machine,
            temporary: local,
        };
    }

    /** A vector built from one scalar per lane, padding included. */
    protected vectorFromLanes(
        at: ts.Node,
        column: LinalgType,
        lanes: readonly Typed[],
    ): LocalId {
        const filled = [...lanes.map((lane) => this.forRead(lane))];
        while (filled.length < column.fields.length) {
            filled.push(this.componentConst(at, column, 0));
        }
        return this.simdLocal(at, column, {
            kind: "SimdFromParts",
            lanes: filled,
            ty: this.simdTy(column),
        });
    }

    // -- entry points ---------------------------------------------------------

    /**
     * A component's value as a constant, for `zero`, `one` and the unit axes.
     *
     * The three element families each spell a constant differently, and the
     * float case is the one that has to encode rather than count: a `Float`
     * constant carries IEEE *bits*, so that the encoding is exact and a NaN
     * payload survives the trip.
     */
    protected componentConst(at: ts.Node, type: LinalgType, value: number): Operand {
        const ty = this.outer.tyOf(this.componentType(type), at);
        if (type.element === "bool") {
            return {kind: "Const", value: {kind: "Bool", value: value !== 0, ty}};
        }
        if (type.element === "f32" || type.element === "f64") {
            const bits =
                type.element === "f32"
                    ? BigInt(new Uint32Array(new Float32Array([value]).buffer)[0]!)
                    : new BigUint64Array(new Float64Array([value]).buffer)[0]!;
            return {kind: "Const", value: {kind: "Float", bits, ty}};
        }
        // An integer constant is a bit pattern of the target width, so a
        // negative one is written as its two's complement rather than as a sign
        // the wire format has nowhere to put.
        const width = type.element === "i64" || type.element === "u64" ? 64n : 32n;
        const bits = BigInt(value) & ((1n << width) - 1n);
        return {kind: "Const", value: {kind: "Int", bits, ty}};
    }

    /**
     * Build a value from one operand per **component**, zeroing any padding.
     *
     * The padding lane is written rather than left alone. `Init` fills a place
     * that holds nothing yet, so an unwritten lane holds whatever the frame
     * held — and while a reduction masks it, `equals` compares components one
     * at a time and a byte-wise copy carries it along. Zero is the one value
     * that makes two equal vectors stay equal.
     */
    protected buildValue(at: ts.Node, type: LinalgType, components: Operand[]): Typed {
        const machine = this.linalgStructOf(type);
        const fields = [...components];
        while (fields.length < type.fields.length) {
            fields.push(this.componentConst(at, type, 0));
        }
        return this.temporaryTyped(at, machine, {
            kind: "Aggregate",
            ty: this.outer.tyOf(machine, at),
            fields,
        });
    }

    /**
     * `new dvec3(x, y, z)`.
     *
     * An aggregate literal and nothing more: construction needs no vector unit,
     * and going through one would be a store and a load to build something the
     * caller already has in registers.
     */
    protected linalgNew(expression: ts.NewExpression): Typed | undefined | "not-linalg" {
        const type = this.linalgNamed(expression.expression);
        if (type === undefined) {
            return "not-linalg";
        }
        const component = this.componentType(type);
        const args: Operand[] = [];
        for (const argument of expression.arguments ?? []) {
            const value = this.value(argument, component);
            if (value === undefined) {
                return undefined;
            }
            const coerced = this.coerce(argument, value, component);
            if (coerced === undefined) {
                return undefined;
            }
            args.push(this.forRead(coerced));
        }
        if (args.length !== type.components.length) {
            this.outer.error(
                expression,
                "GF0002",
                `\`${type.name}\` has ${type.components.length} components, so ` +
                `\`new ${type.name}(…)\` takes ${type.components.length} arguments; ` +
                `this one was given ${args.length}.`,
            );
            return undefined;
        }
        return this.buildValue(expression, type, args);
    }

    /**
     * `a.add(b)`, `a.addMut(b)`, `dvec3.add(a, b)`, `dvec3.zero()`,
     * `dvec3.from(v)` — every call on or against a linear-algebra type.
     *
     * Returns `"not-linalg"` rather than `undefined` when the receiver is not
     * one at all, so the caller carries on to the class and contract paths
     * without a diagnostic having been raised for something that was never this
     * file's business.
     */
    protected linalgCall(
        expression: ts.CallExpression,
        access: ts.PropertyAccessExpression,
    ): Typed | undefined | "not-linalg" {
        const named = this.linalgNamed(access.expression);
        if (named !== undefined) {
            return this.#staticCall(expression, access, named);
        }

        const type = this.linalgOf(this.tryErase(access.expression));
        if (type === undefined) {
            return "not-linalg";
        }
        const call = this.linalgMethod(access.name.text, type);
        if (call === undefined) {
            this.outer.unsupported(access, `\`${access.name.text}\` on a \`${type.name}\``);
            return undefined;
        }

        const receiver = this.value(access.expression, undefined);
        if (receiver === undefined) {
            return undefined;
        }
        return this.#apply(expression, call, receiver, [...expression.arguments]);
    }

    /**
     * The `dvec3.…` forms: the constants, the conversions, and the static
     * spelling of every operation.
     */
    #staticCall(
        expression: ts.CallExpression,
        access: ts.PropertyAccessExpression,
        type: LinalgType,
    ): Typed | undefined {
        const name = access.name.text;
        const args = [...expression.arguments];

        // The constructors, from the table. Everything a *vector* builds is an
        // aggregate literal rather than a trip through the vector unit, for the
        // reason `new` is; everything a *matrix* builds is columns, and lives
        // next door in `linalg-matrix.ts`.
        const built = linalgCtorOf(name, type);
        if (built !== undefined) {
            if (built.ctor.kind === "from") {
                return this.#convert(expression, type, args);
            }
            if (type.family === "mat") {
                return this.matrixCtor(expression, type, built.ctor, args);
            }
            if (type.family === "quat") {
                return this.quatCtor(expression, type, built.ctor, args);
            }
            switch (built.ctor.kind) {
                case "zero":
                case "one": {
                    const value = built.ctor.kind === "one" ? 1 : 0;
                    return this.buildValue(
                        expression,
                        type,
                        type.components.map(() => this.componentConst(expression, type, value)),
                    );
                }
                case "unit":
                    return this.buildValue(
                        expression,
                        type,
                        type.components.map((_, index) =>
                            this.componentConst(expression, type, index === built.axis ? 1 : 0),
                        ),
                    );
                case "splat": {
                    const operand = this.scalarArgument(expression, type, args[0]);
                    if (operand === undefined) {
                        return undefined;
                    }
                    return this.buildValue(
                        expression,
                        type,
                        type.components.map(() => operand),
                    );
                }
                default:
                    this.outer.unsupported(
                        access,
                        `\`${name}\` on \`${type.name}\``,
                    );
                    return undefined;
            }
        }

        // Everything else is an operation whose receiver was written as the
        // first argument. One implementation, two spellings.
        const call = this.linalgMethod(name, type);
        if (call === undefined) {
            this.outer.unsupported(access, `\`${name}\` on \`${type.name}\``);
            return undefined;
        }
        const [self, ...rest] = args;
        if (self === undefined) {
            this.outer.unsupported(expression, `\`${type.name}.${name}\` with no receiver`);
            return undefined;
        }
        const receiver = this.value(self, this.linalgStructOf(type));
        if (receiver === undefined) {
            return undefined;
        }
        return this.#apply(expression, call, receiver, rest);
    }

    /**
     * `dvec3.from(v)` — component-wise conversion between element types.
     *
     * Lane by lane through the ordinary scalar cast, rather than a vector
     * convert. `<3 x float>` to `<3 x double>` is one instruction and this is
     * three, and it is still the right first version: the cast rules — which
     * saturate, which round — already live in one place, and having a second
     * copy of them that applied only inside vectors is exactly the kind of
     * divergence this compiler is built to avoid. LLVM re-vectorises the
     * obvious cases anyway.
     */
    #convert(
        expression: ts.CallExpression,
        type: LinalgType,
        args: readonly ts.Expression[],
    ): Typed | undefined {
        const argument = args[0];
        if (argument === undefined) {
            this.outer.unsupported(expression, "`from` with no value");
            return undefined;
        }
        const source = this.linalgOf(this.tryErase(argument));
        if (source === undefined) {
            this.outer.unsupported(argument, "`from` on something that is not a vector");
            return undefined;
        }
        if (source.components.length !== type.components.length) {
            this.outer.error(
                argument,
                "GF0002",
                `\`${source.name}\` has ${source.components.length} components and ` +
                `\`${type.name}\` has ${type.components.length}. A conversion changes the ` +
                "element type, never the shape — there is no answer for which component " +
                "would be dropped or invented.",
            );
            return undefined;
        }

        const value = this.value(argument, this.linalgStructOf(source));
        if (value === undefined) {
            return undefined;
        }
        const place = this.linalgPlace(argument, value);
        if (place === undefined) {
            return undefined;
        }

        const from = this.componentType(source);
        const to = this.componentType(type);
        const components: Operand[] = [];
        for (let index = 0; index < type.components.length; index += 1) {
            const lane: Typed = {
                operand: {kind: "Copy", value: {...place, projection: [
                    ...place.projection,
                    {kind: "Field", value: FieldId(index)},
                ]}},
                type: from,
            };
            if (from.kind === to.kind && JSON.stringify(from) === JSON.stringify(to)) {
                components.push(lane.operand);
                continue;
            }
            const kind = this.castKind(argument, from, to);
            if (kind === undefined) {
                return undefined;
            }
            components.push(
                this.temporary(argument, to, {
                    kind: "Cast",
                    op: kind,
                    operand: lane.operand,
                    to: this.outer.tyOf(to, argument),
                }),
            );
        }
        return this.buildValue(expression, type, components);
    }

    /**
     * Load the receiver, evaluate the arguments, compose, and put the result
     * back where the spelling says it goes.
     *
     * The mutating form writes through the receiver's own place and hands back
     * a reference to it, so `a.addMut(b).scaleMut(2)` finds a receiver on its
     * second hop. Nothing here guards against `a.addMut(a)`: it is well defined
     * — the load happens before the store — and guarding it would be a rule
     * this language does not otherwise have.
     */
    #apply(
        expression: ts.CallExpression,
        call: LinalgCall,
        receiver: Typed,
        args: readonly ts.Expression[],
    ): Typed | undefined {
        const {op, type} = call;
        if (args.length !== op.params.length) {
            this.outer.error(
                expression,
                "GF0002",
                `\`${type.name}.${op.name}\` takes ${op.params.length} argument` +
                `${op.params.length === 1 ? "" : "s"}, and was given ${args.length}.`,
            );
            return undefined;
        }

        const evaluated: Typed[] = [];
        for (const [index, argument] of args.entries()) {
            const kind = op.params[index];
            // `relatedType` is the one place that says what `column` or `axis`
            // means for a given receiver, so the width pass, the generator and
            // this cannot drift.
            const related = kind === undefined ? undefined : relatedType(type, kind);
            const expected =
                related === undefined
                    ? this.componentType(type)
                    : this.linalgStructOf(related);
            const value = this.value(argument, expected);
            if (value === undefined) {
                return undefined;
            }
            const coerced =
                kind === "scalar" ? this.coerce(argument, value, expected) : value;
            if (coerced === undefined) {
                return undefined;
            }
            evaluated.push(coerced);
        }

        // A *vector* with no lane count — an integer or boolean one — works on
        // fields rather than lanes, and every comparison does too whatever the
        // element is, because a comparison produces a `bvec` rather than a mask
        // (DECISIONS §22).
        //
        // The family test is not decoration: a **matrix** also has no lane
        // count, because a matrix is not one register — its columns are. Left
        // out, this arm claims every matrix operation and `mulVec` becomes a
        // gap in the compiler.
        if (type.family === "vec" && (type.lanes === null || op.kind === "compare")) {
            const result = this.scalarCompose(expression, call, receiver, evaluated);
            if (result === undefined) {
                return undefined;
            }
            if (!call.mutating) {
                return result.value;
            }
            return this.writeBack(expression, receiver, type, result.value);
        }

        // **Only the quaternion-specific kinds divert.** `add`, `sub`, `scale`,
        // `negate`, `dot`, `length`, `lengthSq`, `normalize` and `equals` on a
        // quaternion are the *vector* operations on the same four lanes, and
        // they fall through to the shared path below — which is the "four
        // fifths shared" claim in DECISIONS §22, enforced rather than described.
        if (type.family === "quat" && QUAT_ONLY_KINDS.has(op.kind)) {
            const result = this.quatCompose(expression, call, receiver, evaluated);
            if (result === undefined) {
                return undefined;
            }
            if ("value" in result) {
                return result.value;
            }
            if (!call.mutating) {
                return this.storeVector(expression, result.vector, type);
            }
            const place = this.linalgPlace(expression, receiver);
            if (place === undefined) {
                return undefined;
            }
            this.push({
                kind: "Assign",
                place,
                rvalue: {kind: "SimdStore", vector: this.simdRead(result.vector)},
            });
            return this.referenceTo(expression, place, type);
        }

        // A matrix works column by column, so it never loads "the receiver"
        // into one register and the shared path below does not fit.
        if (type.family === "mat") {
            const result = this.matrixCompose(expression, call, receiver, evaluated);
            if (result === undefined) {
                return undefined;
            }
            if ("value" in result) {
                return result.value;
            }
            if (!call.mutating) {
                return this.matrixValue(expression, type, result.columns);
            }
            const target = this.linalgPlace(expression, receiver);
            if (target === undefined) {
                return undefined;
            }
            for (const [index, vector] of result.columns.entries()) {
                this.push({
                    kind: "Assign",
                    place: this.columnPlace(target, index),
                    rvalue: {kind: "SimdStore", vector: this.simdRead(vector)},
                });
            }
            const referent = this.linalgStructOf(type);
            return {
                operand: this.refTo(expression, target, referent),
                type: {kind: "reference", referent},
            };
        }

        const self = this.loadVector(expression, receiver, type);
        if (self === undefined) {
            return undefined;
        }
        const result = this.compose(expression, call, self, evaluated);
        if (result === undefined) {
            return undefined;
        }

        if ("scalar" in result) {
            return result.scalar;
        }
        if (!call.mutating) {
            return this.storeVector(expression, result.vector, type);
        }

        const place = this.linalgPlace(expression, receiver);
        if (place === undefined) {
            return undefined;
        }
        this.push({
            kind: "Assign",
            place,
            rvalue: {kind: "SimdStore", vector: this.simdRead(result.vector)},
        });
        // A reference to the receiver, so the mutation chains. Deliberately not
        // a copy: `a.addMut(b)` is a statement in almost every use, and copying
        // out a value nobody reads would be a store the optimiser has to prove
        // dead rather than one that was never emitted.
        const referent = this.linalgStructOf(type);
        return {
            operand: this.refTo(expression, place, referent),
            type: {kind: "reference", referent},
        };
    }

    /**
     * A lane permutation of one vector.
     *
     * Both operands are the same vector, so every mask entry names it. A padded
     * type's dead lane is carried through as itself, which is fine: `cross` is
     * a three-component operation and nothing reads lane 3 of its result except
     * a reduction, which skips it.
     */
    protected shuffle(at: ts.Node, vector: LocalId, lanes: number[], type: LinalgType): LocalId {
        // A padded type is four lanes wide and the mask has to be too, so the
        // dead lane names itself rather than being dropped — a mask shorter
        // than the vector is a different-shaped vector.
        const mask = [...lanes];
        while (mask.length < type.fields.length) {
            mask.push(mask.length);
        }
        return this.simdLocal(at, type, {
            kind: "SimdShuffle",
            lhs: this.simdRead(vector),
            rhs: this.simdRead(vector),
            mask: Uint8Array.from(mask),
            ty: this.simdTy(type),
        });
    }
}
