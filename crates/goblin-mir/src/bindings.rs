//! Generates the TypeScript side of the napi boundary from the Rust MIR.
//!
//! Output: `packages/backend/js/mir.generated.ts`, containing
//!
//! * a TypeScript type for every MIR type,
//! * a postcard encoder for every one of them,
//! * the wire-format fingerprint the encoder was generated from.
//!
//! The encoder is generated rather than written because postcard is not
//! self-describing. Field order *is* the wire format, so a hand-written
//! encoder that drifts by one field produces a buffer which decodes cleanly
//! into a different, entirely plausible module. That is worse than v1's
//! hand-synced JSON protocol, not better.
//!
//! Run with `cargo run -p goblin-mir --bin gen-bindings`, or
//! `bun run --cwd packages/backend bindings`.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use postcard_schema::schema::owned::{OwnedDataModelType, OwnedDataModelVariant, OwnedNamedType};

use crate::schema;

/// The discriminant property of every generated tagged union.
const TAG: &str = "kind";

/// Where the generated bindings live, relative to the repository root.
pub const OUTPUT_PATH: &str = "packages/backend/js/mir.generated.ts";

/// Generate the bindings and write them, reporting whether anything changed.
pub fn write() -> Result<Outcome, Box<dyn std::error::Error>> {
    schema::check_unique_names()?;
    check_no_tag_collisions()?;
    check_no_camel_case_collisions()?;

    let out = repo_root().join(OUTPUT_PATH);
    let text = generate();

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Only rewrite when the content actually changed, so an unchanged
    // regeneration does not churn file timestamps and re-trigger watchers.
    if std::fs::read_to_string(&out).is_ok_and(|existing| existing == text) {
        return Ok(Outcome {
            path: out,
            changed: false,
        });
    }
    std::fs::write(&out, &text)?;
    Ok(Outcome {
        path: out,
        changed: true,
    })
}

/// What [`write`] did.
pub struct Outcome {
    pub path: PathBuf,
    pub changed: bool,
}

/// The repository root, derived from this crate's location.
pub fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is `<root>/crates/goblin-mir`.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two directories below the repository root")
        .to_path_buf()
}

/// A Rust struct variant whose field is called `kind` would generate a
/// TypeScript member that collides with the discriminant, producing an
/// interface with two incompatible `kind` properties. That is a confusing
/// failure several steps removed from its cause, so catch it here and say what
/// to rename.
fn check_no_tag_collisions() -> Result<(), String> {
    for ty in schema::types() {
        let OwnedDataModelType::Enum(variants) = &ty.ty else {
            continue;
        };
        for variant in variants {
            let OwnedDataModelVariant::StructVariant(fields) = &variant.ty else {
                continue;
            };
            for field in fields {
                if camel(&field.name) == TAG {
                    return Err(format!(
                        "`{}::{}` has a field named `{}`, which collides with the \
                         discriminant of the generated tagged union. Rename the \
                         Rust field — `op` is the convention here.",
                        ty.name, variant.name, field.name,
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Two Rust fields that differ only in underscores would become one TypeScript
/// property, and postcard's positional encoding means the loss would be silent.
fn check_no_camel_case_collisions() -> Result<(), String> {
    let check = |owner: &str, names: Vec<&String>| -> Result<(), String> {
        let mut seen: HashMap<String, &String> = HashMap::new();
        for name in names {
            if let Some(previous) = seen.insert(camel(name), name)
                && previous != name
            {
                return Err(format!(
                    "`{owner}` has fields `{previous}` and `{name}`, which both \
                     become `{}` in TypeScript",
                    camel(name),
                ));
            }
        }
        Ok(())
    };

    for ty in schema::types() {
        match &ty.ty {
            OwnedDataModelType::Struct(fields) => {
                check(&ty.name, fields.iter().map(|f| &f.name).collect())?;
            }
            OwnedDataModelType::Enum(variants) => {
                for variant in variants {
                    if let OwnedDataModelVariant::StructVariant(fields) = &variant.ty {
                        let owner = format!("{}::{}", ty.name, variant.name);
                        check(&owner, fields.iter().map(|f| &f.name).collect())?;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// --------------------------------------------------------------------------
// Naming
// --------------------------------------------------------------------------

/// Rust `snake_case` to TypeScript `camelCase`.
///
/// Both sides of the boundary are generated, so this rename costs nothing and
/// keeps the frontend reading like TypeScript rather than like Rust.
fn camel(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper_next = false;
    for ch in name.chars() {
        if ch == '_' {
            upper_next = true;
        } else if upper_next {
            out.extend(ch.to_uppercase());
            upper_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Whether a type is one of the `u32` newtype ids, which get a brand.
fn is_id(ty: &OwnedNamedType) -> bool {
    matches!(&ty.ty, OwnedDataModelType::NewtypeStruct(inner) if matches!(inner.ty, OwnedDataModelType::U32))
        && ty.name.ends_with("Id")
}

/// The TypeScript spelling of a type at a use site.
fn ts_type(ty: &OwnedNamedType) -> String {
    match &ty.ty {
        OwnedDataModelType::Bool => "boolean".into(),
        OwnedDataModelType::I8
        | OwnedDataModelType::I16
        | OwnedDataModelType::I32
        | OwnedDataModelType::U8
        | OwnedDataModelType::U16
        | OwnedDataModelType::U32
        | OwnedDataModelType::F32
        | OwnedDataModelType::F64 => "number".into(),
        // Anything 64 bits or wider is a `bigint`: an f64 cannot hold a u64
        // without silently rounding, and these carry *bit patterns*, where a
        // rounded value is not a slightly wrong number but a different one.
        OwnedDataModelType::I64
        | OwnedDataModelType::U64
        | OwnedDataModelType::I128
        | OwnedDataModelType::U128 => "bigint".into(),
        OwnedDataModelType::String | OwnedDataModelType::Char => "string".into(),
        OwnedDataModelType::ByteArray => "Uint8Array".into(),
        OwnedDataModelType::Unit | OwnedDataModelType::UnitStruct => "null".into(),
        OwnedDataModelType::Option(inner) => format!("{} | null", ts_type(inner)),
        OwnedDataModelType::Seq(inner) => {
            if matches!(inner.ty, OwnedDataModelType::U8) {
                // `Vec<u8>` encodes byte-for-byte the same as a byte array, so
                // the nicer and faster TypeScript type is free.
                "Uint8Array".into()
            } else {
                let element = ts_type(inner);
                if element.contains(' ') {
                    format!("({element})[]")
                } else {
                    format!("{element}[]")
                }
            }
        }
        OwnedDataModelType::Tuple(items) => {
            let parts: Vec<_> = items.iter().map(ts_type).collect();
            format!("[{}]", parts.join(", "))
        }
        // Everything else is a declared type, referred to by name.
        _ => ty.name.clone(),
    }
}

/// Whether an enum has only unit variants, in which case it becomes a plain
/// string union rather than a tagged object.
fn is_string_enum(variants: &[postcard_schema::schema::owned::OwnedNamedVariant]) -> bool {
    variants
        .iter()
        .all(|v| matches!(v.ty, OwnedDataModelVariant::UnitVariant))
}

// --------------------------------------------------------------------------
// Generation
// --------------------------------------------------------------------------

/// The full text of the generated TypeScript module.
pub fn generate() -> String {
    let types = schema::types();
    let mut out = String::new();

    header(&mut out);
    writer_runtime(&mut out);

    out.push_str(
        "// ---------------------------------------------------------------------------\n",
    );
    out.push_str("// Types\n");
    out.push_str(
        "// ---------------------------------------------------------------------------\n\n",
    );

    out.push_str(BRAND_DECL);

    for ty in &types {
        emit_type(&mut out, ty);
    }

    out.push_str(
        "// ---------------------------------------------------------------------------\n",
    );
    out.push_str("// Encoders\n");
    out.push_str(
        "// ---------------------------------------------------------------------------\n\n",
    );

    for ty in &types {
        emit_encoder(&mut out, ty);
    }

    out.push_str(
        "/** Encode a module for the trip across the napi boundary. */\n\
         export function encodeModule(module: Module): Uint8Array {\n\
         \x20 const w = new Writer();\n\
         \x20 writeModule(w, module);\n\
         \x20 return w.finish();\n\
         }\n",
    );

    out
}

fn header(out: &mut String) {
    let fingerprint = schema::fingerprint();
    out.push_str(
        "// @generated by `cargo run -p goblin-mir --bin gen-bindings`. DO NOT EDIT.\n\
         //\n\
         // The MIR is defined once, in Rust, in crates/goblin-mir. This file is that\n\
         // definition projected into TypeScript, encoder included.\n\
         //\n\
         // postcard is not self-describing: struct fields and enum variants are\n\
         // positional, and no name ever reaches the wire. That is why the encoder is\n\
         // generated too. A hand-written one that drifted by a single field would not\n\
         // fail to decode — it would decode into a different, perfectly plausible\n\
         // module, which is the failure mode this whole arrangement exists to remove.\n\n",
    );
    let _ = writeln!(
        out,
        "/** Fingerprint of the wire format these bindings were generated from. */\n\
         export const SCHEMA_FINGERPRINT = 0x{fingerprint:016x}n;\n\n\
         /** The same value as hex, for comparing against the addon's report. */\n\
         export const SCHEMA_FINGERPRINT_HEX = \"{fingerprint:016x}\";\n",
    );
}

const BRAND_DECL: &str = "\
/**
 * One brand key, one string literal per id type.
 *
 * The same trick the language's own fixed-width types use (REWRITE-PLAN §7),
 * and for the same reason: a distinct key per id would leave every brand
 * optional-and-absent from the others, and optional-and-absent is assignable,
 * so the ids would silently unify. Here the brand is *required* rather than
 * optional, because ids come from builders rather than from literals — there is
 * no `const x: LocalId = 3` to keep readable, and a raw `number` slipping into
 * an id position is exactly the mistake worth catching.
 */
declare const GfIdBrand: unique symbol;

";

fn writer_runtime(out: &mut String) {
    out.push_str(WRITER_RUNTIME);
}

const WRITER_RUNTIME: &str = r#"// ---------------------------------------------------------------------------
// postcard writer
// ---------------------------------------------------------------------------

const UTF8 = new TextEncoder();

/**
 * A growable little-endian byte sink implementing postcard's primitive
 * encodings: LEB128 varints for anything wider than a byte, zigzag for signed
 * values, raw IEEE-754 bytes for floats, and a varint length prefix for
 * anything with a length.
 */
export class Writer {
  #buf: Uint8Array;
  #view: DataView;
  #len = 0;

  constructor(capacity = 1 << 16) {
    this.#buf = new Uint8Array(capacity);
    this.#view = new DataView(this.#buf.buffer);
  }

  #reserve(extra: number): void {
    const needed = this.#len + extra;
    if (needed <= this.#buf.length) return;
    let capacity = this.#buf.length * 2;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#buf.subarray(0, this.#len));
    this.#buf = grown;
    this.#view = new DataView(grown.buffer);
  }

  u8(value: number): void {
    this.#reserve(1);
    this.#buf[this.#len++] = value & 0xff;
  }

  i8(value: number): void {
    this.u8(value < 0 ? value + 0x100 : value);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  /** LEB128, for u16/u32 and anything that fits an f64 exactly. */
  varint(value: number): void {
    this.#reserve(5);
    let rest = value >>> 0;
    while (rest > 0x7f) {
      this.#buf[this.#len++] = (rest & 0x7f) | 0x80;
      rest >>>= 7;
    }
    this.#buf[this.#len++] = rest;
  }

  /** LEB128 over a bigint, for the 64- and 128-bit widths. */
  varintBig(value: bigint): void {
    this.#reserve(19);
    let rest = value;
    while (rest > 0x7fn) {
      this.#buf[this.#len++] = Number(rest & 0x7fn) | 0x80;
      rest >>= 7n;
    }
    this.#buf[this.#len++] = Number(rest);
  }

  /** Zigzag then varint, which is how postcard encodes signed integers. */
  varintSigned(value: number, bits: number): void {
    const shifted = value < 0 ? -value * 2 - 1 : value * 2;
    if (bits <= 32) this.varint(shifted);
    else this.varintBig(BigInt(shifted));
  }

  varintSignedBig(value: bigint): void {
    this.varintBig(value < 0n ? -value * 2n - 1n : value * 2n);
  }

  f32(value: number): void {
    this.#reserve(4);
    this.#view.setFloat32(this.#len, value, true);
    this.#len += 4;
  }

  f64(value: number): void {
    this.#reserve(8);
    this.#view.setFloat64(this.#len, value, true);
    this.#len += 8;
  }

  bytes(value: Uint8Array): void {
    this.varint(value.length);
    this.#reserve(value.length);
    this.#buf.set(value, this.#len);
    this.#len += value.length;
  }

  str(value: string): void {
    // encodeInto avoids the intermediate array for the common ASCII case, but
    // needs room for the worst case before the length is known, so measure
    // first for anything long enough for the difference to matter.
    const encoded = UTF8.encode(value);
    this.bytes(encoded);
  }

  finish(): Uint8Array {
    return this.#buf.subarray(0, this.#len);
  }

  get length(): number {
    return this.#len;
  }
}

"#;

fn emit_type(out: &mut String, ty: &OwnedNamedType) {
    let name = &ty.name;
    match &ty.ty {
        OwnedDataModelType::NewtypeStruct(_) if is_id(ty) => {
            let _ = writeln!(
                out,
                "export type {name} = number & {{ readonly [GfIdBrand]: \"{name}\" }};\n\
                 export const {name} = (raw: number): {name} => raw as {name};\n",
            );
        }
        OwnedDataModelType::NewtypeStruct(inner) => {
            let _ = writeln!(out, "export type {name} = {};\n", ts_type(inner));
        }
        OwnedDataModelType::UnitStruct => {
            let _ = writeln!(out, "export type {name} = null;\n");
        }
        OwnedDataModelType::TupleStruct(items) => {
            let parts: Vec<_> = items.iter().map(ts_type).collect();
            let _ = writeln!(out, "export type {name} = [{}];\n", parts.join(", "));
        }
        OwnedDataModelType::Struct(fields) => {
            let _ = writeln!(out, "export interface {name} {{");
            for field in fields {
                let _ = writeln!(out, "  {}: {};", camel(&field.name), ts_type(&field.ty));
            }
            out.push_str("}\n\n");
        }
        OwnedDataModelType::Enum(variants) if is_string_enum(variants) => {
            let arms: Vec<String> = variants.iter().map(|v| format!("\"{}\"", v.name)).collect();
            let _ = writeln!(out, "export type {name} =\n  | {};\n", arms.join("\n  | "));
        }
        OwnedDataModelType::Enum(variants) => {
            let _ = writeln!(out, "export type {name} =");
            for variant in variants {
                let body = match &variant.ty {
                    OwnedDataModelVariant::UnitVariant => String::new(),
                    OwnedDataModelVariant::NewtypeVariant(inner) => {
                        format!("; value: {}", ts_type(inner))
                    }
                    OwnedDataModelVariant::TupleVariant(items) => {
                        let parts: Vec<_> = items.iter().map(ts_type).collect();
                        if parts.len() == 1 {
                            format!("; value: {}", parts[0])
                        } else {
                            format!("; fields: [{}]", parts.join(", "))
                        }
                    }
                    OwnedDataModelVariant::StructVariant(fields) => {
                        let mut body = String::new();
                        for field in fields {
                            let _ =
                                write!(body, "; {}: {}", camel(&field.name), ts_type(&field.ty));
                        }
                        body
                    }
                };
                let _ = writeln!(out, "  | {{ {TAG}: \"{}\"{body} }}", variant.name);
            }
            out.push_str(";\n\n");
        }
        _ => {}
    }
}

fn emit_encoder(out: &mut String, ty: &OwnedNamedType) {
    let name = &ty.name;
    let fn_name = format!("write{name}");
    match &ty.ty {
        OwnedDataModelType::NewtypeStruct(inner) => {
            let _ = writeln!(
                out,
                "export function {fn_name}(w: Writer, v: {name}): void {{"
            );
            let _ = writeln!(out, "  {}", write_value(inner, "v"));
            out.push_str("}\n\n");
        }
        OwnedDataModelType::UnitStruct => {
            let _ = writeln!(
                out,
                "export function {fn_name}(_w: Writer, _v: {name}): void {{}}\n"
            );
        }
        OwnedDataModelType::TupleStruct(items) => {
            let _ = writeln!(
                out,
                "export function {fn_name}(w: Writer, v: {name}): void {{"
            );
            for (index, item) in items.iter().enumerate() {
                let _ = writeln!(out, "  {}", write_value(item, &format!("v[{index}]")));
            }
            out.push_str("}\n\n");
        }
        OwnedDataModelType::Struct(fields) => {
            let _ = writeln!(
                out,
                "export function {fn_name}(w: Writer, v: {name}): void {{"
            );
            for field in fields {
                let access = format!("v.{}", camel(&field.name));
                let _ = writeln!(out, "  {}", write_value(&field.ty, &access));
            }
            out.push_str("}\n\n");
        }
        OwnedDataModelType::Enum(variants) if is_string_enum(variants) => {
            let _ = writeln!(out, "const {name}Index: Record<{name}, number> = {{");
            for (index, variant) in variants.iter().enumerate() {
                let _ = writeln!(out, "  {}: {index},", variant.name);
            }
            out.push_str("};\n\n");
            let _ = writeln!(
                out,
                "export function {fn_name}(w: Writer, v: {name}): void {{\n\
                 \x20 w.varint({name}Index[v]);\n\
                 }}\n"
            );
        }
        OwnedDataModelType::Enum(variants) => {
            let _ = writeln!(
                out,
                "export function {fn_name}(w: Writer, v: {name}): void {{"
            );
            let _ = writeln!(out, "  switch (v.{TAG}) {{");
            for (index, variant) in variants.iter().enumerate() {
                let _ = writeln!(out, "    case \"{}\": {{", variant.name);
                let _ = writeln!(out, "      w.varint({index});");
                match &variant.ty {
                    OwnedDataModelVariant::UnitVariant => {}
                    OwnedDataModelVariant::NewtypeVariant(inner) => {
                        let _ = writeln!(out, "      {}", write_value(inner, "v.value"));
                    }
                    OwnedDataModelVariant::TupleVariant(items) => {
                        if items.len() == 1 {
                            let _ = writeln!(out, "      {}", write_value(&items[0], "v.value"));
                        } else {
                            for (position, item) in items.iter().enumerate() {
                                let access = format!("v.fields[{position}]");
                                let _ = writeln!(out, "      {}", write_value(item, &access));
                            }
                        }
                    }
                    OwnedDataModelVariant::StructVariant(fields) => {
                        for field in fields {
                            let access = format!("v.{}", camel(&field.name));
                            let _ = writeln!(out, "      {}", write_value(&field.ty, &access));
                        }
                    }
                }
                out.push_str("      break;\n    }\n");
            }
            out.push_str("  }\n}\n\n");
        }
        _ => {}
    }
}

/// A statement writing `access` according to `ty`.
fn write_value(ty: &OwnedNamedType, access: &str) -> String {
    match &ty.ty {
        OwnedDataModelType::Bool => format!("w.bool({access});"),
        OwnedDataModelType::U8 => format!("w.u8({access});"),
        OwnedDataModelType::I8 => format!("w.i8({access});"),
        OwnedDataModelType::U16 | OwnedDataModelType::U32 => format!("w.varint({access});"),
        OwnedDataModelType::I16 => format!("w.varintSigned({access}, 16);"),
        OwnedDataModelType::I32 => format!("w.varintSigned({access}, 32);"),
        OwnedDataModelType::U64 | OwnedDataModelType::U128 => {
            format!("w.varintBig({access});")
        }
        OwnedDataModelType::I64 | OwnedDataModelType::I128 => {
            format!("w.varintSignedBig({access});")
        }
        OwnedDataModelType::F32 => format!("w.f32({access});"),
        OwnedDataModelType::F64 => format!("w.f64({access});"),
        OwnedDataModelType::String | OwnedDataModelType::Char => format!("w.str({access});"),
        OwnedDataModelType::ByteArray => format!("w.bytes({access});"),
        OwnedDataModelType::Unit | OwnedDataModelType::UnitStruct => String::new(),
        OwnedDataModelType::Option(inner) => {
            let some = write_value(inner, &format!("{access}!"));
            format!("if ({access} === null) {{ w.u8(0); }} else {{ w.u8(1); {some} }}")
        }
        OwnedDataModelType::Seq(inner) => {
            if matches!(inner.ty, OwnedDataModelType::U8) {
                format!("w.bytes({access});")
            } else {
                let element = write_value(inner, "item");
                format!("w.varint({access}.length); for (const item of {access}) {{ {element} }}")
            }
        }
        OwnedDataModelType::Tuple(items) => {
            let mut parts = Vec::new();
            for (index, item) in items.iter().enumerate() {
                parts.push(write_value(item, &format!("{access}[{index}]")));
            }
            parts.join(" ")
        }
        _ => format!("write{}(w, {access});", ty.name),
    }
}
