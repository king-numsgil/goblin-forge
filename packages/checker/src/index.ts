/**
 * `@goblin-forge/checker` — the type-checker integration.
 *
 * Everything in this package is about tsc: loading the project's config,
 * holding a `ts.Program` across builds, and turning tsc's verdict into this
 * compiler's diagnostic shape. It knows nothing about MIR, Cranelift, or
 * linking.
 *
 * The division matters because of REWRITE-PLAN §8's hard rule. tsc speaks
 * `TS####` and the user sees it while typing; the language subset and the
 * machine model speak `GF####`; and the backend never speaks about a user
 * program at all.
 */

export {
    type Diagnostic,
    type DiagnosticSource,
    type FormatOptions,
    format,
    formatAll,
    hasErrors,
    type Location,
    type Note,
    type Severity,
} from "./diagnostics.ts";

export { allCodes, type Code, type CodeEntry, CODES, explain } from "./codes.ts";

export {
    Checker,
    type CheckerOptions,
    type CheckResult,
    checkPreludeIsVisibleToEditors,
} from "./program.ts";

export { fromTsDiagnostic, loadConfig, type LoadedConfig } from "./tsconfig.ts";

export {
    appliesTo,
    axisVectorOf,
    boolVectorOf,
    columnTypeOf,
    ctorsFor,
    isIntegerPrefix,
    LINALG_BOOL_OPS,
    LINALG_INT_OPS,
    LINALG_QUAT_OPS,
    type LinalgBitOp,
    type LinalgCmpOp,
    matrixOf,
    relatedType,
    SIGNED_PREFIXES,
    VEC_PREFIXES,
    hasMutatingForm,
    inLinalgModule,
    isLinalgConstructor,
    linalgCtorOf,
    linalgFromMachine,
    linalgMethodOf,
    linalgNamedBy,
    type LinalgBinOp,
    type LinalgCtor,
    type LinalgCtorKind,
    type LinalgCtorParam,
    type LinalgUnOp,
    LINALG_CTORS,
    LINALG_ELEMENTS,
    LINALG_MAT_OPS,
    LINALG_MODULE,
    LINALG_OPS,
    LINALG_TYPES,
    type LinalgOp,
    type LinalgOpKind,
    type LinalgParam,
    type LinalgPrefix,
    type LinalgReturn,
    type LinalgType,
    linalgStructName,
    mutatingName,
    opsFor,
    PAD_FIELD,
    SIMD_PREFIXES,
} from "./linalg.ts";

export {
    ASSUMED_POINTER_BITS,
    checkLiteral,
    commonType,
    fits,
    fitsScalar,
    hasExplicitRadix,
    isFloatType,
    isIntegerLiteral,
    isIntegerType,
    isMachineComparable,
    type LiteralCheck,
    literalDigits,
    type Operator,
    type OperatorInfo,
    OPERATORS,
    type Range,
    rangeOf,
    sameType,
    type WidthInfo,
    WIDTHS,
} from "./widths.ts";

export {
    classNameOf,
    contractOf,
    DEFAULT_ENUM_WIDTH,
    ENUM_UNDERLYING,
    enumUnderlying,
    enumUnderlyingSymbol,
    erase,
    ErasureError,
    type InterfaceMethod,
    isFloat,
    isInteger,
    isCStringType,
    isPointerType,
    isReferenceType,
    layoutKey,
    linalgStruct,
    linalgTypeOf,
    isSignedInteger,
    type MachineType,
    referentOf,
    renderType,
    scalarName,
    type ScalarName,
    type StructField,
    SCALARS,
} from "./types.ts";
