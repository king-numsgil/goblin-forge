//! A signature as LLVM declares it.
//!
//! LLVM does not classify C ABIs; clang does it in the frontend and hands LLVM
//! types plus attributes (DECISIONS §17). This is that step, and `abi.rs` has
//! already made every decision it encodes — the job here is spelling, not
//! judgement.
//!
//! Four spellings carry the whole C boundary, and the differences between them
//! are the part worth reading:
//!
//! * **`Registers`** becomes literal parameters of the carrier types. There is
//!   no "pass this struct in these registers" in LLVM; the caller stores the
//!   aggregate and loads the carriers back, and the callee does the reverse.
//! * **`OnStack`** — System V's MEMORY class — becomes `byval(T) align N`, and
//!   LLVM makes the copy.
//! * **`ByAddress`** — Win64's rule for anything not 1, 2, 4 or 8 bytes —
//!   becomes a plain `ptr`, and *the caller* makes the copy. Checked against
//!   clang 22.1.8, which emits exactly this pair of spellings for the two
//!   conventions. Swapping them is silent stack corruption, which is why they
//!   are two `Slot` variants rather than one with a flag.
//! * **`Sret`** becomes a leading `ptr sret(T) align N` and the function
//!   returns `void`.

use goblin_mir::{Abi, Signature};

use crate::abi::{self, Ext, Shape, Slot};
use crate::error::Result;
use crate::internal_error;
use crate::layout::{Layouts, Repr};
use crate::llvm::ty::{Types, scalar};

/// A rendered signature, split so a `declare`, a `define` and a `call` can each
/// take the part they need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// The return type text: a scalar, `void`, or a named aggregate.
    pub returns: String,
    /// Each parameter, attributes included, in order.
    pub params: Vec<String>,
    /// Whether the first parameter is the hidden return pointer.
    pub sret: bool,
}

impl Rendered {
    /// `<ret> @<name>(<params>)`, the form both `declare` and `define` take.
    pub fn header(&self, name: &str) -> String {
        format!("{} @{}({})", self.returns, name, self.params.join(", "))
    }
}

/// `signext` / `zeroext`, or nothing.
///
/// **The two sites put it on opposite sides of the type**, which is LLVM's
/// syntax and not a slip: a return attribute precedes the result type and a
/// parameter attribute follows its own type. Checked against clang 22.1.8 —
/// `declare signext i8 @f(i8 noundef signext)` — and getting it backwards is a
/// parse error rather than anything subtle, which is the one kind of mistake
/// this file is allowed to make.
fn ext_text(ext: Ext) -> &'static str {
    match ext {
        Ext::None => "",
        Ext::Sext => "signext",
        Ext::Zext => "zeroext",
    }
}

/// A parameter: type first, attribute after.
fn param_text(ty: &str, ext: Ext) -> String {
    match ext_text(ext) {
        "" => ty.to_owned(),
        attribute => format!("{ty} {attribute}"),
    }
}

/// A return: attribute first, type after.
fn return_text(ty: &str, ext: Ext) -> String {
    match ext_text(ext) {
        "" => ty.to_owned(),
        attribute => format!("{attribute} {ty}"),
    }
}

/// Render a signature, classifying it first when it crosses the C boundary.
pub fn render(
    types: &mut Types,
    layouts: &mut Layouts<'_>,
    sig: &Signature,
    conv: abi::Conv,
) -> Result<Rendered> {
    if sig.abi == Abi::C {
        let shape = abi::classify(layouts, sig, conv)?;
        return c_abi(types, layouts, sig, &shape);
    }
    internal_abi(types, layouts, sig)
}

/// The internal convention: an aggregate travels as the address of its storage.
///
/// Deliberately *not* `sret` and *not* `byval`. Both carry C ABI meaning that
/// LLVM will act on, and this convention has both halves compiled by us — the
/// caller has already made the copy that is the argument, so its address costs
/// one register and no second copy (REWRITE-PLAN §6). A bare `ptr` says that
/// and nothing more.
fn internal_abi(types: &mut Types, layouts: &mut Layouts<'_>, sig: &Signature) -> Result<Rendered> {
    let returns_aggregate = matches!(layouts.repr(sig.ret)?, Repr::Aggregate);
    let mut params = Vec::with_capacity(sig.params.len() + 1);
    if returns_aggregate {
        params.push("ptr".to_owned());
    }

    for param in &sig.params {
        match layouts.repr(param.ty)? {
            Repr::Void => internal_error!("a parameter cannot have type `void`"),
            Repr::Register(value) => params.push(scalar(value).to_owned()),
            Repr::Aggregate => params.push("ptr".to_owned()),
        }
    }

    let returns = if returns_aggregate {
        "void".to_owned()
    } else {
        types.of(layouts, sig.ret)?
    };

    Ok(Rendered {
        returns,
        params,
        sret: returns_aggregate,
    })
}

fn c_abi(
    types: &mut Types,
    layouts: &mut Layouts<'_>,
    sig: &Signature,
    shape: &Shape,
) -> Result<Rendered> {
    let target = layouts.target();
    let mut params = Vec::with_capacity(shape.params.len() + 1);

    if let Slot::Sret { align, .. } = shape.returns {
        let ty = types.aggregate(layouts, sig.ret)?;
        params.push(format!("ptr sret({ty}) align {align}"));
    }

    for (index, slot) in shape.params.iter().enumerate() {
        let Some(param) = sig.params.get(index) else {
            internal_error!("the shape has more parameters than the signature");
        };
        match slot {
            Slot::None => {}
            Slot::Plain { ty, signed } => params.push(param_text(
                scalar(*ty),
                abi::extension(*ty, *signed, target),
            )),
            Slot::Registers { carriers, .. } => {
                for carrier in carriers {
                    params.push(scalar(*carrier).to_owned());
                }
            }
            // The caller's copy, by address. No attribute: `byval` would ask
            // LLVM to make a *second* copy under System V's rules, on a
            // convention that does not have them.
            Slot::ByAddress { .. } => params.push("ptr".to_owned()),
            Slot::OnStack { align, .. } => {
                let ty = types.aggregate(layouts, param.ty)?;
                params.push(format!("ptr byval({ty}) align {align}"));
            }
            Slot::Sret { .. } => internal_error!("a parameter classified as a struct return"),
        }
    }

    let returns = match &shape.returns {
        Slot::None | Slot::Sret { .. } => "void".to_owned(),
        // A sub-register-width return carries its extension too, on the return
        // rather than on a parameter: `declare signext i8 @f()`.
        Slot::Plain { ty, signed } => {
            return_text(scalar(*ty), abi::extension(*ty, *signed, target))
        }
        // Two carriers come back as an anonymous struct, which is how clang
        // spells a multi-register return: `{ i64, i64 } @f(…)`.
        Slot::Registers { carriers, .. } => match carriers.as_slice() {
            [] => internal_error!("a register return with no carriers"),
            [one] => scalar(*one).to_owned(),
            many => format!(
                "{{ {} }}",
                many.iter()
                    .map(|c| scalar(*c))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        },
        Slot::ByAddress { .. } | Slot::OnStack { .. } => {
            internal_error!("a return classified by address or on stack")
        }
    };

    Ok(Rendered {
        returns,
        params,
        sret: shape.has_sret(),
    })
}
