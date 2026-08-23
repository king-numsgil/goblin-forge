//! Vector arithmetic, as LLVM writes it.
//!
//! DECISIONS §22. Everything here is a *primitive*: a load, a store, a lane
//! shuffle, one elementwise operation. There is no `dot` in this file and there
//! should never be one — `dot` is a multiply, a shuffle and two adds emitted by
//! the lowerer, so the algorithm lives in the frontend where it can be read
//! alongside the rest of the language, and this file stays a lookup table.
//!
//! The one thing worth understanding before changing anything:
//!
//! **A vector's store size and its alloc size are different numbers, and both
//! are used here.** A `<3 x double>` touches 24 bytes when loaded or stored and
//! reserves 32 when `alloca`'d. That is what lets a packed `dvec3` — three
//! `f64` and nothing else, the shape a vertex buffer wants — be loaded whole
//! into a vector register and written back without disturbing the byte after
//! it. So a load or store against a *struct* place carries the struct's
//! alignment (8), never the vector's (32), and getting that backwards would
//! claim an alignment the struct does not have.

use goblin_mir::{FloatTy, Operand, Place, Rvalue, SimdBinOp, SimdUnOp, TyId, TyKind};

use crate::error::{InternalError, Result};
use crate::internal_error;
use crate::llvm::func::{Emitter, Val};

/// The shape of a vector type: what one lane is, and how many there are.
#[derive(Debug, Clone, Copy)]
pub(super) struct Shape {
    pub lanes: u8,
    pub elem: FloatTy,
}

impl Shape {
    /// `<3 x double>` — the type as every use site spells it.
    fn ty(self) -> String {
        format!("<{} x {}>", self.lanes, self.scalar())
    }

    fn scalar(self) -> &'static str {
        match self.elem {
            FloatTy::F32 => "float",
            FloatTy::F64 => "double",
        }
    }

    /// `v3f64` — LLVM's overload suffix for an intrinsic on this type.
    fn suffix(self) -> String {
        let bits = match self.elem {
            FloatTy::F32 => 32,
            FloatTy::F64 => 64,
        };
        format!("v{}f{bits}", self.lanes)
    }
}

impl Emitter<'_, '_> {
    /// The shape of a [`TyKind::Simd`], or a panic naming what was found.
    pub(super) fn simd_shape(&self, ty: TyId) -> Result<Shape> {
        match self.module.ty(ty).map(|def| &def.kind) {
            Some(TyKind::Simd { elem, lanes }) => Ok(Shape {
                lanes: *lanes,
                elem: *elem,
            }),
            _ => internal_error!(
                "`{}` is not a vector type",
                crate::layout::render_type(self.module, ty)
            ),
        }
    }

    /// Read a whole vector out of a struct place.
    ///
    /// The alignment is the **struct's**, because that is what the memory
    /// actually guarantees: a `dvec3` is a struct of `f64` and therefore
    /// 8-aligned, whatever alignment LLVM would pick for a `<3 x double>` of
    /// its own accord.
    pub(super) fn simd_load(&mut self, source: &Place, ty: TyId) -> Result<Val> {
        let shape = self.simd_shape(ty)?;
        let source_ty = self.place_type(source)?;
        let align = self.layouts.layout(source_ty)?.align.max(1);
        let address = self.address(source)?;
        let out = self.tmp();
        let vector = shape.ty();
        self.line(format!(
            "{out} = load {vector}, ptr {address}, align {align}"
        ));
        Ok(Val::new(vector, out))
    }

    /// Write a vector into a struct place — [`Emitter::simd_load`] backwards,
    /// with the same alignment reasoning.
    pub(super) fn simd_store(&mut self, dest: &str, vector: &Operand, align: u32) -> Result<()> {
        let value = self
            .operand(vector)?
            .ok_or_else(|| InternalError::new("a vector store with no value"))?;
        self.line(format!(
            "store {} {}, ptr {dest}, align {align}",
            value.ty, value.name
        ));
        Ok(())
    }

    /// Every SIMD rvalue that produces a value.
    ///
    /// [`Rvalue::SimdStore`] is not among them: it writes into a destination
    /// rather than yielding something, so it is handled where aggregates are
    /// filled in place.
    pub(super) fn simd_rvalue(&mut self, rvalue: &Rvalue) -> Result<Val> {
        match rvalue {
            Rvalue::SimdLoad { source, ty } => self.simd_load(source, *ty),

            // Built from `poison` rather than `zeroinitializer`: every lane is
            // written before the value is used, so naming a starting value
            // would be inventing a fact about lanes that do not exist yet.
            Rvalue::SimdFromParts { lanes, ty } => {
                let shape = self.simd_shape(*ty)?;
                if lanes.len() != usize::from(shape.lanes) {
                    internal_error!(
                        "a {}-lane vector was built from {} values",
                        shape.lanes,
                        lanes.len()
                    );
                }
                let vector = shape.ty();
                let mut current = "poison".to_owned();
                for (lane, operand) in lanes.iter().enumerate() {
                    let value = self
                        .operand(operand)?
                        .ok_or_else(|| InternalError::new("a vector lane with no value"))?;
                    let out = self.tmp();
                    self.line(format!(
                        "{out} = insertelement {vector} {current}, {} {}, i32 {lane}",
                        value.ty, value.name
                    ));
                    current = out;
                }
                Ok(Val::new(vector, current))
            }

            Rvalue::SimdExtract { vector, lane } => {
                let value = self
                    .operand(vector)?
                    .ok_or_else(|| InternalError::new("an extract with no vector"))?;
                let element = element_of(&value.ty)?;
                let out = self.tmp();
                self.line(format!(
                    "{out} = extractelement {} {}, i32 {lane}",
                    value.ty, value.name
                ));
                Ok(Val::new(element, out))
            }

            // One insert and a broadcast shuffle, which is the idiom LLVM
            // recognises and turns into `vbroadcastsd`.
            Rvalue::SimdSplat { value, ty } => {
                let shape = self.simd_shape(*ty)?;
                let scalar = self
                    .operand(value)?
                    .ok_or_else(|| InternalError::new("a splat with no value"))?;
                let vector = shape.ty();
                let one = self.tmp();
                self.line(format!(
                    "{one} = insertelement {vector} poison, {} {}, i32 0",
                    scalar.ty, scalar.name
                ));
                let mask = (0..shape.lanes)
                    .map(|_| "i32 0".to_owned())
                    .collect::<Vec<_>>()
                    .join(", ");
                let out = self.tmp();
                self.line(format!(
                    "{out} = shufflevector {vector} {one}, {vector} poison, <{} x i32> <{mask}>",
                    shape.lanes
                ));
                Ok(Val::new(vector, out))
            }

            Rvalue::SimdBinary { op, lhs, rhs } => {
                let left = self
                    .operand(lhs)?
                    .ok_or_else(|| InternalError::new("a vector operation with no left operand"))?;
                let right = self
                    .operand(rhs)?
                    .ok_or_else(|| InternalError::new("a vector operation with no right operand"))?;
                let vector = left.ty.clone();
                // No fast-math flags, here or anywhere in this file: results
                // are IEEE and reproducible, and a contraction happens only
                // where `SimdFma` says it does (DECISIONS §22).
                let instruction = match op {
                    SimdBinOp::Add => "fadd",
                    SimdBinOp::Sub => "fsub",
                    SimdBinOp::Mul => "fmul",
                    SimdBinOp::Div => "fdiv",
                    // `minnum`/`maxnum` rather than a compare and a select:
                    // one instruction, and the NaN rule is the intrinsic's
                    // documented one rather than something decided here by
                    // accident. They match `dmin`/`dmax` in `std/math`.
                    SimdBinOp::Min | SimdBinOp::Max => {
                        let shape = shape_of(&vector)?;
                        let name = if matches!(op, SimdBinOp::Min) {
                            "minnum"
                        } else {
                            "maxnum"
                        };
                        return self.simd_intrinsic(
                            &format!("llvm.{name}.{}", shape.suffix()),
                            &vector,
                            &[left, right],
                        );
                    }
                };
                let out = self.tmp();
                self.line(format!(
                    "{out} = {instruction} {vector} {}, {}",
                    left.name, right.name
                ));
                Ok(Val::new(vector, out))
            }

            Rvalue::SimdUnary { op, operand } => {
                let value = self
                    .operand(operand)?
                    .ok_or_else(|| InternalError::new("a vector operation with no operand"))?;
                let vector = value.ty.clone();
                // `fneg` is an instruction; the rest are intrinsics. Negation
                // is deliberately not `0.0 - x`, which gets the sign of zero
                // wrong.
                if matches!(op, SimdUnOp::Neg) {
                    let out = self.tmp();
                    self.line(format!("{out} = fneg {vector} {}", value.name));
                    return Ok(Val::new(vector, out));
                }
                let shape = shape_of(&vector)?;
                let name = match op {
                    SimdUnOp::Abs => "fabs",
                    SimdUnOp::Sqrt => "sqrt",
                    SimdUnOp::Floor => "floor",
                    SimdUnOp::Ceil => "ceil",
                    SimdUnOp::Round => "round",
                    SimdUnOp::Trunc => "trunc",
                    SimdUnOp::Neg => unreachable!("handled above"),
                };
                self.simd_intrinsic(
                    &format!("llvm.{name}.{}", shape.suffix()),
                    &vector,
                    &[value],
                )
            }

            Rvalue::SimdShuffle {
                lhs,
                rhs,
                mask,
                ty,
            } => {
                let shape = self.simd_shape(*ty)?;
                let left = self
                    .operand(lhs)?
                    .ok_or_else(|| InternalError::new("a shuffle with no left operand"))?;
                let right = self
                    .operand(rhs)?
                    .ok_or_else(|| InternalError::new("a shuffle with no right operand"))?;
                if mask.len() != usize::from(shape.lanes) {
                    internal_error!(
                        "a {}-lane shuffle was given {} mask entries",
                        shape.lanes,
                        mask.len()
                    );
                }
                let entries = mask
                    .iter()
                    .map(|lane| format!("i32 {lane}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                let out = self.tmp();
                self.line(format!(
                    "{out} = shufflevector {} {}, {} {}, <{} x i32> <{entries}>",
                    left.ty, left.name, right.ty, right.name, shape.lanes
                ));
                Ok(Val::new(shape.ty(), out))
            }

            // One rounding rather than two, asked for by name. On the v3
            // baseline this selects `vfmadd213pd` with no fast-math flags at
            // all — which is the whole reason the flags are not needed.
            Rvalue::SimdFma { a, b, c } => {
                let va = self
                    .operand(a)?
                    .ok_or_else(|| InternalError::new("an fma with no multiplicand"))?;
                let vb = self
                    .operand(b)?
                    .ok_or_else(|| InternalError::new("an fma with no multiplier"))?;
                let vc = self
                    .operand(c)?
                    .ok_or_else(|| InternalError::new("an fma with no addend"))?;
                let vector = va.ty.clone();
                let shape = shape_of(&vector)?;
                self.simd_intrinsic(
                    &format!("llvm.fma.{}", shape.suffix()),
                    &vector,
                    &[va, vb, vc],
                )
            }

            other => internal_error!("{other:?} is not a vector operation"),
        }
    }

    /// Call an LLVM intrinsic whose operands and result are all one vector
    /// type, declaring it on the way.
    fn simd_intrinsic(&mut self, name: &str, vector: &str, args: &[Val]) -> Result<Val> {
        let params = std::iter::repeat_n(vector, args.len())
            .collect::<Vec<_>>()
            .join(", ");
        self.intrinsic(&format!("declare {vector} @{name}({params})"));
        let arguments = args
            .iter()
            .map(|arg| format!("{vector} {}", arg.name))
            .collect::<Vec<_>>()
            .join(", ");
        let out = self.tmp();
        self.line(format!("{out} = call {vector} @{name}({arguments})"));
        Ok(Val::new(vector, out))
    }
}

/// The element type of a rendered vector: `double` from `<3 x double>`.
fn element_of(vector: &str) -> Result<String> {
    vector
        .rsplit_once(" x ")
        .and_then(|(_, tail)| tail.strip_suffix('>'))
        .map(str::to_owned)
        .ok_or_else(|| InternalError::new(format!("`{vector}` is not a vector type")))
}

/// A [`Shape`] read back off a rendered vector type.
///
/// Recovered from the text rather than threaded through every call, because the
/// operand it describes has already been rendered by the time an intrinsic name
/// needs its suffix — and the alternative is passing a `TyId` alongside every
/// `Val` purely so this one question can be asked twice.
fn shape_of(vector: &str) -> Result<Shape> {
    let malformed = || InternalError::new(format!("`{vector}` is not a vector type"));
    let inner = vector
        .strip_prefix('<')
        .and_then(|rest| rest.strip_suffix('>'))
        .ok_or_else(malformed)?;
    let (lanes, elem) = inner.split_once(" x ").ok_or_else(malformed)?;
    Ok(Shape {
        lanes: lanes.parse().map_err(|_| malformed())?,
        elem: match elem {
            "float" => FloatTy::F32,
            "double" => FloatTy::F64,
            _ => return Err(malformed()),
        },
    })
}
