//! MIR types as LLVM types.
//!
//! **Every aggregate is emitted packed, with its padding spelled out.** LLVM is
//! perfectly capable of laying out a `{ i32, i64 }` itself, and letting it would
//! mean two layout engines in one compiler that agree until the day they do not
//! — a disagreement whose symptom is a field read from the wrong offset, which
//! is REWRITE-PLAN §5.2's whole subject and §17's warning about silent
//! miscompiles in one place.
//!
//! So `Layouts` stays the only answer to where a field sits, and the LLVM type
//! is written to match it by construction: `<{ i32, [4 x i8], i64 }>`. A packed
//! struct has alignment 1 as far as LLVM is concerned, which is why every use —
//! `alloca`, `byval`, `sret`, `load`, `store` — carries an explicit `align`.

use std::collections::{HashMap, HashSet};

use goblin_mir::{TyId, TyKind};

use crate::error::Result;
use crate::internal_error;
use crate::layout::{Layouts, Repr, Scalar};

/// A scalar as LLVM spells it.
///
/// [`Scalar::Ptr`] is `ptr` and nothing else. LLVM's pointers have been opaque
/// since 15, so an address is not an `i64` that happens to be wide enough —
/// which is exactly the distinction `layout.rs` exists to record.
pub fn scalar(value: Scalar) -> &'static str {
    match value {
        Scalar::I8 => "i8",
        Scalar::I16 => "i16",
        Scalar::I32 => "i32",
        Scalar::I64 => "i64",
        Scalar::F32 => "float",
        Scalar::F64 => "double",
        Scalar::Ptr => "ptr",
    }
}

/// An LLVM identifier, quoted when it has to be.
///
/// LLVM takes `[-a-zA-Z$._][-a-zA-Z$._0-9]*` bare — which covers the `$` in
/// `__gf_vt$Dog` — and anything else has to be quoted. A name is never
/// *rewritten*, because a symbol's spelling is what the linker matches on.
pub fn ident(name: &str) -> String {
    let plain = !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '$' | '.' | '_'));
    if plain {
        return name.to_owned();
    }
    let mut out = String::with_capacity(name.len() + 2);
    out.push('"');
    for byte in name.bytes() {
        match byte {
            b'"' => out.push_str("\\22"),
            b'\\' => out.push_str("\\5C"),
            0x20..=0x7e => out.push(byte as char),
            other => out.push_str(&format!("\\{other:02X}")),
        }
    }
    out.push('"');
    out
}

/// One element of an aggregate's packed body.
///
/// Extracted so that the LLVM *type* and a constant *initialiser* for that type
/// are two renderings of one walk rather than two walks. They have to agree
/// element for element — an initialiser whose padding sat one slot from the
/// type's would not fail to compile, it would place a field's bytes in the
/// padding — and this file's whole premise is that a layout described twice is
/// described differently eventually.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Element {
    /// Padding before the next field, or the trailing padding that makes the
    /// LLVM type's size equal `Layout::size`.
    Padding(u32),
    /// A class's vtable pointer, at offset zero and not a declared field.
    VtablePtr,
    Field(TyId),
    /// A union: every member starts at zero, so there is no sequence of elements
    /// that describes it and bytes are the honest answer.
    Bytes(u32),
}

/// The packed element sequence of an aggregate, padding included.
pub fn elements(layouts: &mut Layouts<'_>, ty: TyId) -> Result<Vec<Element>> {
    let layout = layouts.layout(ty)?;
    let module = layouts.module();
    let Some(def) = module.ty(ty) else {
        internal_error!("type {} is not in the module's type table", ty.0);
    };

    let (fields, mut at, vtable) = match &def.kind {
        // Two words at fixed offsets: the itab and the data pointer.
        TyKind::Interface(_) => return Ok(vec![Element::VtablePtr, Element::VtablePtr]),
        TyKind::Struct(id) => {
            let Some(strukt) = module.strukt(*id) else {
                internal_error!("struct {} is missing", id.0);
            };
            if strukt.union {
                return Ok(vec![Element::Bytes(layout.size)]);
            }
            (strukt.fields.iter().map(|f| f.ty).collect::<Vec<_>>(), 0u32, false)
        }
        TyKind::Class(id) => {
            let Some(class) = module.class(*id) else {
                internal_error!("class {} is missing", id.0);
            };
            (
                class.fields.iter().map(|f| f.ty).collect::<Vec<_>>(),
                layouts.target().pointer_bytes,
                true,
            )
        }
        _ => internal_error!("type {} has no aggregate body", ty.0),
    };

    let mut out: Vec<Element> = Vec::with_capacity(fields.len() + 2);
    if vtable {
        out.push(Element::VtablePtr);
    }
    for (index, field) in fields.iter().enumerate() {
        let offset = layout.fields.get(index).copied().unwrap_or(at);
        if offset > at {
            out.push(Element::Padding(offset - at));
        }
        out.push(Element::Field(*field));
        at = offset + layouts.layout(*field)?.size;
    }
    if layout.size > at {
        out.push(Element::Padding(layout.size - at));
    }
    Ok(out)
}

/// The tail padding each element of a fixed array carries.
///
/// A stride wider than the element means C-style tail padding, and the array has
/// to carry it or every index past the first is wrong.
pub fn array_padding(layouts: &mut Layouts<'_>, element: TyId) -> Result<u32> {
    let layout = layouts.layout(element)?;
    Ok(layout.stride() - layout.size)
}

/// The named aggregate types a module needs, built as they are asked for.
#[derive(Default)]
pub struct Types {
    named: HashMap<TyId, String>,
    used: HashSet<String>,
    /// `%struct.Point = type <{ … }>` lines, inner types before outer.
    definitions: Vec<String>,
}

impl Types {
    pub fn new() -> Types {
        Types::default()
    }

    /// The lines defining every named type, in dependency order.
    pub fn definitions(&self) -> &[String] {
        &self.definitions
    }

    /// The LLVM type text for `ty`, defining whatever it needs on the way.
    pub fn of(&mut self, layouts: &mut Layouts<'_>, ty: TyId) -> Result<String> {
        match layouts.repr(ty)? {
            Repr::Void => Ok("void".into()),
            Repr::Register(value) => Ok(scalar(value).into()),
            Repr::Vector { elem, lanes } => Ok(format!("<{lanes} x {}>", scalar(elem))),
            Repr::Aggregate => self.aggregate(layouts, ty),
        }
    }

    /// The name of an aggregate's type, for `byval(…)` and `sret(…)`.
    ///
    /// Separate from [`Types::of`] only to say at the call site that an
    /// aggregate is what was expected; reaching it with a scalar is a bug in
    /// the caller rather than something to render.
    pub fn aggregate(&mut self, layouts: &mut Layouts<'_>, ty: TyId) -> Result<String> {
        let module = layouts.module();
        let Some(def) = module.ty(ty) else {
            internal_error!("type {} is not in the module's type table", ty.0);
        };

        // An array is structural, not named: `[4 x i32]` says everything about
        // it, and naming it would just be one more thing to keep unique.
        if let TyKind::FixedArray { element, length } = &def.kind {
            let element_ty = self.of(layouts, *element)?;
            let padding = array_padding(layouts, *element)?;
            if padding == 0 {
                return Ok(format!("[{length} x {element_ty}]"));
            }
            return Ok(format!("[{length} x <{{ {element_ty}, [{padding} x i8] }}>]"));
        }

        if let Some(name) = self.named.get(&ty) {
            return Ok(name.clone());
        }

        let (prefix, base) = match &def.kind {
            TyKind::Struct(id) => (
                "struct",
                module
                    .strukt(*id)
                    .and_then(|def| module.sym(def.name))
                    .unwrap_or("anon"),
            ),
            TyKind::Class(id) => (
                "class",
                module
                    .class(*id)
                    .and_then(|def| module.sym(def.name))
                    .unwrap_or("anon"),
            ),
            TyKind::Interface(id) => (
                "iface",
                module
                    .interface(*id)
                    .and_then(|def| module.sym(def.name))
                    .unwrap_or("anon"),
            ),
            _ => internal_error!(
                "`{}` is not an aggregate and has no named LLVM type",
                crate::layout::render_type(module, ty)
            ),
        };

        let name = self.unique(&format!("%{prefix}.{}", ident(base)));
        // Registered *before* the body is built, so a self-referential shape
        // would terminate rather than recurse. Nothing can contain itself by
        // value today; this costs one line and stops that from being a
        // stack overflow if it ever can.
        self.named.insert(ty, name.clone());

        let body = self.body(layouts, ty)?;
        self.definitions.push(format!("{name} = type {body}"));
        Ok(name)
    }

    fn unique(&mut self, wanted: &str) -> String {
        if self.used.insert(wanted.to_owned()) {
            return wanted.to_owned();
        }
        for suffix in 1.. {
            let candidate = format!("{wanted}.{suffix}");
            if self.used.insert(candidate.clone()) {
                return candidate;
            }
        }
        unreachable!("the loop above does not terminate without returning")
    }

    /// The `<{ … }>` body of one aggregate, padding included.
    ///
    /// One rendering of [`elements`]; a constant initialiser is the other. The
    /// padding here is not decoration — trailing padding is what makes the LLVM
    /// type's size equal `Layout::size`, and therefore what makes `byval` copy
    /// the whole struct and an array of them stride correctly.
    fn body(&mut self, layouts: &mut Layouts<'_>, ty: TyId) -> Result<String> {
        let mut rendered: Vec<String> = Vec::new();
        for element in elements(layouts, ty)? {
            rendered.push(match element {
                Element::Padding(bytes) | Element::Bytes(bytes) => format!("[{bytes} x i8]"),
                Element::VtablePtr => "ptr".to_owned(),
                Element::Field(field) => self.of(layouts, field)?,
            });
        }
        Ok(format!("<{{ {} }}>", rendered.join(", ")))
    }
}
