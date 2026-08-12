/**
 * Type erasure: `ts.Type` to a concrete, sized machine type.
 *
 * This is the only place that knows how the ambient prelude encodes machine
 * types, and it is the last place a `ts.Type` is seen. Everything downstream —
 * lowering, MIR, Cranelift — works with sized types and never asks tsc anything
 * again.
 *
 * The reading is done off the *brands*, not off the alias names. A type that
 * arrived through an alias chain or a generic instantiation is still recognised,
 * and — more to the point — the brand keys are `unique symbol`s, so no source
 * file can spell one and claim a width it does not have.
 */

import ts from "typescript";

/** The twelve fixed widths. */
export const SCALARS = [
  "i8",
  "i16",
  "i32",
  "i64",
  "u8",
  "u16",
  "u32",
  "u64",
  "f32",
  "f64",
  "isize",
  "usize",
] as const;

export type ScalarName = (typeof SCALARS)[number];

const SCALAR_SET: ReadonlySet<string> = new Set<string>(SCALARS);

/**
 * A machine type, erased.
 *
 * Deliberately *not* the MIR's `TyKind`: that one is generated from Rust and
 * carries ids into a module-level table, which is a thing the lowerer builds.
 * This is the shape tsc's answer takes on the way there.
 */
export type MachineType =
  | { readonly kind: "void" }
  | { readonly kind: "bool" }
  | { readonly kind: "scalar"; readonly name: ScalarName }
  | { readonly kind: "string" }
  | { readonly kind: "array"; readonly element: MachineType }
  | {
      /** `FixedArray<T, N>`: `N` elements, inline, no allocation. */
      readonly kind: "fixedArray";
      readonly element: MachineType;
      readonly length: number;
    }
  | { readonly kind: "pointer"; readonly pointee: MachineType }
  | { readonly kind: "reference"; readonly referent: MachineType }
  | {
      /**
       * A named aggregate. Fields are laid out in declaration order, naturally
       * aligned, never reordered, and nested aggregates are **inline** — the
       * bytes match what a C compiler produces for the same declaration.
       */
      readonly kind: "struct";
      readonly name: string;
      readonly fields: readonly StructField[];
    }
  | {
      /**
       * A class instance.
       *
       * Only the name is carried. Unlike a struct, a class has an *identity*
       * beyond its shape — two classes with the same fields are different
       * types, they have different vtables, and one is not assignable to the
       * other. The lowerer holds the fields, the base and the vtable in its own
       * registry, keyed by this name.
       */
      readonly kind: "class";
      readonly name: string;
    };

export interface StructField {
  readonly name: string;
  readonly type: MachineType;
}

/** Raised when a type is legal TypeScript but outside the language. */
export class ErasureError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly node?: ts.Node,
  ) {
    super(message);
    this.name = "ErasureError";
  }
}

/**
 * Find a property whose key is a particular `unique symbol`.
 *
 * A symbol-keyed property has no nameable name — TypeScript mangles it to
 * `__@Brand@<id>`, where the id shifts between builds. But the computed key is
 * still an expression, it resolves to the brand's symbol, and *that* is stable
 * and public. This is what makes an unforgeable brand readable from here.
 */
function brandedProperty(
  checker: ts.TypeChecker,
  type: ts.Type,
  brand: string,
): ts.Symbol | null {
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.declarations?.[0] as ts.NamedDeclaration | undefined;
    const name = declaration?.name;
    if (!name || !ts.isComputedPropertyName(name)) continue;
    if (checker.getSymbolAtLocation(name.expression)?.name === brand) return property;
  }
  return null;
}

/**
 * The width behind a type's `WidthBrand`, or `null` if it has none.
 *
 * All twelve widths share the one key and differ only in the string literal
 * behind it. That is load-bearing and is the thing most likely to be
 * "simplified": a *different* key per width would leave every brand optional
 * and *absent* from the others, optional-and-absent is assignable, and the
 * widths would silently unify.
 */
export function scalarName(checker: ts.TypeChecker, type: ts.Type): ScalarName | null {
  const brand = brandedProperty(checker, type, "WidthBrand");
  if (!brand) return null;

  const branded = checker.getNonNullableType(checker.getTypeOfSymbol(brand));
  if (branded.isStringLiteral() && SCALAR_SET.has(branded.value)) {
    return branded.value as ScalarName;
  }
  return null;
}

export function isPointerType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return brandedProperty(checker, type, "PointerBrand") !== null;
}

export function isReferenceType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return brandedProperty(checker, type, "ReferenceBrand") !== null;
}

/**
 * Erase a `ts.Type`.
 *
 * Throws {@link ErasureError} rather than returning a diagnostic, because the
 * caller always has a node to attach and this function usually does not.
 */
export function erase(checker: ts.TypeChecker, type: ts.Type): MachineType {
  const flags = type.getFlags();

  if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return { kind: "void" };
  if (flags & ts.TypeFlags.BooleanLike) return { kind: "bool" };

  const scalar = scalarName(checker, type);
  if (scalar) return { kind: "scalar", name: scalar };

  if (flags & ts.TypeFlags.StringLike) return { kind: "string" };

  // A bare `number` with no brand. tsc cannot tell us the width, which is the
  // hole the width pass exists to close — but at a position where a machine
  // type is needed and no annotation supplied one, there is nothing to infer
  // from and the honest answer is to say so.
  if (flags & ts.TypeFlags.NumberLike) {
    throw new ErasureError(
      "this value is a plain `number` with no fixed width. Annotate it with one " +
        "of the twelve widths (`i32`, `u8`, `f64`, …) so the machine type is " +
        "written down rather than guessed.",
      "GF0161",
    );
  }

  const fixed = fixedArrayOf(checker, type);
  if (fixed !== null) return fixed;

  // Before the object case, and before `isArrayType`: a class is nominal, so
  // it must not fall through to structural erasure and become an aggregate
  // that happens to have the same fields.
  const className = classNameOf(type);
  if (className !== null) return { kind: "class", name: className };

  // `Reference<T>` and `Pointer<T>` are intersections — `T & ReferenceCore<T>`
  // — so without these they fall through to structural erasure and are reported
  // as a nameless aggregate called `Box & ReferenceCore<Box>`, which is a
  // confusing way to be told no. The lowerer *builds* references (every `this`
  // is one); what is missing is reading one back out of source.
  if (isReferenceType(checker, type)) {
    throw new ErasureError(
      "a `Reference<T>` cannot be written as a type yet. The compiler makes " +
        "them — `this` inside a method is one — but a parameter or a binding " +
        "cannot be declared as one. Pass the value itself for now; it is copied.",
      "GF0001",
    );
  }
  if (isPointerType(checker, type)) {
    throw new ErasureError(
      "a `Pointer<T>` cannot be written as a type yet. It arrives with the " +
        "allocation intrinsics, which are not implemented.",
      "GF0001",
    );
  }

  // `T[]` is declared in the prelude and is the language's `std::vector` — an
  // owning, runtime-length array. It is not implemented, and saying so is the
  // point: without this it falls through to struct erasure and becomes a
  // nameless aggregate called `Array`, which is a confusing way to be told no.
  if (checker.isArrayType(type)) {
    throw new ErasureError(
      "`T[]` is not implemented yet. It is the owning, runtime-length array — " +
        "the `std::vector` of this language. For a length known at compile time " +
        "use `FixedArray<T, N>`, which allocates nothing; for a runtime length " +
        "use `allocArray<T>(n)` and release it with `freeArray()`.",
      "GF0001",
    );
  }

  if (flags & ts.TypeFlags.Object) return eraseObject(checker, type);

  throw new ErasureError(
    `\`${checker.typeToString(type)}\` has no machine representation yet.`,
    "GF0001",
  );
}

/**
 * The name of the class a type is an instance of, or `null`.
 *
 * Read off the declaration rather than off the shape, because a class is
 * **nominal** here even though TypeScript's assignability is structural: two
 * classes with identical fields have different vtables and different
 * identities, and one is not the other.
 */
export function classNameOf(type: ts.Type): string | null {
  const symbol = type.getSymbol();
  if (symbol === undefined) return null;
  const declaration = symbol.declarations?.find(ts.isClassDeclaration);
  return declaration?.name?.text ?? null;
}

/**
 * `FixedArray<T, N>`, read off its brand.
 *
 * The length comes from the brand's numeric literal type, the same way a width
 * comes from the `WidthBrand`'s string literal. The element type comes from the
 * index signature rather than from the brand, so an aliased or inferred `T`
 * still resolves.
 */
function fixedArrayOf(checker: ts.TypeChecker, type: ts.Type): MachineType | null {
  const brand = brandedProperty(checker, type, "FixedLengthBrand");
  if (!brand) return null;

  const length = checker.getNonNullableType(checker.getTypeOfSymbol(brand));
  if (!length.isNumberLiteral()) {
    throw new ErasureError(
      "a `FixedArray` needs a length known at compile time; this one's length " +
        "is not a literal.",
      "GF0001",
    );
  }
  if (length.value < 0 || !Number.isInteger(length.value)) {
    throw new ErasureError(
      `\`${length.value}\` is not a valid array length.`,
      "GF0164",
    );
  }

  const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (element === undefined) {
    throw new ErasureError("this `FixedArray` has no element type.", "GF0001");
  }
  return { kind: "fixedArray", element: erase(checker, element), length: length.value };
}

/**
 * An object type, as a struct.
 *
 * The *declaration order* of the properties is what tsc reports, and that is
 * the order the fields are laid out in — so two structurally identical types
 * whose fields are declared in a different order are different layouts, exactly
 * as they are in C.
 */
function eraseObject(checker: ts.TypeChecker, type: ts.Type): MachineType {
  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) {
    throw new ErasureError(
      "an object with no fields has no machine representation. A struct needs " +
        "at least one field; an empty one would occupy nothing and mean nothing.",
      "GF0001",
    );
  }

  const name = structNameOf(checker, type);
  const fields: StructField[] = [];
  for (const property of properties) {
    const declaration = property.declarations?.[0];
    // A `MethodSignature` — `feed(): void` — makes the interface a *contract*:
    // dispatched, with an itable, and usable only as `Reference<I>`. A
    // function-typed *property* — `feed: () => void` — is an ordinary field
    // holding a function pointer, and leaves this a plain struct. The two are
    // different AST nodes, which is what keeps the rule syntactic rather than
    // inferred (DECISIONS §11.2).
    if (declaration !== undefined && ts.isMethodSignature(declaration)) {
      throw new ErasureError(
        `\`${name}\` declares the method \`${property.name}()\`, which makes it a ` +
          "contract rather than a plain shape. Dispatched interfaces are not " +
          "implemented yet. Two things that do work today: a class, which has " +
          "methods and virtual dispatch; or a field holding a function pointer, " +
          `written \`${property.name}: () => …\` rather than \`${property.name}()\`.`,
        "GF0001",
      );
    }
    if ((property.flags & ts.SymbolFlags.Optional) !== 0) {
      throw new ErasureError(
        `\`${name}.${property.name}\` is optional. There is no \`undefined\` ` +
          "here for it to be, and no space in the layout for it not to be.",
        "GF0002",
      );
    }
    fields.push({
      name: property.name,
      type: erase(checker, checker.getTypeOfSymbol(property)),
    });
  }
  return { kind: "struct", name, fields };
}

/**
 * A name for a struct type.
 *
 * An `interface Point` or a `type Point = { … }` gives its own name. An inline
 * object type has none, so one is built from its shape — which is also what
 * makes two identical anonymous shapes the same struct rather than two.
 */
function structNameOf(checker: ts.TypeChecker, type: ts.Type): string {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const name = symbol?.getName();
  if (name !== undefined && name !== "__type" && name !== "__object") return name;
  return `{${checker
    .getPropertiesOfType(type)
    .map((property) => property.name)
    .join(",")}}`;
}

/** A human-readable spelling, for diagnostics. */
export function renderType(type: MachineType): string {
  switch (type.kind) {
    case "void":
      return "void";
    case "bool":
      return "boolean";
    case "scalar":
      return type.name;
    case "string":
      return "string";
    case "array":
      return `${renderType(type.element)}[]`;
    case "pointer":
      return `Pointer<${renderType(type.pointee)}>`;
    case "reference":
      return `Reference<${renderType(type.referent)}>`;
    case "struct":
    case "class":
      return type.name;
    case "fixedArray":
      return `FixedArray<${renderType(type.element)}, ${type.length}>`;
  }
}

/** Whether a scalar is one of the two floating-point widths. */
export function isFloat(name: ScalarName): boolean {
  return name === "f32" || name === "f64";
}

/** Whether a scalar is a signed integer. `f32`/`f64` are not integers at all. */
export function isSignedInteger(name: ScalarName): boolean {
  return name === "i8" || name === "i16" || name === "i32" || name === "i64" || name === "isize";
}

export function isInteger(name: ScalarName): boolean {
  return !isFloat(name);
}
