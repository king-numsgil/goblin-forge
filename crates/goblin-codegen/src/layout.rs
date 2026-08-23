//! Two questions, two answers.
//!
//! REWRITE-PLAN §5.2. v1 had one `Type::size` that meant "what a register
//! holds" in some places and "how much space this occupies" in others, and it
//! took a heap overflow and a wrong `sizeOf` to notice. So:
//!
//! * [`Layout`] answers **how many bytes does this occupy**. Array strides,
//!   field offsets, `sizeOf`, and anything the allocator is told all come
//!   from here.
//! * [`Repr`] answers **what does a register hold**, in the vocabulary of
//!   [`Scalar`]. ABI classification and parameter passing come from here.
//!
//! Nothing has one function that answers both, and no function on this page
//! returns a number that could plausibly be mistaken for the other.
//!
//! Neither answer is spelled in the code generator's types. [`Scalar`] is this
//! compiler's own and `llvm/ty.rs` translates it, which is what let the
//! classification in `abi.rs` outlive the code generator it was written
//! against (DECISIONS §17).

use goblin_mir::{FloatTy, IntTy, Module, TyId, TyKind};

use crate::error::Result;
use crate::internal_error;

/// The machine the code is being generated for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TargetInfo {
    pub pointer_bytes: u32,
}

impl TargetInfo {
    pub fn from_pointer_bits(bits: u32) -> TargetInfo {
        TargetInfo {
            pointer_bytes: bits / 8,
        }
    }

    /// The width of a machine address, in bits.
    pub fn pointer_bits(self) -> u32 {
        self.pointer_bytes * 8
    }
}

/// What one register holds, named without reference to any code generator.
///
/// **`Ptr` is deliberately not `I64`.** Cranelift has no pointer type and wants
/// the integer width; LLVM has an opaque `ptr` and wants nothing else. Folding
/// the two together here would be free today and would have to be *undone*, at
/// every load and store, by the backend that needs the distinction — which is
/// the pattern REWRITE-PLAN spends its length arguing against. So the fact is
/// written down once, and each backend spells it its own way.
///
/// A pointer-width *integer* — `usize`, `isize` — is not `Ptr`. It is the
/// integer of that width, because that is what it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scalar {
    I8,
    I16,
    I32,
    I64,
    F32,
    F64,
    /// A machine address.
    Ptr,
}

impl Scalar {
    /// How many bits this occupies on `target`.
    pub fn bits(self, target: TargetInfo) -> u32 {
        match self {
            Scalar::I8 => 8,
            Scalar::I16 => 16,
            Scalar::I32 | Scalar::F32 => 32,
            Scalar::I64 | Scalar::F64 => 64,
            Scalar::Ptr => target.pointer_bits(),
        }
    }

    /// Whether this lands in an integer register rather than an SSE one.
    ///
    /// System V's eightbyte classification is the caller that matters, and
    /// there a pointer is an INTEGER like any other.
    pub fn is_integer(self) -> bool {
        !matches!(self, Scalar::F32 | Scalar::F64)
    }

    /// The integer scalar of a given byte width, for a carrier.
    pub fn int_of_bytes(bytes: u32) -> Option<Scalar> {
        match bytes {
            1 => Some(Scalar::I8),
            2 => Some(Scalar::I16),
            4 => Some(Scalar::I32),
            8 => Some(Scalar::I64),
            _ => None,
        }
    }
}

/// How many bytes a value of some type occupies, and where its parts are.
///
/// **Nested aggregates are inline.** A field of struct type occupies its
/// layout, an array element occupies its stride, and the bytes match what a C
/// compiler produces for the same declaration. This is not negotiable if C
/// interop is a goal, and v1 had to be retrofitted for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub size: u32,
    pub align: u32,
    /// Byte offset of each field, in declaration order. Empty for scalars.
    pub fields: Vec<u32>,
}

impl Layout {
    pub fn scalar(size: u32) -> Layout {
        Layout {
            size,
            align: size.max(1),
            fields: Vec::new(),
        }
    }

    /// The stride between consecutive elements of an array of this type: the
    /// size rounded up to the alignment, exactly as C computes it.
    ///
    /// Allocating an array with one number and indexing it with another is how
    /// elements come to overlap, and it prints plausible values for a while
    /// before it stops (REWRITE-PLAN §10).
    pub fn stride(&self) -> u32 {
        align_to(self.size, self.align)
    }
}

/// How a value travels: in a register, or by address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Repr {
    /// Nothing travels at all. Only `void`.
    Void,
    /// One machine register holding this scalar.
    Register(Scalar),
    /// One *vector* register holding `lanes` copies of `elem`.
    ///
    /// Kept apart from [`Repr::Register`] rather than folded into it with a
    /// lane count of one, because everything that asks this question wants to
    /// know whether it is looking at an ABI-classifiable scalar — and a vector
    /// is not one. DECISIONS §22 keeps `Simd` out of every signature, so the
    /// honest answer at those sites is a panic rather than a classification,
    /// and that only stays honest while the two are distinguishable.
    Vector { elem: Scalar, lanes: u8 },
    /// Too large or too structured for a register. Travels by address.
    Aggregate,
}

impl Repr {
    pub fn register(self) -> Option<Scalar> {
        match self {
            Repr::Register(ty) => Some(ty),
            _ => None,
        }
    }
}

pub const fn align_to(value: u32, align: u32) -> u32 {
    if align <= 1 {
        return value;
    }
    value.div_ceil(align) * align
}

/// Computes and caches layouts for one module.
///
/// Cached because layout is asked for constantly during lowering and because a
/// struct's layout depends on its fields' layouts — recomputing the tree at
/// every field access is quadratic in nesting depth for no reason.
pub struct Layouts<'m> {
    module: &'m Module,
    target: TargetInfo,
    cache: Vec<Option<Layout>>,
}

impl<'m> Layouts<'m> {
    pub fn new(module: &'m Module, target: TargetInfo) -> Layouts<'m> {
        Layouts {
            module,
            target,
            cache: vec![None; module.types.len()],
        }
    }

    pub fn target(&self) -> TargetInfo {
        self.target
    }

    pub fn module(&self) -> &'m Module {
        self.module
    }

    /// How many bytes a `ty` occupies.
    pub fn layout(&mut self, ty: TyId) -> Result<Layout> {
        if let Some(cached) = self.cache.get(ty.index()).and_then(Option::as_ref) {
            return Ok(cached.clone());
        }

        let Some(def) = self.module.ty(ty) else {
            internal_error!("type {} is not in the module's type table", ty.0);
        };

        let pointer = self.target.pointer_bytes;
        let layout = match &def.kind {
            TyKind::Void => Layout {
                size: 0,
                align: 1,
                fields: Vec::new(),
            },
            TyKind::Bool => Layout::scalar(1),
            TyKind::Int(int) => Layout::scalar(int_bytes(*int, pointer)),
            TyKind::Float(FloatTy::F32) => Layout::scalar(4),
            TyKind::Float(FloatTy::F64) => Layout::scalar(8),
            // A vector's *alloc* size, which is what an `alloca` reserves: the
            // lanes rounded up to a power of two, which is LLVM's own answer
            // for the same type. A `<3 x double>` therefore reserves 32 bytes
            // and is 32-aligned.
            //
            // This is deliberately **not** the number of bytes a `<3 x double>`
            // load or store touches, which is 24 — that is the *store* size,
            // and it is the reason a packed `dvec3` survives a round trip
            // through a vector register (DECISIONS §22). The two differ only
            // for this type, and nothing here may quietly answer the other
            // question: a `Simd` is never a field and never an array element,
            // so no stride is ever computed from this number.
            TyKind::Simd { elem, lanes } => {
                let bytes = simd_bytes(*elem, *lanes);
                Layout {
                    size: bytes,
                    align: bytes,
                    fields: Vec::new(),
                }
            }
            // Every handle in this language is one machine word: a pointer, a
            // reference, a function pointer, a string, an array.
            TyKind::Pointer(_)
            | TyKind::Reference(_)
            | TyKind::FnPtr(_)
            | TyKind::Str
            | TyKind::CStr
            | TyKind::Array(_) => Layout::scalar(pointer),
            // `N` elements at stride intervals — stride, not size, because a
            // `{ i32, i8 }` occupies five bytes and strides by eight. Using the
            // size here overlaps the array with itself, and it prints plausible
            // values for a while before it stops (REWRITE-PLAN §10).
            // No layout, by construction. Every operation that would need one
            // is refused by the frontend, so reaching here is a missing check
            // rather than a program to report on — and answering "zero bytes,
            // aligned to one" instead would be a stride of nothing and a
            // `dealloc` with the wrong size (see `TyKind::Opaque`).
            TyKind::Opaque(name) => {
                let name = self.module.sym(*name).unwrap_or("an opaque type");
                internal_error!(
                    "`{name}` is declared elsewhere and has no layout here. \
                     Something asked for its size; the frontend should have \
                     refused whatever did."
                );
            }
            TyKind::FixedArray { element, length } => {
                let element_layout = self.layout(*element)?;
                Layout {
                    size: element_layout.stride() * (*length as u32),
                    align: element_layout.align,
                    fields: Vec::new(),
                }
            }
            TyKind::Struct(id) => {
                let Some(def) = self.module.strukt(*id) else {
                    internal_error!("struct {} is not in the module's struct table", id.0);
                };
                if def.union {
                    // Every member starts at the beginning and the whole thing
                    // is as big as the largest — C's union, which is why
                    // `sizeof(SDL_Event)` is one event and not thirty-five.
                    //
                    // The alignment is the strictest member's, not the largest
                    // member's own: a union of `{u8; u64}` is 8-aligned because
                    // the `u64` has to be, and a byte array of the same size
                    // would not be. Getting that wrong is silent on x86 and a
                    // fault elsewhere.
                    let mut size = 0u32;
                    let mut align = 1u32;
                    let mut fields = Vec::with_capacity(def.fields.len());
                    for field in &def.fields {
                        let field_layout = self.layout(field.ty)?;
                        fields.push(0);
                        size = size.max(field_layout.size);
                        align = align.max(field_layout.align);
                    }
                    Layout {
                        size: align_to(size, align),
                        align,
                        fields,
                    }
                } else {
                    // Declaration order, naturally aligned, never reordered.
                    let mut offset = 0u32;
                    let mut align = 1u32;
                    let mut fields = Vec::with_capacity(def.fields.len());
                    for field in &def.fields {
                        let field_layout = self.layout(field.ty)?;
                        offset = align_to(offset, field_layout.align);
                        fields.push(offset);
                        offset += field_layout.size;
                        align = align.max(field_layout.align);
                    }
                    Layout {
                        size: align_to(offset, align),
                        align,
                        fields,
                    }
                }
            }
            // A vtable pointer at offset 0, then the fields — base classes'
            // first, because `ClassDef::fields` is already flattened that way.
            // A `Base` is therefore a prefix of every `Derived`, in bytes and
            // in vtable slots both, which is what makes an upcast free
            // (REWRITE-PLAN §5).
            TyKind::Class(id) => {
                let Some(def) = self.module.class(*id) else {
                    internal_error!("class {} is not in the module's class table", id.0);
                };
                let mut offset = pointer;
                let mut align = pointer;
                let mut fields = Vec::with_capacity(def.fields.len());
                for field in &def.fields {
                    let field_layout = self.layout(field.ty)?;
                    offset = align_to(offset, field_layout.align);
                    fields.push(offset);
                    offset += field_layout.size;
                    align = align.max(field_layout.align);
                }
                Layout {
                    size: align_to(offset, align),
                    align,
                    fields,
                }
            }
            // `(itab, data)`, two words at fixed offsets. An aggregate of two
            // handles rather than a fat handle, which is what let this reuse
            // everything aggregates already do instead of adding a
            // two-register `Repr` (see `TyKind::Interface`).
            TyKind::Interface(_) => Layout {
                size: pointer * 2,
                align: pointer,
                fields: vec![0, pointer],
            },
        };

        if let Some(slot) = self.cache.get_mut(ty.index()) {
            *slot = Some(layout.clone());
        }
        Ok(layout)
    }

    /// What a register holds for a `ty`.
    pub fn repr(&mut self, ty: TyId) -> Result<Repr> {
        let Some(def) = self.module.ty(ty) else {
            internal_error!("type {} is not in the module's type table", ty.0);
        };

        Ok(match &def.kind {
            TyKind::Void => Repr::Void,
            // `bool` is one byte of storage and one `I8` in a register. Note
            // that this is a place where the two answers genuinely differ from
            // each other for a scalar, which is why they are two functions.
            TyKind::Bool => Repr::Register(Scalar::I8),
            TyKind::Int(int) => Repr::Register(int_scalar(*int, self.target)),
            TyKind::Float(FloatTy::F32) => Repr::Register(Scalar::F32),
            TyKind::Float(FloatTy::F64) => Repr::Register(Scalar::F64),
            TyKind::Simd { elem, lanes } => Repr::Vector {
                elem: float_scalar(*elem),
                lanes: *lanes,
            },
            TyKind::Pointer(_)
            | TyKind::Reference(_)
            | TyKind::FnPtr(_)
            | TyKind::Str
            | TyKind::CStr
            | TyKind::Array(_) => Repr::Register(Scalar::Ptr),
            // Too big for a register, and it travels by address like any other
            // aggregate.
            TyKind::FixedArray { .. }
            | TyKind::Struct(_)
            | TyKind::Class(_)
            | TyKind::Interface(_) => Repr::Aggregate,
            // An opaque type has no value form at all — it is only ever
            // something a pointer points at — so there is no register that
            // holds one and no aggregate to travel by address.
            TyKind::Opaque(name) => {
                let name = self.module.sym(*name).unwrap_or("an opaque type");
                internal_error!(
                    "`{name}` is declared elsewhere and has no value form here. \
                     Only a `Pointer<{name}>` can travel."
                );
            }
        })
    }
}

/// How many bytes an `alloca` of a vector reserves.
///
/// The lanes rounded up to a power of two, matching LLVM's alloc size and ABI
/// alignment for the same type on x86-64.
pub fn simd_bytes(elem: FloatTy, lanes: u8) -> u32 {
    let width = match elem {
        FloatTy::F32 => 4,
        FloatTy::F64 => 8,
    };
    (width * u32::from(lanes)).next_power_of_two()
}

fn float_scalar(float: FloatTy) -> Scalar {
    match float {
        FloatTy::F32 => Scalar::F32,
        FloatTy::F64 => Scalar::F64,
    }
}

fn int_bytes(int: IntTy, pointer_bytes: u32) -> u32 {
    match int.bits() {
        Some(bits) => bits / 8,
        None => pointer_bytes,
    }
}

/// `usize` and `isize` have no width of their own — they are whatever an
/// address is wide — so they are the *integer* of that width, not [`Scalar::Ptr`].
fn int_scalar(int: IntTy, target: TargetInfo) -> Scalar {
    match int.bits() {
        Some(8) => Scalar::I8,
        Some(16) => Scalar::I16,
        Some(32) => Scalar::I32,
        Some(64) => Scalar::I64,
        _ => Scalar::int_of_bytes(target.pointer_bytes).unwrap_or(Scalar::I64),
    }
}

/// How a type is spelled, for a diagnostic or a differential-test failure.
pub fn render_type(module: &Module, ty: TyId) -> String {
    let Some(def) = module.ty(ty) else {
        return format!("<ty{}>", ty.0);
    };
    match &def.kind {
        TyKind::Void => "void".into(),
        TyKind::Bool => "bool".into(),
        TyKind::Int(int) => format!("{int:?}").to_lowercase(),
        TyKind::Float(float) => format!("{float:?}").to_lowercase(),
        TyKind::Simd { elem, lanes } => {
            format!("<{lanes} x {}>", format!("{elem:?}").to_lowercase())
        }
        TyKind::Pointer(inner) => format!("Pointer<{}>", render_type(module, *inner)),
        TyKind::Reference(inner) => format!("Reference<{}>", render_type(module, *inner)),
        TyKind::FnPtr(_) => "fn".into(),
        TyKind::Str => "string".into(),
        TyKind::CStr => "CString".into(),
        TyKind::Array(inner) => format!("{}[]", render_type(module, *inner)),
        TyKind::Class(id) => module
            .class(*id)
            .and_then(|class| module.sym(class.name))
            .unwrap_or("<class>")
            .into(),
        TyKind::Interface(id) => module
            .interface(*id)
            .and_then(|def| module.sym(def.name))
            .unwrap_or("<interface>")
            .into(),
        TyKind::Opaque(name) => module.sym(*name).unwrap_or("<opaque>").into(),
        TyKind::FixedArray { element, length } => {
            format!("FixedArray<{}, {length}>", render_type(module, *element))
        }
        TyKind::Struct(id) => module
            .strukt(*id)
            .and_then(|def| module.sym(def.name))
            .unwrap_or("<struct>")
            .to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stride_rounds_size_up_to_alignment() {
        // A `{ i32, i8 }` is 8 bytes with 4-byte alignment, so consecutive
        // elements are 8 apart, not 5. Getting this wrong makes an array
        // overlap its own elements.
        let layout = Layout {
            size: 5,
            align: 4,
            fields: vec![0, 4],
        };
        assert_eq!(layout.stride(), 8);
    }

    #[test]
    fn a_scalar_strides_by_its_own_size() {
        assert_eq!(Layout::scalar(4).stride(), 4);
        assert_eq!(Layout::scalar(1).stride(), 1);
    }

    #[test]
    fn align_to_leaves_aligned_values_alone() {
        assert_eq!(align_to(8, 4), 8);
        assert_eq!(align_to(9, 4), 12);
        assert_eq!(align_to(9, 1), 9);
    }
}
