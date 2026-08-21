//! Cranelift's spelling of the backend's own vocabulary.
//!
//! [`crate::layout::Scalar`] and [`crate::abi::Shape`] say what a register
//! holds and how a value crosses the C boundary, in this compiler's terms and
//! nobody else's. This is the one file that turns those answers into
//! `cranelift_codegen::ir` — and, when LLVM lands (DECISIONS §17), it is the
//! file that gets a sibling rather than a rewrite.
//!
//! Keeping the translation here is what makes the port a port. `abi.rs` is the
//! newest and best-tested code in the project (REWRITE-PLAN §13); it should not
//! have to be reopened to change code generators.

use cranelift_codegen::ir::{AbiParam, ArgumentPurpose, Signature, Type as ClifType, types};
use cranelift_codegen::isa::CallConv;

use crate::abi::{Ext, Shape, Slot, extension};
use crate::layout::{Scalar, TargetInfo};

impl TargetInfo {
    /// The Cranelift type of a machine address on this target.
    pub fn pointer_type(self) -> ClifType {
        match self.pointer_bytes {
            4 => types::I32,
            _ => types::I64,
        }
    }
}

impl Scalar {
    /// This scalar as Cranelift spells it.
    ///
    /// [`Scalar::Ptr`] collapses to an integer of the target's address width,
    /// because Cranelift has no pointer type. That collapse is *this file's*
    /// business — the distinction stays intact in `layout.rs`, where LLVM will
    /// need it.
    pub fn clif(self, target: TargetInfo) -> ClifType {
        match self {
            Scalar::I8 => types::I8,
            Scalar::I16 => types::I16,
            Scalar::I32 => types::I32,
            Scalar::I64 => types::I64,
            Scalar::F32 => types::F32,
            Scalar::F64 => types::F64,
            Scalar::Ptr => target.pointer_type(),
        }
    }
}

/// An ABI parameter carrying the extension the C ABI asks for.
pub fn abi_param(ty: Scalar, signed: bool, target: TargetInfo) -> AbiParam {
    let param = AbiParam::new(ty.clif(target));
    match extension(ty, signed, target) {
        Ext::None => param,
        Ext::Sext => param.sext(),
        Ext::Zext => param.uext(),
    }
}

/// Turn a classified shape into Cranelift's parameter list.
pub fn to_signature(shape: &Shape, call_conv: CallConv, target: TargetInfo) -> Signature {
    let pointer = target.pointer_type();
    let mut out = Signature::new(call_conv);

    // The hidden return pointer comes first, and Cranelift returns it *itself*
    // from the parameter's `StructReturn` purpose. Declaring it as a return
    // value as well panics inside the ABI layer with a message that does not
    // obviously say so (REWRITE-PLAN §10).
    if let Slot::Sret { .. } = shape.returns {
        out.params
            .push(AbiParam::special(pointer, ArgumentPurpose::StructReturn));
    }

    for slot in &shape.params {
        match slot {
            Slot::Plain { ty, signed } => out.params.push(abi_param(*ty, *signed, target)),
            Slot::Registers { carriers, .. } => {
                for carrier in carriers {
                    out.params.push(AbiParam::new(carrier.clif(target)));
                }
            }
            Slot::ByAddress { .. } => out.params.push(AbiParam::new(pointer)),
            Slot::OnStack { size, .. } => out.params.push(AbiParam::special(
                pointer,
                ArgumentPurpose::StructArgument(*size),
            )),
            Slot::Sret { .. } | Slot::None => {}
        }
    }

    match &shape.returns {
        Slot::Plain { ty, signed } => out.returns.push(abi_param(*ty, *signed, target)),
        Slot::Registers { carriers, .. } => {
            for carrier in carriers {
                out.returns.push(AbiParam::new(carrier.clif(target)));
            }
        }
        Slot::Sret { .. } | Slot::None => {}
        Slot::ByAddress { .. } | Slot::OnStack { .. } => {
            unreachable!("a return is never classified by address or on stack")
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use cranelift_codegen::ir::ArgumentExtension;

    const TARGET: TargetInfo = TargetInfo { pointer_bytes: 8 };

    #[test]
    fn sub_register_widths_carry_their_extension() {
        assert_eq!(
            abi_param(Scalar::I8, true, TARGET).extension,
            ArgumentExtension::Sext
        );
        assert_eq!(
            abi_param(Scalar::I8, false, TARGET).extension,
            ArgumentExtension::Uext
        );
        assert_eq!(
            abi_param(Scalar::I16, true, TARGET).extension,
            ArgumentExtension::Sext
        );
        // Nothing a register already holds in full needs one.
        assert_eq!(
            abi_param(Scalar::I32, true, TARGET).extension,
            ArgumentExtension::None
        );
        assert_eq!(
            abi_param(Scalar::I64, true, TARGET).extension,
            ArgumentExtension::None
        );
        assert_eq!(
            abi_param(Scalar::F64, false, TARGET).extension,
            ArgumentExtension::None
        );
        // A pointer is an integer to Cranelift, but never a narrow one.
        assert_eq!(
            abi_param(Scalar::Ptr, false, TARGET).extension,
            ArgumentExtension::None
        );
    }

    #[test]
    fn a_pointer_is_the_targets_address_width() {
        assert_eq!(Scalar::Ptr.clif(TARGET), types::I64);
        assert_eq!(
            Scalar::Ptr.clif(TargetInfo { pointer_bytes: 4 }),
            types::I32
        );
    }
}
