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
  | {
      /**
       * `CString`: a raw `const char *`. The borrowed half of the string pair,
       * and the type the compiler deliberately does not track.
       */
      readonly kind: "cstring";
    }
  | { readonly kind: "array"; readonly element: MachineType }
  | {
      /** `FixedArray<T, N>`: `N` elements, inline, no allocation. */
      readonly kind: "fixedArray";
      readonly element: MachineType;
      readonly length: number;
    }
  | {
      /**
       * `(a: i32) => i32` — a code address, and nothing else.
       *
       * One machine word, owning nothing, and **always classified by the C
       * rules**. That is not a simplification to be lifted later: a function
       * pointer's whole purpose is that both sides of a call agree about the
       * signature without sharing a declaration, and C's classification is the
       * only one anything outside this build knows. A function whose address
       * is taken is emitted C-classified for the same reason.
       *
       * There is no environment here. A capturing closure is a different type
       * with a different representation, and it is not implemented.
       */
      readonly kind: "fnptr";
      readonly params: readonly MachineType[];
      readonly returns: MachineType;
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
      /**
       * A C `union` — written `interface E extends Union`.
       *
       * A flag rather than a `kind` of its own, because a union is a struct
       * everywhere but the offsets: the same fields, the same projections, the
       * same nominal identity. Only the layout engine and the two rules that
       * differ (plain-data members, no object literal) read it.
       */
      readonly union?: boolean;
    }
  | {
      /**
       * `Reference<I>` for a *contract* — an interface carrying at least one
       * method signature. The two-word `(itab, data)` pair.
       *
       * A contract has no value form, so there is no separate `MachineType` for
       * one: `I` on its own is rejected, and this is what `Reference<I>` erases
       * to. An interface of pure data members is a `struct` and never reaches
       * here (DECISIONS §11.2).
       */
      readonly kind: "interface";
      readonly name: string;
      readonly methods: readonly InterfaceMethod[];
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
    }
  | {
      /**
       * A type declared elsewhere, whose layout this build does not know.
       *
       * `declare class FILE { private _opaque: never }` — C's incomplete type.
       * A `declare` says the implementation is somewhere else, and for a class
       * that means the *layout* is somewhere else too, so there is nothing here
       * to lay out and nothing to construct.
       *
       * It has no value form. The only thing it can appear as is the pointee of
       * a `Pointer<T>`, which is one machine word whatever it points at, and
       * every operation that would need the layout is refused with a code and a
       * line. The private member in the idiom above is tsc's business, not this
       * compiler's: it is what stops two handles converting to each other.
       */
      readonly kind: "opaque";
      readonly name: string;
    };

export interface StructField {
  readonly name: string;
  readonly type: MachineType;
}

/** One method of a contract, with the slot it dispatches through. */
export interface InterfaceMethod {
  readonly name: string;
  readonly params: readonly MachineType[];
  readonly returns: MachineType;
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

export function isCStringType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return brandedProperty(checker, type, "CStringBrand") !== null;
}

/**
 * Erase a `ts.Type`.
 *
 * Throws {@link ErasureError} rather than returning a diagnostic, because the
 * caller always has a node to attach and this function usually does not.
 */
export function erase(checker: ts.TypeChecker, type: ts.Type): MachineType {
  // `Reference<T> | null` — the result of `tryCast`, and the **only** union the
  // language has. It erases to the same machine type as `Reference<T>`, because
  // the null is representable inside the pair itself: a zero itab means "no".
  // So nullability stays entirely tsc's view of the program and reaches neither
  // the MIR nor the backend.
  //
  // Deliberately not a step toward general unions. Anything else with a `|` in
  // it falls through to the ordinary path and is refused.
  const nullable = nullableOf(checker, type);
  if (nullable !== null) return erase(checker, nullable);

  const flags = type.getFlags();

  if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return { kind: "void" };
  if (flags & ts.TypeFlags.BooleanLike) return { kind: "bool" };

  const scalar = scalarName(checker, type);
  if (scalar) return { kind: "scalar", name: scalar };

  // Before both `StringLike` and `NumberLike`, because an enum satisfies one or
  // the other and neither answer would be right: a numeric enum would become a
  // widthless `number`, and a *string* enum would quietly become a `string`,
  // which is the one that matters — it would compile, and lay out a heap handle
  // where a set of integer constants was meant.
  const enumWidth = enumUnderlying(checker, type);
  if (enumWidth !== null) return { kind: "scalar", name: enumWidth };

  // Before the `StringLike` check, because a `CString` is an interface and not
  // string-like — but before the object case too, so it never falls through to
  // structural erasure and becomes a nameless struct with a `length` field.
  if (brandedProperty(checker, type, "CStringBrand") !== null) {
    return { kind: "cstring" };
  }

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
  // Ambient first: a `declare class` is a handle whose layout lives in someone
  // else's build, and treating it as a class would ask this one to lay out
  // fields it cannot see.
  const opaqueName = ambientClassNameOf(type);
  if (opaqueName !== null) return { kind: "opaque", name: opaqueName };

  const className = classNameOf(type);
  if (className !== null) return { kind: "class", name: className };

  // `Reference<T>` and `Pointer<T>` are intersections — `T & ReferenceCore<T>`
  // — so without these they fall through to structural erasure and are reported
  // as a nameless aggregate called `Box & ReferenceCore<Box>`, which is a
  // confusing way to be told no. The lowerer *builds* references (every `this`
  // is one); what is missing is reading one back out of source.
  if (isReferenceType(checker, type)) {
    // `Reference<I>` where `I` is a contract is the one reference that *is*
    // implemented, because it is the only way to hold a contract at all. It
    // erases to the `(itab, data)` pair rather than to a reference-to-something.
    const referent = referentOf(checker, type);
    if (referent !== null) {
      // Before `contractOf`, which would look at `Array<T>`'s declaration and
      // see an interface holding both methods and a data member — the shape
      // that is rejected as ambiguous. `Array` is neither a shape nor a
      // contract; it is a built-in with its own representation, and the same
      // early check `erase` makes for a bare `T[]` has to happen here too.
      if (checker.isArrayType(referent)) {
        return { kind: "reference", referent: erase(checker, referent) };
      }

      const contract = contractOf(checker, referent);
      if (contract !== null) return contract;
      // `Reference<C>` for a class: one machine word holding the object's
      // address. This is how polymorphism travels — a `Reference<Base>` keeps
      // the dynamic type, where copying to a `Base` value would slice it.
      // A `Reference<T>` is bound once and dereferenced without asking, which
      // needs a layout to read through. An opaque handle has none, and the
      // type that carries an address you may only pass along is `Pointer<T>`.
      const opaqueReferent = ambientClassNameOf(referent);
      if (opaqueReferent !== null) {
        throw new ErasureError(
          `\`${opaqueReferent}\` is declared elsewhere, so this build does not ` +
            `know its layout and a \`Reference<${opaqueReferent}>\` has nothing ` +
            `to read through. Use \`Pointer<${opaqueReferent}>\`, which is an ` +
            "address and nothing more.",
          "GF0302",
        );
      }
      const className = classNameOf(referent);
      if (className !== null) {
        return { kind: "reference", referent: { kind: "class", name: className } };
      }
    }
    throw new ErasureError(
      "a `Reference<T>` cannot be written as a type yet, except for an " +
        "interface with methods. The compiler makes references — `this` inside " +
        "a method is one — but a parameter or a binding cannot be declared as " +
        "one. Pass the value itself for now; it is copied.",
      "GF0001",
    );
  }
  // `Pointer<T>`: a bare machine address. `T` exists only at compile time,
  // where it supplies the layout to read through and the stride for arithmetic.
  //
  // Spelled as an intersection — `T & CorePointer<T>` — so that `p.field` and
  // `p.method()` resolve without writing a dereference, which is the same
  // auto-dereference C++ spells `->`. The pointee is therefore one member of
  // the intersection rather than the type itself.
  if (isPointerType(checker, type)) {
    const pointee = pointeeOf(checker, type);
    if (pointee === null) {
      throw new ErasureError(
        "this `Pointer<T>` has no pointee type to read through.",
        "GF0001",
      );
    }
    return { kind: "pointer", pointee: erase(checker, pointee) };
  }

  // `T[]` and `Array<T>` are one type in TypeScript and one type here: the
  // language's `std::vector`. An owning, growable handle whose elements live
  // inline in a single heap buffer.
  //
  // Checked before the general object path, which would otherwise erase it to a
  // nameless aggregate called `Array` and lay the *interface's* members out as
  // fields.
  if (checker.isArrayType(type)) {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (element === undefined) {
      throw new ErasureError("this array has no element type.", "GF0001");
    }
    return { kind: "array", element: erase(checker, element) };
  }

  // `(a: i32) => i32` — a code address. Before `eraseObject`, which would see a
  // type with no properties and lay it out as an empty struct.
  //
  // One call signature and no properties, deliberately: a type with both is a
  // callable object, which needs an environment to be worth anything and is
  // therefore a closure rather than a function pointer.
  const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (calls.length > 0 && checker.getPropertiesOfType(type).length === 0) {
    if (calls.length > 1) {
      throw new ErasureError(
        "an overloaded function type has no single signature to point at. A " +
          "function pointer is one code address and one calling convention.",
        "GF0001",
      );
    }
    const signature = calls[0]!;
    if (signature.getTypeParameters()?.length) {
      throw new ErasureError(
        "a generic function type cannot be a function pointer: there is no one " +
          "body to take the address of.",
        "GF0001",
      );
    }
    return {
      kind: "fnptr",
      params: signature.getParameters().map((parameter) => {
        const declaration = parameter.valueDeclaration;
        if (declaration === undefined || !ts.isParameter(declaration)) {
          throw new ErasureError(
            "a parameter of this function type has no declaration to read a " +
              "type from.",
            "GF0001",
          );
        }
        if (declaration.questionToken || declaration.dotDotDotToken) {
          throw new ErasureError(
            "an optional or rest parameter has no C spelling, so it cannot be " +
              "part of a function pointer's signature.",
            "GF0001",
          );
        }
        return erase(checker, checker.getTypeAtLocation(declaration));
      }),
      returns: erase(checker, checker.getReturnTypeOfSignature(signature)),
    };
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
 * The name of an **ambient** class — one written `declare class` — or `null`.
 *
 * `declare` is TypeScript's word for "the implementation is elsewhere", and for
 * a class that means the layout is elsewhere too: there are no method bodies to
 * emit, no constructor to run, no field offsets that anything here could know.
 * So an ambient class is an opaque handle type rather than a class this
 * compiler lays out, and that is the whole rule — the `private _opaque: never`
 * in the idiom is what makes *tsc* keep two handles apart, and this compiler
 * never reads it.
 */
export function ambientClassNameOf(type: ts.Type): string | null {
  const symbol = type.getSymbol();
  if (symbol === undefined) return null;
  const declaration = symbol.declarations?.find(ts.isClassDeclaration);
  if (declaration === undefined || declaration.name === undefined) return null;
  const ambient = ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient;
  return ambient === 0 ? null : declaration.name.text;
}

/**
 * The non-null half of `X | null`, or `null` when the type is not that shape.
 *
 * Exactly one union is recognised, and only this one: `null` (or `undefined`,
 * which tsc folds in alongside it) with a single other member. A union of two
 * real types is not a thing this language has, and falls through to be refused
 * by whatever asked.
 */
export function nullableOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  if (!type.isUnion()) return null;
  const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined;
  const real = type.types.filter((part) => (part.getFlags() & nullish) === 0);
  if (real.length !== 1 || real.length === type.types.length) return null;
  return real[0] ?? null;
}

/** What a `Reference<T>` refers to, read off its brand, or `null`. */
/**
 * What a `Pointer<T>` points at.
 *
 * Read from the brand rather than from the intersection's other member, for the
 * same reason {@link referentOf} does: the brand carries `T` exactly, where the
 * intersection carries whatever `T` happened to widen to.
 */
export function pointeeOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  const brand = brandedProperty(checker, type, "PointerBrand");
  if (!brand) return null;
  return checker.getNonNullableType(checker.getTypeOfSymbol(brand));
}

export function referentOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  const brand = brandedProperty(checker, type, "ReferenceBrand");
  if (!brand) return null;
  return checker.getNonNullableType(checker.getTypeOfSymbol(brand));
}

/**
 * A *contract*, if this type is one: an interface carrying method signatures.
 *
 * DECISIONS §11.2 makes this decision **syntactic**, at the interface's own
 * declaration, and that is the whole of the rule:
 *
 * | Written | Is |
 * |---|---|
 * | `feed(): void` — a `MethodSignature` | a contract: dispatched, itab |
 * | `feed: () => void` — a `PropertySignature` of function type | a shape: an `FnPtr` field |
 *
 * They are different AST node kinds, so nothing is inferred from a type. Three
 * things support drawing the line here rather than anywhere else:
 *
 * * **tsc already agrees.** Under `strictFunctionTypes` method signatures are
 *   bivariant and function-typed properties are contravariant — TypeScript
 *   treats them as different things today, and this is the same seam.
 * * **JavaScript already agrees.** `feed() {}` in a class goes on the
 *   prototype: one copy, shared, looked up dynamically. `feed = () => {}` is an
 *   instance property. That is the vtable/field distinction exactly.
 * * **It keeps C's struct-of-callbacks.** A struct of function pointers is how
 *   a great deal of C API surface is shaped, and it stays a plain struct.
 *
 * A mixture is rejected rather than guessed at: an interface with both a method
 * and a data member would have to be a dispatched thing *and* a layout, and no
 * answer to that is better than the other two.
 */
export function contractOf(checker: ts.TypeChecker, type: ts.Type): MachineType | null {
  const properties = checker.getPropertiesOfType(type);
  const methods = properties.filter((property) =>
    property.declarations?.some(ts.isMethodSignature),
  );
  if (methods.length === 0) return null;

  const name = structNameOf(checker, type);
  if (methods.length !== properties.length) {
    const data = properties.find((property) => !methods.includes(property));
    throw new ErasureError(
      `\`${name}\` declares both methods and the data member \`${data?.name}\`. ` +
        "An interface is either a *shape* — data only, laid out as a struct — or " +
        "a *contract* — methods only, dispatched through an itable. One that is " +
        "both would have to be a layout and a dispatch table at once. Split it, " +
        "or make the data a method that returns it.",
      "GF0002",
    );
  }

  // Sorted by name, so a slot is a function of the method *set* rather than of
  // the declaration's source order: reordering the declaration is then not a
  // silent ABI change (DECISIONS §11.2).
  const sorted = [...methods].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    kind: "interface",
    name,
    methods: sorted.map((method) => {
      const declaration = method.declarations?.find(ts.isMethodSignature);
      const signature =
        declaration === undefined
          ? undefined
          : checker.getSignatureFromDeclaration(declaration);
      if (declaration === undefined || signature === undefined) {
        throw new ErasureError(
          `tsc could not give \`${name}.${method.name}\` a signature.`,
          "GF0001",
        );
      }
      return {
        name: method.name,
        params: declaration.parameters.map((parameter) =>
          erase(checker, checker.getTypeAtLocation(parameter)),
        ),
        returns: erase(checker, checker.getReturnTypeOfSignature(signature)),
      };
    }),
  };
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
  const isUnion = brandedProperty(checker, type, "UnionBrand") !== null;
  // A brand is a symbol-keyed marker, never a field: it says what the type *is*
  // and occupies nothing. `extends Union` is the first case where one reaches
  // here at all — every other branded type is recognised before this point —
  // and it would otherwise be laid out as an optional field of type `never`.
  const properties = checker
    .getPropertiesOfType(type)
    .filter((property) => !isBrand(property));
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
    // A `MethodSignature` makes this a *contract*, and a contract has no value
    // form — it is C++'s abstract base, which cannot be held by value either.
    // Reaching here means one was written where a layout was wanted, so the
    // message says how to hold one instead. See `contractOf` for why the line
    // is drawn at the AST node kind.
    if (declaration !== undefined && ts.isMethodSignature(declaration)) {
      // `contractOf` raises the better message when the interface is *mixed*,
      // and it has to be given the chance: telling someone to write
      // `Reference<Bad>` and then rejecting that too is two round trips for
      // one mistake.
      contractOf(checker, type);
      throw new ErasureError(
        `\`${name}\` declares the method \`${property.name}()\`, which makes it a ` +
          "*contract* rather than a plain shape — it has no layout, so it cannot " +
          `be a value, a field or a by-value parameter. Write \`Reference<${name}>\`, ` +
          "which is the two-word pair a contract is held through.\n\n" +
          "If dispatch was not what you wanted, a function-typed *property* — " +
          `\`${property.name}: () => …\` rather than \`${property.name}()\` — is an ` +
          "ordinary field holding a function pointer, and leaves this a struct.",
        "GF0002",
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
  return isUnion ? { kind: "struct", name, fields, union: true } : { kind: "struct", name, fields };
}

/** What an enum's width is called when nothing says otherwise. */
export const DEFAULT_ENUM_WIDTH: ScalarName = "i32";

/** The name a merged namespace uses to declare an enum's underlying type. */
export const ENUM_UNDERLYING = "Underlying";

/**
 * The declaration an enum's underlying type is written on, if there is one.
 *
 * TypeScript has no syntax for a C enum's underlying type, so it is declared by
 * merging a namespace into the enum:
 *
 *     enum SDL_EventType { Quit = 0x100 }
 *     declare namespace SDL_EventType { type Underlying = u32 }
 *
 * A *type* rather than a `const`, which is what keeps it out of the way: the
 * two are one symbol to tsc, so `SDL_EventType.Underlying` resolves in type
 * position and is checked like any other type reference — a typo is an ordinary
 * tsc error — while in value position it does not exist at all, so the enum's
 * members are the only thing an editor offers.
 *
 * Symbol merging does not care which half is written first, so the namespace
 * may precede the enum.
 */
export function enumUnderlyingSymbol(
  checker: ts.TypeChecker,
  type: ts.Type,
): ts.Symbol | undefined {
  const enumDeclaration = enumDeclarationOf(type);
  if (enumDeclaration === undefined) return undefined;
  const merged = checker.getSymbolAtLocation(enumDeclaration.name);
  return merged?.exports?.get(ENUM_UNDERLYING as ts.__String);
}

/** The enum a type belongs to, whether it is the enum itself or one member. */
function enumDeclarationOf(type: ts.Type): ts.EnumDeclaration | undefined {
  const declaration = type.getSymbol()?.declarations?.[0];
  if (declaration === undefined) return undefined;
  // A member (`E.A`) is an enum *literal*, and its symbol is the member's. The
  // enum carrying the declaration is its parent.
  if (ts.isEnumMember(declaration)) return declaration.parent;
  return ts.isEnumDeclaration(declaration) ? declaration : undefined;
}

/**
 * Whether any member of this enum is initialised with a string.
 *
 * TypeScript has string enums, and they are a perfectly reasonable thing to
 * write — they are just not lowered here yet, which is a different statement
 * from "the language refuses them". Asked of the members rather than of the
 * type, because a mixed enum is string-like in one member and numeric in the
 * next, and one string member is enough to make the whole thing not a set of
 * integers.
 */
function isStringEnum(checker: ts.TypeChecker, declaration: ts.EnumDeclaration): boolean {
  return declaration.members.some(
    (member) => typeof checker.getConstantValue(member) === "string",
  );
}

/**
 * The width behind an enum, or `null` if this type is not one.
 *
 * Defaults to {@link DEFAULT_ENUM_WIDTH}, because that is what a C enum is
 * unless the ABI says otherwise — so omitting the declaration is not an error,
 * it is the common case.
 */
export function enumUnderlying(
  checker: ts.TypeChecker,
  type: ts.Type,
): ScalarName | null {
  if ((type.getFlags() & ts.TypeFlags.EnumLike) === 0) return null;

  // A gap, not a rule. A string enum is implementable — its members would be
  // string constants, which the language already has — and it is the one way to
  // write named string constants while module-level `const` is unsupported.
  // What is missing is the lowering, so it is `GF0001` and says so.
  const declaration = enumDeclarationOf(type);
  if (declaration !== undefined && isStringEnum(checker, declaration)) {
    throw new ErasureError(
      `\`${declaration.name.text}\` is a string enum, and only integer enums are ` +
        "lowered so far. An integer enum takes its width from " +
        `\`declare namespace ${declaration.name.text} { type ${ENUM_UNDERLYING} = … }\`, ` +
        "and a string one would need no width at all — the members are string " +
        "constants — so the two are different lowerings rather than one with a " +
        "flag.",
      "GF0001",
    );
  }

  const declared = enumUnderlyingSymbol(checker, type);
  if (declared === undefined) return DEFAULT_ENUM_WIDTH;

  const name = scalarName(checker, checker.getDeclaredTypeOfSymbol(declared));
  if (name === null) {
    throw new ErasureError(
      `\`${ENUM_UNDERLYING}\` must be one of the integer widths — \`u8\`, \`i32\`, ` +
        "`u32` and so on. An enum is a set of integer constants, and this names " +
        "something that is not an integer.",
      "GF0166",
    );
  }
  if (isFloat(name)) {
    throw new ErasureError(
      `\`${ENUM_UNDERLYING}\` is \`${name}\`, and an enum holds integers. ` +
        "A floating-point enum has no meaning: its members are written as exact " +
        "constants and compared for equality.",
      "GF0166",
    );
  }
  return name;
}

/**
 * Whether a property is a brand rather than a field.
 *
 * A brand is symbol-keyed, which is what stops a source file from spelling it
 * and claiming a shape it does not have — and is also what makes it recognisable
 * here without a list of names to keep in step.
 */
function isBrand(property: ts.Symbol): boolean {
  const declaration = property.declarations?.[0] as ts.NamedDeclaration | undefined;
  const name = declaration?.name;
  return name !== undefined && ts.isComputedPropertyName(name);
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
    case "cstring":
      return "CString";
    case "array":
      return `${renderType(type.element)}[]`;
    case "fnptr":
      return `(${type.params.map(renderType).join(", ")}) => ${renderType(type.returns)}`;
    case "pointer":
      return `Pointer<${renderType(type.pointee)}>`;
    case "reference":
      return `Reference<${renderType(type.referent)}>`;
    case "struct":
    case "class":
    case "opaque":
      return type.name;
    case "interface":
      return `Reference<${type.name}>`;
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
