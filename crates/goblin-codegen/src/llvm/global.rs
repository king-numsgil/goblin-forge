//! Module-level constants as data objects.
//!
//! GLOBALS-PLAN stage 1. A `const` at module scope is one `.rodata` symbol and
//! nothing else — no initialiser runs, ever, which is the whole rule the feature
//! rests on (C++'s constant initialisation).
//!
//! **The frontend sends values and this places them.** `Global::init` is a flat,
//! depth-first list of leaves and the *type* is the structure: two fields, two
//! leaves. So the walk here is [`crate::llvm::ty::elements`] — the same walk that
//! renders the LLVM type — with a leaf consumed at each field position. That is
//! deliberate and load-bearing: an initialiser whose padding sat one slot away
//! from the type's would still compile, and would write a field's bytes into the
//! padding.
//!
//! Running out of leaves, or having leaves left over, is an [`InternalError`]
//! rather than a diagnostic. The frontend decides how many leaves a type wants;
//! a disagreement is this compiler being wrong about its own IR, and the flat
//! form is exactly the shape where that could otherwise pass unnoticed.

use goblin_mir::{Const, GlobalInit, GlobalRef, Linkage, Module, TyId, TyKind};

use crate::error::{InternalError, Result};
use crate::internal_error;
use crate::layout::{Layouts, Repr};
use crate::llvm::data::Globals;
use crate::llvm::func::{sign_extend, truncate};
use crate::llvm::ty::{Element, Types, array_padding, ident, scalar};
use crate::llvm::Symbols;

/// Emit a data object for every global this module defines, and hand back a
/// declaration for every one it imports.
pub fn emit(
    module: &Module,
    globals: &mut Globals,
    types: &mut Types,
    layouts: &mut Layouts<'_>,
    symbols: &Symbols,
) -> Result<Vec<String>> {
    for (index, global) in module.globals.iter().enumerate() {
        let Some(symbol) = module.sym(global.name) else {
            internal_error!("global {index} has no name");
        };
        let ty = types.of(layouts, global.ty)?;
        let mut leaves = Leaves::new(&global.init);
        let value = leaves
            .value(module, types, layouts, symbols, global.ty)
            .map_err(|error| error.in_function(symbol))?;
        leaves.finish(symbol)?;

        // `constant` is what lets the object land in `.rodata`; a mutable one is
        // `global` and lands in `.data`. Nothing produces the second yet — a
        // top-level `let` is refused in the frontend — and the flag is honoured
        // rather than asserted so that the day it is produced, this is not the
        // place that has to change.
        let keyword = if global.mutable { "global" } else { "constant" };
        // A packed struct is align-1 as far as LLVM is concerned, which is the
        // reason every object in this backend states its alignment: `ty.rs` spells
        // the padding out, so the type no longer carries the alignment with it.
        let align = layouts.layout(global.ty)?.align.max(1);
        let visibility = match global.linkage {
            // `internal` rather than `private`: the symbol stays in the table,
            // which is what makes `llvm-objdump` legible when a constant is
            // wrong. The same choice `Globals::words` makes and for the reason.
            Linkage::Internal => "internal ",
            Linkage::Export => "",
        };
        globals.define(format!(
            "@{} = {visibility}{keyword} {ty} {value}, align {align}",
            ident(symbol)
        ));
    }

    let mut declarations = Vec::with_capacity(module.extern_globals.len());
    for (index, import) in module.extern_globals.iter().enumerate() {
        let Some(symbol) = module.sym(import.name) else {
            internal_error!("imported global {index} has no name");
        };
        let ty = types.of(layouts, import.ty)?;
        // `external global` and not `external constant`, which would be a promise
        // this side cannot check: `ExternGlobal` carries no mutability, and a
        // `constant` declaration over a symbol the defining module made mutable
        // lets LLVM fold a load that should have been a read. Reads are identical
        // either way, so the promise buys nothing worth that.
        declarations.push(format!("@{} = external global {ty}", ident(symbol)));
    }
    Ok(declarations)
}

/// The symbol a [`GlobalRef`] names.
pub fn symbol_of(symbols: &Symbols, global: &GlobalRef) -> Result<String> {
    let name = match global {
        GlobalRef::Local(id) => symbols.globals.get(id.index()),
        GlobalRef::Extern(id) => symbols.imported_globals.get(id.index()),
    };
    name.cloned()
        .ok_or_else(|| InternalError::new(format!("{global:?} is not in the module")))
}

/// A cursor over one global's leaves, consumed as the type is walked.
struct Leaves<'a> {
    leaves: &'a [GlobalInit],
    at: usize,
}

impl<'a> Leaves<'a> {
    fn new(leaves: &'a [GlobalInit]) -> Leaves<'a> {
        Leaves { leaves, at: 0 }
    }

    /// Every leaf must land somewhere. One left over means the frontend
    /// described a shape this type does not have, which is the failure the flat
    /// leaf list makes possible and this makes loud.
    fn finish(&self, symbol: &str) -> Result<()> {
        if self.at == self.leaves.len() {
            return Ok(());
        }
        internal_error!(
            "`{symbol}` was given {} initialiser leaves and its type takes {}",
            self.leaves.len(),
            self.at
        )
    }

    fn next(&mut self, ty: TyId, layouts: &mut Layouts<'_>) -> Result<&'a GlobalInit> {
        let Some(leaf) = self.leaves.get(self.at) else {
            internal_error!(
                "an initialiser ran out of leaves at a `{}`",
                crate::layout::render_type(layouts.module(), ty)
            );
        };
        self.at += 1;
        Ok(leaf)
    }

    /// The constant text for one type, consuming as many leaves as it holds.
    ///
    /// The type text is *not* included: a top-level global writes it once before
    /// the value, and an aggregate writes it per element. Both are the caller.
    fn value(
        &mut self,
        module: &Module,
        types: &mut Types,
        layouts: &mut Layouts<'_>,
        symbols: &Symbols,
        ty: TyId,
    ) -> Result<String> {
        // A `Zero` covers whatever sits at this position — a scalar, a struct, a
        // 4096-element table — so it is answered before the type is taken apart.
        // That is what keeps a zeroed table one leaf on the wire rather than 4096.
        if matches!(self.leaves.get(self.at), Some(GlobalInit::Zero)) {
            self.at += 1;
            return Ok("zeroinitializer".to_owned());
        }

        match layouts.repr(ty)? {
            Repr::Void => internal_error!("a global cannot be `void`"),
            Repr::Register(_) => self.leaf(module, layouts, symbols, ty),
            Repr::Vector { elem, lanes } => {
                let mut parts = Vec::with_capacity(lanes as usize);
                for _ in 0..lanes {
                    parts.push(format!(
                        "{} {}",
                        scalar(elem),
                        self.leaf(module, layouts, symbols, ty)?
                    ));
                }
                Ok(format!("<{}>", parts.join(", ")))
            }
            Repr::Aggregate => self.aggregate(module, types, layouts, symbols, ty),
        }
    }

    fn aggregate(
        &mut self,
        module: &Module,
        types: &mut Types,
        layouts: &mut Layouts<'_>,
        symbols: &Symbols,
        ty: TyId,
    ) -> Result<String> {
        // A fixed array is structural rather than named, so it is shaped here the
        // way `Types::aggregate` shapes it — including the per-element tail
        // padding a wider stride needs, which the type carries and the value
        // therefore has to as well.
        if let Some(TyKind::FixedArray { element, length }) = module.ty(ty).map(|def| &def.kind) {
            let (element, length) = (*element, *length);
            let padding = array_padding(layouts, element)?;
            let element_ty = types.of(layouts, element)?;
            let mut parts = Vec::with_capacity(length as usize);
            for _ in 0..length {
                let value = self.value(module, types, layouts, symbols, element)?;
                parts.push(if padding == 0 {
                    format!("{element_ty} {value}")
                } else {
                    format!(
                        "<{{ {element_ty}, [{padding} x i8] }}> \
                         <{{ {element_ty} {value}, [{padding} x i8] zeroinitializer }}>"
                    )
                });
            }
            return Ok(format!("[{}]", parts.join(", ")));
        }

        let mut parts = Vec::new();
        for element in crate::llvm::ty::elements(layouts, ty)? {
            parts.push(match element {
                Element::Padding(bytes) | Element::Bytes(bytes) => {
                    format!("[{bytes} x i8] zeroinitializer")
                }
                // A class in static data would need its vtable pointer, which is
                // a relocation onto a table this does not have. The frontend
                // refuses a class global, so arriving here is a compiler bug.
                Element::VtablePtr => internal_error!(
                    "a `{}` cannot be a global: its vtable pointer is a relocation",
                    crate::layout::render_type(module, ty)
                ),
                Element::Field(field) => {
                    let text = types.of(layouts, field)?;
                    let value = self.value(module, types, layouts, symbols, field)?;
                    format!("{text} {value}")
                }
            });
        }
        Ok(format!("<{{ {} }}>", parts.join(", ")))
    }

    /// One scalar position: a leaf, rendered as LLVM writes that constant.
    fn leaf(
        &mut self,
        module: &Module,
        layouts: &mut Layouts<'_>,
        symbols: &Symbols,
        ty: TyId,
    ) -> Result<String> {
        match self.next(ty, layouts)? {
            // Answered in `value`, before the type is taken apart.
            GlobalInit::Zero => Ok("zeroinitializer".to_owned()),
            GlobalInit::SizeOf(of) => Ok(layouts.layout(*of)?.size.to_string()),
            GlobalInit::AlignOf(of) => Ok(layouts.layout(*of)?.align.max(1).to_string()),
            GlobalInit::Scalar(constant) => constant_text(module, layouts, symbols, constant),
        }
    }
}

/// A [`Const`] as LLVM writes it inside a constant initialiser.
fn constant_text(
    module: &Module,
    layouts: &mut Layouts<'_>,
    symbols: &Symbols,
    constant: &Const,
) -> Result<String> {
    Ok(match constant {
        Const::Unit => internal_error!("`unit` is not a value a global can hold"),
        Const::Bool { value, .. } => u8::from(*value).to_string(),
        Const::Int { bits, ty } => {
            // The same rule a constant in a function body follows, from the same
            // two functions: the frontend has already folded the sign into the
            // bit pattern and range-checked it, so this is a reinterpretation.
            // Two spellings of it would be two answers for `-1` at `i8`.
            let width = layouts.layout(*ty)?.size * 8;
            let signed = matches!(module.ty(*ty).map(|def| &def.kind), Some(TyKind::Int(int)) if int.is_signed());
            if signed {
                sign_extend(*bits, width).to_string()
            } else {
                truncate(*bits, width).to_string()
            }
        }
        Const::Float { bits, ty } => {
            // Hex bits, which is exact and survives NaN payloads — the reason the
            // MIR carries bits at all. A `float` is written as the `double` it
            // widens to, which is what LLVM's textual form expects.
            match module.ty(*ty).map(|def| &def.kind) {
                Some(TyKind::Float(goblin_mir::FloatTy::F32)) => {
                    format!("0x{:016X}", f64::from(f32::from_bits(*bits as u32)).to_bits())
                }
                _ => format!("0x{bits:016X}"),
            }
        }
        Const::Null(_) => "null".to_owned(),
        Const::Func { func, .. } => {
            format!("@{}", ident(&crate::llvm::func::symbol_of(symbols, func)?))
        }
        // Both are relocations into objects this does not emit, and both are
        // refused in the frontend — a `string` global is GLOBALS-PLAN's next
        // widening, and folding *through* another global produces its value
        // rather than its address. So either one arriving is a compiler bug.
        Const::Str { .. } => {
            internal_error!("a `string` cannot be a global's value yet")
        }
        Const::Global { .. } => {
            internal_error!("a global's value cannot be another global's address")
        }
    })
}
