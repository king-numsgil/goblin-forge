/**
 * The types lowering passes around: what an expression's width came out as,
 * what a lowered expression is, and what the module knows about a function or
 * a class member before its body is reached.
 */

import {
    type FuncId,
    type FunctionBuilder,
    LocalId,
    type Module as MirModule,
    type Operand,
    type SigId,
    type TyId,
} from "@goblin-forge/backend";
import type { Diagnostic, MachineType, Substitution } from "@goblin-forge/checker";
import ts from "typescript";
import type { ClassInfo, MethodBody } from "../classes.ts";
import type { Binding } from "./scopes.ts";

export interface LowerResult {
    readonly module: MirModule | undefined;
    readonly diagnostics: readonly Diagnostic[];
}

/**
 * What {@link WidthPass.width} concluded about an expression.
 *
 * `poly` is the interesting one: an expression built only from literals has no
 * width of its own and takes one from wherever it lands. `42` is an `i32` in
 * one place and a `u8` in another, and neither is a conversion.
 */
export type Width =
    | { readonly kind: "typed"; readonly type: MachineType }
    | { readonly kind: "poly" }
    | { readonly kind: "error" };

export const STRING: MachineType = {kind: "string"};
export const CSTRING_TYPE: MachineType = {kind: "cstring"};
export const USIZE: MachineType = {kind: "scalar", name: "usize"};
/** `offset` counts in elements and counts **backwards** too, hence signed. */
export const ISIZE: MachineType = {kind: "scalar", name: "isize"};
export const VOID: MachineType = {kind: "void"};

export const POLY: Width = {kind: "poly"};
export const ERROR: Width = {kind: "error"};
export const typed = (type: MachineType): Width => ({kind: "typed", type});

/**
 * A lowered expression, and the type it actually has.
 *
 * `temporary` is set when the value lives in a temporary this expression
 * created. That changes what its single use is allowed to do with it: a
 * temporary can be *moved* into a binding rather than cloned, and *borrowed*
 * into a call rather than cloned, because it is already the copy.
 */
export interface Typed {
    readonly operand: Operand;
    readonly type: MachineType;
    readonly temporary?: LocalId;
    /**
     * A reference to something nothing owns.
     *
     * Legal as an *argument*: the temporary dies at the end of the enclosing
     * full-expression, which is after the call returns. Illegal as a *binding*,
     * which would outlive it — that is `GF0234`, and it is the one place the
     * distinction matters, so the flag is set here and read only there.
     */
    readonly borrowsTemporary?: true;
}

export interface FnSignature {
    readonly params: readonly { name: string; type: MachineType }[];
    readonly returns: MachineType;
}

/**
 * An arrow function lifted into a function of its own, and what the frame that
 * wrote it still has to do.
 *
 * `captures` is in **field order**, and that is the whole contract between the
 * two halves: the lifted body reads its environment by field index, and the
 * closure site builds the environment by taking a reference to each of these in
 * turn. Both read this one list rather than recomputing it, because a capture
 * set derived twice is a capture set that can differ once.
 */
export interface LiftedClosure {
    readonly func: FuncId;
    readonly captures: readonly Binding[];
    /**
     * The environment struct, and a pointer to it. Absent when the closure
     * captures nothing, which then has no environment to build and passes a
     * null one.
     */
    readonly env: { readonly ty: TyId; readonly pointer: TyId } | undefined;
}

/**
 * A function the module can call.
 *
 * `imported` is a function declared with no body — an `extern "C"` symbol some
 * other library defines. It is classified by the C rules on both halves of the
 * call, because the recorded signature is the only thing the two sides share.
 */
export type FnRecord =
    | {
          readonly kind: "defined";
          readonly id: FuncId;
          readonly sig: SigId;
          readonly signature: FnSignature;
          /** The name as written, before any qualification. */
          readonly name: string;
          readonly exported: boolean;
      }
    | {
          readonly kind: "imported";
          readonly sig: SigId;
          readonly signature: FnSignature;
          readonly name: string;
          readonly exported: boolean;
          /** Where it was declared, for the span on the extern when one is made. */
          readonly declaration: ts.FunctionDeclaration;
      };

/**
 * A generic function, before any call has said what its type parameters are.
 *
 * Not an {@link FnRecord}, and the difference is the point: a template has no
 * `FuncId`, no `SigId` and no signature, because none of those exist until the
 * type arguments do. Nothing is emitted for one.
 */
export interface FnTemplate {
    readonly node: ts.FunctionDeclaration;
    /** The name as written. Every instantiation keeps it, for diagnostics. */
    readonly name: string;
    /** The declaration's own key, which every instantiation's key extends. */
    readonly key: string;
    readonly parameters: readonly ts.Symbol[];
}

/**
 * Where a generic is used, which is the two places type arguments can appear.
 *
 * A **call** — `first<i32>(xs)`, or `first(xs)` with them inferred — and an
 * **address**, `identity<i32>` written where a function pointer is wanted. Both
 * are a `ts.Node` with an optional `typeArguments`, which is the whole of what
 * instantiation needs; they differ in that only a call has arguments for tsc to
 * have inferred from.
 */
export type GenericUse = {
    readonly node: ts.CallExpression | ts.ExpressionWithTypeArguments;
};

/** One instantiation, declared and waiting for its body. */
export interface PendingInstantiation {
    readonly node: ts.FunctionDeclaration;
    readonly builder: FunctionBuilder;
    readonly record: Extract<FnRecord, { kind: "defined" }>;
    /** Concrete, always — see `TypeBinding` in the checker. */
    readonly bindings: Substitution;

    /** Its identity: the declaration's key and the erased type arguments. */
    readonly key: string;

    /**
     * `first<i32>` — what a diagnostic's note calls it.
     *
     * Apart from {@link PendingInstantiation.key} because that one holds the
     * declaring file's absolute path, which is the right thing to compare and
     * the wrong thing to show anybody.
     */
    readonly label: string;

    /**
     * How many instantiations deep this one is.
     *
     * Carried on the item rather than measured from the call stack, because the
     * worklist is a **queue**: each instantiation is lowered at the top level
     * and pushes its own children onto the back, so nothing is ever nested and
     * a depth counted from the stack is always one. That is how the first
     * version of the limit failed to fire at all, and an unbounded generic ran
     * until the test timed out instead of being reported.
     */
    readonly depth: number;

    /** The instantiations that led here, innermost last, for the diagnostic. */
    readonly trail: readonly string[];

    /** The call that asked for it, for the note. */
    readonly at: ts.Node;
}

/**
 * One member of a class, waiting for its body to be lowered.
 *
 * `bindings` is the class's substitution — empty for an ordinary class, and
 * the instantiation's for a `Box<i32>`. It rides on the body rather than being
 * looked up from the class because it is what the body is lowered *under*, and
 * a member found without it would erase `T` as unbound at whichever expression
 * mentioned it.
 */
export type ClassBody =
    | {
          readonly kind: "destructor";
          readonly info: ClassInfo;
          readonly builder: FunctionBuilder;
          readonly bindings: Substitution;
      }
    | {
          readonly kind: "constructor";
          readonly bindings: Substitution;
          readonly info: ClassInfo;
          /** Absent when the class declares none and the constructor is generated. */
          readonly node: ts.ConstructorDeclaration | undefined;
          readonly builder: FunctionBuilder;
          readonly params: readonly { name: string; type: MachineType }[];
      }
    | {
          readonly kind: "method";
          readonly bindings: Substitution;
          readonly info: ClassInfo;
          readonly node: MethodBody;
          readonly builder: FunctionBuilder;
          readonly params: readonly { name: string; type: MachineType }[];
          readonly returns: MachineType;
      }
    | {
          /**
           * A `static` method — the same shape as a plain function, and lowered as
           * one. No `this` is bound, so parameters start at local 1 rather than 2.
           */
          readonly kind: "static";
          readonly bindings: Substitution;
          readonly info: ClassInfo;
          readonly node: MethodBody;
          readonly builder: FunctionBuilder;
          readonly params: readonly { name: string; type: MachineType }[];
          readonly returns: MachineType;
      };
