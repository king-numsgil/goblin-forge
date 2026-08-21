//! The platform C ABI, for values that cross the FFI boundary.
//!
//! Carried across from v1 nearly unchanged — REWRITE-PLAN §13 lists it as the
//! newest and best-tested code in the project, and §6 asks for it to move
//! *earlier* in the design rather than be rewritten.
//!
//! Inside a module an aggregate is passed as the address of its storage: one
//! machine word, whoever is calling. That is nobody's ABI but ours, and it is
//! the right choice for calls this compiler emits both halves of.
//!
//! At the boundary it is wrong. A C function declared to take a `Point` expects
//! the *struct*, packed into registers or copied onto the stack by rules that
//! differ per platform, and handing it an address instead produces an answer
//! made of the address. So an `import`, and any function this module exports,
//! is classified here instead.
//!
//! Two conventions:
//!
//! * **Win64** (`x86_64-pc-windows-msvc`): a struct of 1, 2, 4 or 8 bytes
//!   travels in one integer register; anything else goes by address, pointing
//!   at a copy the caller made.
//! * **System V AMD64**: up to sixteen bytes are split into "eightbytes", each
//!   classified INTEGER or SSE; anything larger goes on the stack.
//!
//! v1's System V half was written from the psABI and never run. REWRITE-PLAN §6
//! is blunt about that — "the classification is the part of a compiler where
//! 'looks right' is worth nothing" — so it is exercised by the same differential
//! suite on a Linux CI job.

use goblin_mir::{Module, TyId, TyKind};

use crate::error::{InternalError, Result};
use crate::layout::{Layouts, Repr, Scalar};

/// Which platform convention a signature follows.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Conv {
    Win64,
    SysV,
}

impl Conv {
    /// The convention for a target triple, or `None` where this compiler has no
    /// rules to follow.
    pub fn of(triple: &target_lexicon::Triple) -> Option<Conv> {
        use target_lexicon::{Architecture, OperatingSystem};
        if triple.architecture != Architecture::X86_64 {
            return None;
        }
        match triple.operating_system {
            OperatingSystem::Windows => Some(Conv::Win64),
            OperatingSystem::Linux
            | OperatingSystem::Darwin(_)
            | OperatingSystem::MacOSX(_)
            | OperatingSystem::Freebsd
            | OperatingSystem::Netbsd
            | OperatingSystem::Openbsd => Some(Conv::SysV),
            _ => None,
        }
    }
}

/// How one parameter or return value crosses the boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Slot {
    /// A register value, exactly as it travels internally. `signed` decides
    /// which extension a sub-register-width integer carries.
    Plain { ty: Scalar, signed: bool },
    /// A struct packed into these registers, low bytes first.
    ///
    /// The carrier types are chosen for their *width* and their register file:
    /// what matters is whether the bits land in a general register or an SSE
    /// one, and `F64` carries an SSE eightbyte whatever is actually inside it.
    ///
    /// **This is deliberately coarser than what clang declares, and the two
    /// agree in the registers.** Checked against clang 22.1.8 for System V:
    /// clang runs `GetINTEGERTypeAtOffset`, which names the carrier after the
    /// field actually sitting at that offset — `{i64,char}` is `(i64, i8)`,
    /// `{i64,short}` is `(i64, i16)`, `{int,int,int}` is `(i64, i32)` — and
    /// falls back to `i64` when no single field covers the eightbyte, which is
    /// why an 11-byte `{i64,char,char,char}` is `(i64, i64)`: a carrier three
    /// bytes *wider* than the struct. Its float half is finer still, spelling
    /// an all-float eightbyte `<2 x float>` and a lone trailing one `float`.
    ///
    /// Reproducing that would be real work buying nothing, because none of it
    /// changes which bytes land in which register — clang's own caller relies
    /// on the padding of the storage it copies out of, exactly as
    /// `scatter_carriers` relies on its scratch slot. So the divergence is
    /// written down here rather than chased, and stage 4's differential suite
    /// is what holds the claim up.
    Registers {
        carriers: Vec<Scalar>,
        size: u32,
        align: u32,
    },
    /// A struct passed as the address of a copy the caller allocated. Win64's
    /// rule for every struct that is not 1, 2, 4 or 8 bytes.
    ///
    /// Distinct from [`Slot::OnStack`], and the distinction is load-bearing:
    /// clang lowers this to a plain pointer parameter with the *caller* doing
    /// the `memcpy`, and lowers `OnStack` to `byval`. Swapping them is silent
    /// stack corruption rather than a crash.
    ByAddress { size: u32, align: u32 },
    /// A struct copied onto the outgoing stack area — System V's MEMORY class.
    /// The code generator performs the copy.
    OnStack { size: u32, align: u32 },
    /// A struct written into storage the caller allocated, whose address
    /// arrives as a hidden first parameter.
    Sret { size: u32, align: u32 },
    /// Nothing travels. A `void` return.
    None,
}

impl Slot {
    /// Whether this slot describes a struct rather than a register value.
    pub fn is_aggregate(&self) -> bool {
        !matches!(self, Slot::Plain { .. } | Slot::None)
    }
}

/// The whole shape of a call at the boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shape {
    pub params: Vec<Slot>,
    pub returns: Slot,
}

impl Shape {
    pub fn has_sret(&self) -> bool {
        matches!(self.returns, Slot::Sret { .. })
    }
}

/// Which extension a sub-register-width value carries across the boundary.
///
/// Both rustc and clang mark a C parameter or return narrower than a register
/// `zeroext` or `signext`, and a function compiled that way is entitled to use
/// the whole register without masking first. Neither Cranelift nor LLVM
/// supplies one by default, so saying which is on us — against a class of bug
/// that only ever shows up as a wrong answer on somebody else's machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ext {
    /// The value already fills a register. Nothing to say.
    None,
    Sext,
    Zext,
}

/// The extension the C ABI asks for on a value of this scalar.
pub fn extension(ty: Scalar, signed: bool, target: crate::layout::TargetInfo) -> Ext {
    if !ty.is_integer() || ty.bits(target) >= 32 {
        return Ext::None;
    }
    if signed { Ext::Sext } else { Ext::Zext }
}

/// Reject anything whose bytes are not the whole of its value.
///
/// A byte copy has to *be* the copy, on both sides of a boundary where only one
/// side knows this language's ownership rules. A `string` field would leave the
/// C side holding a pointer it must not free; a vtable would leave it holding
/// an address into this module's read-only data.
pub fn require_plain_data(module: &Module, ty: TyId, what: &str) -> Result<()> {
    let Some(def) = module.ty(ty) else {
        return Err(InternalError::new(format!("type {} is missing", ty.0)));
    };
    match &def.kind {
        TyKind::Str => Err(InternalError::new(format!(
            "a `string` owns its buffer, so {what} cannot copy one by value without \
             deciding who frees it. Pass a `Pointer<u8>` and adopt it with \
             `stringFromCString`."
        ))),
        TyKind::Array(element) => Err(InternalError::new(format!(
            "a `{}[]` owns its elements, so {what} cannot copy one by value. Pass a \
             `FixedArray` or a `Pointer<{}>` and a length.",
            crate::layout::render_type(module, *element),
            crate::layout::render_type(module, *element),
        ))),
        TyKind::FixedArray { element, .. } => require_plain_data(module, *element, what),
        // A class carries a vtable pointer, and a contract reference carries an
        // itab — both of them addresses into *this* build's read-only data. A
        // byte copy of one is meaningless to C, and meaningless to a second
        // Goblin build too, since descriptors have one owner per compilation
        // (DECISIONS §11.2).
        TyKind::Class(id) => Err(InternalError::new(format!(
            "`{}` is a class, so {what} would hand over a vtable pointer that              only means something inside this build. Pass its fields, or a              `Pointer<T>` to it.",
            module
                .class(*id)
                .and_then(|class| module.sym(class.name))
                .unwrap_or("a class"),
        ))),
        TyKind::Interface(id) => Err(InternalError::new(format!(
            "`{}` is an interface reference — a pair of pointers into this              build's own tables — so {what} is not meaningful.",
            module
                .interface(*id)
                .and_then(|def| module.sym(def.name))
                .unwrap_or("an interface"),
        ))),
        TyKind::Struct(id) => {
            let Some(strukt) = module.strukt(*id) else {
                return Err(InternalError::new(format!("struct {} is missing", id.0)));
            };
            for field in &strukt.fields {
                require_plain_data(module, field.ty, what)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Every scalar inside an aggregate, flattened, with its byte offset and
/// whether it is a float.
///
/// Only ever called on plain data, so the recursion bottoms out at scalars,
/// booleans and machine words.
fn scalars(layouts: &mut Layouts<'_>, ty: TyId, at: u32, out: &mut Vec<(u32, bool)>) -> Result<()> {
    let module = layouts.module();
    let kind = module
        .ty(ty)
        .map(|def| def.kind.clone())
        .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))?;

    match kind {
        TyKind::Struct(id) => {
            let layout = layouts.layout(ty)?;
            let fields: Vec<TyId> = layouts
                .module()
                .strukt(id)
                .map(|def| def.fields.iter().map(|field| field.ty).collect())
                .ok_or_else(|| InternalError::new(format!("struct {} is missing", id.0)))?;
            for (index, field) in fields.into_iter().enumerate() {
                let offset = layout.fields.get(index).copied().unwrap_or(0);
                scalars(layouts, field, at + offset, out)?;
            }
            Ok(())
        }
        TyKind::FixedArray { element, length } => {
            let stride = layouts.layout(element)?.stride();
            for index in 0..length {
                scalars(layouts, element, at + stride * (index as u32), out)?;
            }
            Ok(())
        }
        TyKind::Float(_) => {
            out.push((at, true));
            Ok(())
        }
        // A boolean, a pointer, and a machine-word handle are all integers as
        // far as register classification is concerned.
        _ => {
            out.push((at, false));
            Ok(())
        }
    }
}

/// System V's per-eightbyte classification.
///
/// An eightbyte is SSE only when *everything* overlapping it is a float; one
/// integer anywhere in those eight bytes makes the whole eightbyte INTEGER.
/// That is the rule that puts `struct { int; float; }` in one general register
/// and `struct { float; float; }` in one SSE register — and getting it
/// backwards is silent corruption rather than a crash (REWRITE-PLAN §6).
fn eightbytes(layouts: &mut Layouts<'_>, ty: TyId, size: u32) -> Result<Vec<Scalar>> {
    let mut flat = Vec::new();
    scalars(layouts, ty, 0, &mut flat)?;

    let count = size.div_ceil(8).max(1);
    let mut carriers = Vec::with_capacity(count as usize);
    for index in 0..count {
        let start = index * 8;
        let end = start + 8;
        let integer = flat
            .iter()
            .any(|(offset, float)| *offset >= start && *offset < end && !*float);
        // An eightbyte no field reaches is padding; INTEGER is the conservative
        // reading and matches what compilers emit for trailing padding.
        carriers.push(if integer { Scalar::I64 } else { Scalar::F64 });
    }
    Ok(carriers)
}

/// The integer carrier for a Win64 struct of 1, 2, 4 or 8 bytes.
fn packed(size: u32) -> Option<Scalar> {
    Scalar::int_of_bytes(size)
}

fn signedness(module: &Module, ty: TyId) -> bool {
    matches!(module.ty(ty).map(|def| &def.kind), Some(TyKind::Int(int)) if int.is_signed())
}

/// How a parameter of this type crosses the boundary.
pub fn classify_param(layouts: &mut Layouts<'_>, ty: TyId, conv: Conv) -> Result<Slot> {
    // Only aggregates are checked here, and that is deliberate. A one-word
    // owning handle *does* legitimately cross this boundary in one case: the
    // runtime's own `extern "C"` functions, which take and return `string`
    // because they are the code that knows the ownership rules. Whether a
    // *user's* export may do the same is a question about the source, and the
    // frontend answers it — `GF0301`, with a file and a line.
    match layouts.repr(ty)? {
        Repr::Void => return Ok(Slot::None),
        Repr::Register(clif) => {
            let signed = signedness(layouts.module(), ty);
            return Ok(Slot::Plain { ty: clif, signed });
        }
        Repr::Aggregate => {}
    }

    require_plain_data(layouts.module(), ty, "passing it across the C ABI")?;
    let layout = layouts.layout(ty)?;
    let (size, align) = (layout.size, layout.align.max(1));

    Ok(match conv {
        // "Structs of size 1, 2, 4 or 8 bytes are passed as if they were
        // integers of the same size"; everything else is passed by reference,
        // to a copy the caller is responsible for.
        Conv::Win64 => match packed(size) {
            Some(carrier) => Slot::Registers {
                carriers: vec![carrier],
                size,
                align,
            },
            None => Slot::ByAddress { size, align },
        },
        Conv::SysV => {
            if size > 16 {
                // The outgoing stack area is measured in eightbytes.
                Slot::OnStack {
                    size: size.div_ceil(8) * 8,
                    align,
                }
            } else {
                Slot::Registers {
                    carriers: eightbytes(layouts, ty, size)?,
                    size,
                    align,
                }
            }
        }
    })
}

/// How a return value of this type crosses the boundary.
///
/// The rules mirror the parameter ones, except that a struct too large for
/// registers is written through a pointer the caller supplies rather than
/// copied onto the stack.
pub fn classify_return(layouts: &mut Layouts<'_>, ty: TyId, conv: Conv) -> Result<Slot> {
    // Aggregates only, for the same reason as `classify_param`.
    match layouts.repr(ty)? {
        Repr::Void => return Ok(Slot::None),
        Repr::Register(clif) => {
            let signed = signedness(layouts.module(), ty);
            return Ok(Slot::Plain { ty: clif, signed });
        }
        Repr::Aggregate => {}
    }

    require_plain_data(layouts.module(), ty, "returning it across the C ABI")?;
    let layout = layouts.layout(ty)?;
    let (size, align) = (layout.size, layout.align.max(1));

    Ok(match conv {
        Conv::Win64 => match packed(size) {
            Some(carrier) => Slot::Registers {
                carriers: vec![carrier],
                size,
                align,
            },
            None => Slot::Sret { size, align },
        },
        Conv::SysV => {
            if size > 16 {
                Slot::Sret { size, align }
            } else {
                Slot::Registers {
                    carriers: eightbytes(layouts, ty, size)?,
                    size,
                    align,
                }
            }
        }
    })
}

/// Classify a whole signature.
pub fn classify(
    layouts: &mut Layouts<'_>,
    sig: &goblin_mir::Signature,
    conv: Conv,
) -> Result<Shape> {
    let mut params = Vec::with_capacity(sig.params.len());
    for param in &sig.params {
        params.push(classify_param(layouts, param.ty, conv)?);
    }
    Ok(Shape {
        params,
        returns: classify_return(layouts, sig.ret, conv)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::TargetInfo;
    use goblin_mir::{
        Category, FieldDef, FloatTy, IntTy, Span, StructDef, StructId, SymId, TyDef, TyKind,
    };

    /// A module with a handful of shapes in it, built by hand.
    ///
    /// System V is the reason these exist. The end-to-end suite runs against a
    /// real C library, but only on the platform it is running on — and v1's
    /// System V half was written from the psABI and never executed at all
    /// (REWRITE-PLAN §6). These pin the classification on both conventions from
    /// whichever machine happens to be building.
    struct Fixture {
        module: Module,
    }

    impl Fixture {
        fn new() -> Fixture {
            let mut module = Module {
                schema_fingerprint: 0,
                name: SymId(0),
                strings: vec!["abi".into()],
                files: Vec::new(),
                types: Vec::new(),
                structs: Vec::new(),
                classes: Vec::new(),
                interfaces: Vec::new(),
                sigs: Vec::new(),
                externs: Vec::new(),
                globals: Vec::new(),
                funcs: Vec::new(),
            };
            for kind in [
                TyKind::Int(IntTy::I8),
                TyKind::Int(IntTy::I16),
                TyKind::Int(IntTy::I32),
                TyKind::Int(IntTy::I64),
                TyKind::Float(FloatTy::F32),
                TyKind::Float(FloatTy::F64),
            ] {
                module.types.push(TyDef {
                    kind,
                    category: Category::Trivial,
                });
            }
            Fixture { module }
        }

        const I8: TyId = TyId(0);
        const I32: TyId = TyId(2);
        const I64: TyId = TyId(3);
        const F32: TyId = TyId(4);
        const F64: TyId = TyId(5);

        /// Declare a struct and return the type id that refers to it.
        fn strukt(&mut self, name: &str, fields: &[TyId]) -> TyId {
            let id = StructId(self.module.structs.len() as u32);
            let name_id = SymId(self.module.strings.len() as u32);
            self.module.strings.push(name.into());
            self.module.structs.push(StructDef {
                name: name_id,
                fields: fields
                    .iter()
                    .map(|ty| FieldDef {
                        name: name_id,
                        ty: *ty,
                        span: Span::SYNTHETIC,
                    })
                    .collect(),
                c_compatible: true,
                union: false,
                span: Span::SYNTHETIC,
            });
            self.module.types.push(TyDef {
                kind: TyKind::Struct(id),
                category: Category::Trivial,
            });
            TyId(self.module.types.len() as u32 - 1)
        }

        fn param(&self, ty: TyId, conv: Conv) -> Slot {
            let mut layouts = Layouts::new(&self.module, TargetInfo::from_pointer_bits(64));
            classify_param(&mut layouts, ty, conv).unwrap()
        }

        fn ret(&self, ty: TyId, conv: Conv) -> Slot {
            let mut layouts = Layouts::new(&self.module, TargetInfo::from_pointer_bits(64));
            classify_return(&mut layouts, ty, conv).unwrap()
        }
    }

    #[test]
    fn win64_packs_one_two_four_and_eight_bytes_into_one_integer_register() {
        let mut f = Fixture::new();
        let one = f.strukt("One", &[Fixture::I8]);
        let eight = f.strukt("Pair", &[Fixture::I32, Fixture::I32]);

        assert_eq!(
            f.param(one, Conv::Win64),
            Slot::Registers {
                carriers: vec![Scalar::I8],
                size: 1,
                align: 1
            }
        );
        assert_eq!(
            f.param(eight, Conv::Win64),
            Slot::Registers {
                carriers: vec![Scalar::I64],
                size: 8,
                align: 4
            }
        );
    }

    #[test]
    fn win64_puts_two_floats_in_an_integer_register() {
        // Win64 does not classify by content: an eight-byte struct goes in a
        // general register whatever is inside it. This is exactly where System
        // V differs, and the pair of tests is the point.
        let mut f = Fixture::new();
        let two_floats = f.strukt("TwoFloats", &[Fixture::F32, Fixture::F32]);
        assert_eq!(
            f.param(two_floats, Conv::Win64),
            Slot::Registers {
                carriers: vec![Scalar::I64],
                size: 8,
                align: 4
            }
        );
    }

    #[test]
    fn win64_passes_anything_else_by_address() {
        let mut f = Fixture::new();
        let twelve = f.strukt("Twelve", &[Fixture::I32, Fixture::I32, Fixture::I32]);
        assert_eq!(
            f.param(twelve, Conv::Win64),
            Slot::ByAddress { size: 12, align: 4 }
        );
        assert_eq!(
            f.ret(twelve, Conv::Win64),
            Slot::Sret { size: 12, align: 4 }
        );
    }

    #[test]
    fn sysv_puts_two_floats_in_one_sse_register() {
        // An eightbyte is SSE only when *everything* overlapping it is a float.
        let mut f = Fixture::new();
        let two_floats = f.strukt("TwoFloats", &[Fixture::F32, Fixture::F32]);
        assert_eq!(
            f.param(two_floats, Conv::SysV),
            Slot::Registers {
                carriers: vec![Scalar::F64],
                size: 8,
                align: 4
            }
        );
    }

    #[test]
    fn sysv_puts_an_int_and_a_float_in_one_integer_register() {
        // One integer anywhere in the eightbyte makes the whole eightbyte
        // INTEGER. Getting this backwards is silent corruption, not a crash.
        let mut f = Fixture::new();
        let mixed = f.strukt("IntFloat", &[Fixture::I32, Fixture::F32]);
        assert_eq!(
            f.param(mixed, Conv::SysV),
            Slot::Registers {
                carriers: vec![Scalar::I64],
                size: 8,
                align: 4
            }
        );
    }

    #[test]
    fn sysv_splits_sixteen_bytes_into_two_eightbytes() {
        let mut f = Fixture::new();
        let two_doubles = f.strukt("TwoDoubles", &[Fixture::F64, Fixture::F64]);
        let mixed = f.strukt("Mixed", &[Fixture::I64, Fixture::F64]);

        assert_eq!(
            f.param(two_doubles, Conv::SysV),
            Slot::Registers {
                carriers: vec![Scalar::F64, Scalar::F64],
                size: 16,
                align: 8
            }
        );
        // First eightbyte integer, second all float.
        assert_eq!(
            f.param(mixed, Conv::SysV),
            Slot::Registers {
                carriers: vec![Scalar::I64, Scalar::F64],
                size: 16,
                align: 8
            }
        );
    }

    #[test]
    fn sysv_puts_more_than_sixteen_bytes_on_the_stack() {
        let mut f = Fixture::new();
        let big = f.strukt("Big", &[Fixture::I64, Fixture::I64, Fixture::I64]);
        assert_eq!(
            f.param(big, Conv::SysV),
            Slot::OnStack { size: 24, align: 8 }
        );
        // A return too large for registers goes through a hidden pointer
        // rather than onto the stack.
        assert_eq!(f.ret(big, Conv::SysV), Slot::Sret { size: 24, align: 8 });
    }

    #[test]
    fn sysv_twelve_bytes_is_two_eightbytes_where_win64_is_by_address() {
        let mut f = Fixture::new();
        let twelve = f.strukt("Twelve", &[Fixture::I32, Fixture::I32, Fixture::I32]);
        assert_eq!(
            f.param(twelve, Conv::SysV),
            Slot::Registers {
                carriers: vec![Scalar::I64, Scalar::I64],
                size: 12,
                align: 4
            }
        );
        assert_eq!(
            f.param(twelve, Conv::Win64),
            Slot::ByAddress { size: 12, align: 4 }
        );
    }

    #[test]
    fn a_nested_aggregate_flattens_for_classification() {
        // The eightbyte a field lands in is decided by its *offset*, so nesting
        // has to be walked through rather than treated as one opaque field.
        let mut f = Fixture::new();
        let pair = f.strukt("Pair", &[Fixture::F32, Fixture::F32]);
        let nested = f.strukt("Nested", &[pair]);
        assert_eq!(
            f.param(nested, Conv::SysV),
            Slot::Registers {
                carriers: vec![Scalar::F64],
                size: 8,
                align: 4
            }
        );
    }

    #[test]
    fn a_scalar_is_never_reclassified() {
        let f = Fixture::new();
        for conv in [Conv::Win64, Conv::SysV] {
            assert_eq!(
                f.param(Fixture::I32, conv),
                Slot::Plain {
                    ty: Scalar::I32,
                    signed: true
                }
            );
            assert_eq!(
                f.param(Fixture::F64, conv),
                Slot::Plain {
                    ty: Scalar::F64,
                    signed: false
                }
            );
        }
    }

    #[test]
    fn a_string_cannot_cross_the_boundary() {
        // A byte copy has to *be* the copy. A `string` field would leave the C
        // side holding a pointer it must not free.
        let mut f = Fixture::new();
        f.module.types.push(TyDef {
            kind: TyKind::Str,
            category: Category::Owning,
        });
        let string = TyId(f.module.types.len() as u32 - 1);
        let holder = f.strukt("Holder", &[string, Fixture::I32]);

        let mut layouts = Layouts::new(&f.module, TargetInfo::from_pointer_bits(64));
        let error = classify_param(&mut layouts, holder, Conv::SysV).unwrap_err();
        assert!(error.to_string().contains("owns its buffer"), "{error}");
    }

    #[test]
    fn sub_register_widths_carry_their_extension() {
        // The *rule*. How a code generator spells it is `clif.rs`'s problem,
        // and has its own test there.
        let target = TargetInfo::from_pointer_bits(64);
        assert_eq!(extension(Scalar::I8, true, target), Ext::Sext);
        assert_eq!(extension(Scalar::I8, false, target), Ext::Zext);
        assert_eq!(extension(Scalar::I16, true, target), Ext::Sext);
        // Nothing a register already holds in full needs one.
        assert_eq!(extension(Scalar::I32, true, target), Ext::None);
        assert_eq!(extension(Scalar::I64, true, target), Ext::None);
        assert_eq!(extension(Scalar::F64, false, target), Ext::None);
        assert_eq!(extension(Scalar::Ptr, false, target), Ext::None);
    }

    #[test]
    fn a_pointer_is_not_a_pointer_width_integer() {
        // `Scalar::Ptr` and `Scalar::I64` are the same register on x86-64 and
        // will not be the same LLVM type. `usize` is the integer; a
        // `Pointer<T>` is the pointer. Collapsing them is the thing this
        // vocabulary exists to prevent (LLVM-PORT stage 0).
        let mut f = Fixture::new();
        f.module.types.push(TyDef {
            kind: TyKind::Int(IntTy::Usize),
            category: Category::Trivial,
        });
        let usize_ty = TyId(f.module.types.len() as u32 - 1);
        f.module.types.push(TyDef {
            kind: TyKind::Pointer(Fixture::I32),
            category: Category::Trivial,
        });
        let pointer_ty = TyId(f.module.types.len() as u32 - 1);

        let mut layouts = Layouts::new(&f.module, TargetInfo::from_pointer_bits(64));
        assert_eq!(layouts.repr(usize_ty).unwrap(), Repr::Register(Scalar::I64));
        assert_eq!(
            layouts.repr(pointer_ty).unwrap(),
            Repr::Register(Scalar::Ptr)
        );
    }
}
