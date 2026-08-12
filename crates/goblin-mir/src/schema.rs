//! Reflection over the MIR type graph.
//!
//! REWRITE-PLAN §2: the MIR is defined once, in Rust, and the TypeScript side
//! is generated from it. v1's `protocol.ts` and `goblin-ir/src/lib.rs` had to
//! agree on every field name, every enum spelling and every `#[serde(rename)]`,
//! kept in step by hand — the README's own words, and a standing bug source.
//!
//! postcard is a *non-self-describing* format: field order is the wire order
//! and names never appear. That makes a hand-written encoder on the TypeScript
//! side strictly worse than v1's situation, not better — a reordered struct
//! field would produce a buffer that decodes into a different, valid-looking
//! module. So the encoder is generated too, from this graph, by
//! `src/bin/gen_bindings.rs`.
//!
//! Two invariants this module relies on:
//!
//! * **The graph is acyclic.** [`crate::Place`] is flat, so no type reaches
//!   itself. A cycle would make `SCHEMA` an infinitely recursive `const`, which
//!   would not compile in the first place — the guard below exists to make the
//!   failure legible rather than to prevent it.
//! * **Names are unique.** Two distinct Rust types sharing a name would collide
//!   in the generated bindings. [`check_unique_names`] is a test-time assertion
//!   of that.

use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

use postcard_schema::Schema;
use postcard_schema::schema::owned::{OwnedDataModelType, OwnedDataModelVariant, OwnedNamedType};

use crate::module::Module;

/// Every named type reachable from [`Module`], in a deterministic order:
/// dependencies before the types that use them.
///
/// Primitives (`u32`, `bool`, `String`, …) are not included — they have no
/// declaration to generate.
pub fn types() -> Vec<OwnedNamedType> {
    let root: OwnedNamedType = Module::SCHEMA.into();
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    let mut on_path = BTreeSet::new();
    visit(&root, &mut out, &mut seen, &mut on_path);
    out
}

fn visit(
    ty: &OwnedNamedType,
    out: &mut Vec<OwnedNamedType>,
    seen: &mut BTreeSet<String>,
    on_path: &mut BTreeSet<String>,
) {
    if !is_declared(&ty.ty) {
        // A primitive, or an anonymous shape like `Option<T>` / `Vec<T>` whose
        // *element* still needs visiting.
        for child in children(&ty.ty) {
            visit(child, out, seen, on_path);
        }
        return;
    }
    if seen.contains(&ty.name) {
        return;
    }
    assert!(
        on_path.insert(ty.name.clone()),
        "the MIR type graph is cyclic through `{}`; keep places flat so the \
         generated bindings stay finite",
        ty.name,
    );
    for child in children(&ty.ty) {
        visit(child, out, seen, on_path);
    }
    on_path.remove(&ty.name);
    seen.insert(ty.name.clone());
    out.push(ty.clone());
}

/// Whether this shape becomes a declaration in the generated bindings, as
/// opposed to being spelled inline at each use.
fn is_declared(dmt: &OwnedDataModelType) -> bool {
    matches!(
        dmt,
        OwnedDataModelType::Struct(_)
            | OwnedDataModelType::Enum(_)
            | OwnedDataModelType::NewtypeStruct(_)
            | OwnedDataModelType::TupleStruct(_)
            | OwnedDataModelType::UnitStruct
    )
}

/// The named types immediately referenced by a shape.
fn children(dmt: &OwnedDataModelType) -> Vec<&OwnedNamedType> {
    match dmt {
        OwnedDataModelType::Option(inner)
        | OwnedDataModelType::NewtypeStruct(inner)
        | OwnedDataModelType::Seq(inner) => vec![inner],
        OwnedDataModelType::Tuple(items) | OwnedDataModelType::TupleStruct(items) => {
            items.iter().collect()
        }
        OwnedDataModelType::Map { key, val } => vec![key, val],
        OwnedDataModelType::Struct(fields) => fields.iter().map(|f| &f.ty).collect(),
        OwnedDataModelType::Enum(variants) => variants
            .iter()
            .flat_map(|v| match &v.ty {
                OwnedDataModelVariant::UnitVariant => Vec::new(),
                OwnedDataModelVariant::NewtypeVariant(inner) => vec![&**inner],
                OwnedDataModelVariant::TupleVariant(items) => items.iter().collect(),
                OwnedDataModelVariant::StructVariant(fields) => {
                    fields.iter().map(|f| &f.ty).collect()
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// A canonical, order-sensitive rendering of the whole graph.
///
/// Order-sensitive is the point: postcard encodes struct fields and enum
/// variants positionally, so swapping two fields changes the wire format
/// without changing any name. This text has to notice that.
pub fn canonical_text() -> String {
    let mut buf = String::new();
    for ty in types() {
        buf.push_str(&ty.to_pseudocode());
        buf.push('\n');
    }
    buf
}

/// A fingerprint of the wire format.
///
/// Baked into the generated TypeScript and checked against
/// [`Module::schema_fingerprint`] on every decode. A prebuilt `.node` sitting
/// next to regenerated JavaScript is otherwise a silent, extremely confusing
/// failure.
///
/// Computed once. It is checked on every module, and walking, cloning and
/// re-rendering the whole type graph per module put a flat two milliseconds
/// under every compile before this cache existed — invisible on a small module
/// and still invisible on a large one, which is the kind of cost that never
/// gets found.
pub fn fingerprint() -> u64 {
    static CACHED: OnceLock<u64> = OnceLock::new();
    *CACHED.get_or_init(|| fnv1a(canonical_text().as_bytes()))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Assert that no two distinct types in the graph share a name.
pub fn check_unique_names() -> Result<(), String> {
    let mut by_name: HashMap<String, OwnedNamedType> = HashMap::new();
    for ty in types() {
        if let Some(previous) = by_name.insert(ty.name.clone(), ty.clone())
            && previous != ty
        {
            return Err(format!(
                "two different MIR types are both named `{}`; the generated \
                 bindings cannot tell them apart",
                ty.name
            ));
        }
    }
    Ok(())
}
