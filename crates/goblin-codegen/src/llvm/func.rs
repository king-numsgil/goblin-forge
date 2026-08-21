//! MIR function bodies as LLVM IR.
//!
//! LLVM-PORT stage 3. The MIR is already a CFG, so this is close to a
//! transcription — and, as in `translate.rs`, it is **not** a place where
//! decisions get made. Copy versus move, initialisation versus assignment,
//! where a drop goes: all settled by the frontend, and this file obeys.
//!
//! ## Every local is an `alloca`
//!
//! `translate.rs` decides per local between an SSA `Variable` and a stack slot,
//! because cranelift-frontend builds SSA and inserts block parameters. LLVM has
//! no such helper and needs none: MIR blocks carry no parameters, so the answer
//! is clang's own — one `alloca` per local in the entry block, and `mem2reg`
//! builds the SSA. The three-way `LocalSlot` collapses to one case.
//!
//! The consequence, said out loud so it is not discovered as a regression: at
//! `optLevel: "none"` LLVM does not run `mem2reg`, so every local really does
//! live in memory. That is exactly what `clang -O0` does, it is correct, and it
//! is why a debug build compiled this way is slower than the Cranelift one.
//!
//! ## No poison, deliberately
//!
//! No `nsw`, no `nuw`, no `noalias`, no TBAA, no fast-math flags. DECISIONS §17
//! names the hazard: LLVM has an undefined-behaviour surface Cranelift does not,
//! and the way it bites is asserting one of these *accidentally* and having it
//! be true for two years. Arithmetic here wraps, because the language says it
//! wraps. [`Emitter::binary`] is the one place a flag could go and it does not.

use std::collections::BTreeSet;

use goblin_mir::{
    Abi, BinOp, BlockId, BlockKind, CastKind, Category, Const, FloatTy, FuncRef, Function, LocalId,
    Module, Operand, Place, Projection, Rvalue, Statement, Terminator, TyId, TyKind, UnOp,
};

use crate::abi::{self, Conv, Slot};
use crate::error::{InternalError, Result};
use crate::internal_error;
use crate::layout::{Layouts, Repr, TargetInfo};
use crate::llvm::data::Globals;
use crate::llvm::sig;
use crate::llvm::ty::{Types, ident, scalar};
use crate::llvm::{Literals, Symbols};
use crate::runtime::STRING_HEADER_BYTES;

/// A value and the type it is of, so a use site can spell both.
#[derive(Debug, Clone)]
pub struct Val {
    pub ty: String,
    pub name: String,
}

impl Val {
    fn new(ty: impl Into<String>, name: impl Into<String>) -> Val {
        Val {
            ty: ty.into(),
            name: name.into(),
        }
    }

    /// `i32 %v7` — the form every operand position takes.
    fn used(&self) -> String {
        format!("{} {}", self.ty, self.name)
    }
}

/// Where one MIR local lives. Always memory; see the module note.
#[derive(Debug, Clone)]
enum Local {
    /// An `alloca` holding the value.
    Slot { ptr: String, align: u32 },
    /// An `alloca` holding a *pointer to* the value — an aggregate parameter,
    /// which arrives as the address of the caller's copy.
    Indirect { ptr: String },
    /// A `void` local: the return place of a `void` function. Never read.
    Empty,
}

pub struct Emitter<'a, 'm> {
    module: &'m Module,
    layouts: &'a mut Layouts<'m>,
    types: &'a mut Types,
    globals: &'a mut Globals,
    literals: &'a mut Literals,
    symbols: &'a Symbols,
    /// Intrinsic declarations discovered while emitting, deduplicated.
    intrinsics: &'a mut BTreeSet<String>,
    conv: Conv,
    target: TargetInfo,
    out: String,
    next: u32,
    locals: Vec<Local>,
    local_types: Vec<TyId>,
    /// The caller's storage for an aggregate return, when there is one.
    sret: Option<String>,
}

impl<'a, 'm> Emitter<'a, 'm> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        module: &'m Module,
        layouts: &'a mut Layouts<'m>,
        types: &'a mut Types,
        globals: &'a mut Globals,
        literals: &'a mut Literals,
        symbols: &'a Symbols,
        intrinsics: &'a mut BTreeSet<String>,
        conv: Conv,
    ) -> Emitter<'a, 'm> {
        let target = layouts.target();
        Emitter {
            module,
            layouts,
            types,
            globals,
            literals,
            symbols,
            intrinsics,
            conv,
            target,
            out: String::new(),
            next: 0,
            locals: Vec::new(),
            local_types: Vec::new(),
            sret: None,
        }
    }

    // -- emission primitives -------------------------------------------------

    fn tmp(&mut self) -> String {
        self.next += 1;
        format!("%v{}", self.next)
    }

    fn line(&mut self, text: impl AsRef<str>) {
        self.out.push_str("  ");
        self.out.push_str(text.as_ref());
        self.out.push('\n');
    }

    fn label(&mut self, block: BlockId) {
        self.out.push_str(&format!("bb{}:\n", block.0));
    }

    fn pointer_bytes(&self) -> u32 {
        self.target.pointer_bytes
    }

    /// Declare an LLVM intrinsic the first time it is used.
    fn intrinsic(&mut self, declaration: &str) {
        self.intrinsics.insert(declaration.to_owned());
    }

    fn memcpy(&mut self, dest: &str, source: &str, size: u32, align: u32) {
        if size == 0 {
            return;
        }
        self.intrinsic(
            "declare void @llvm.memcpy.p0.p0.i64(ptr noalias writeonly, ptr noalias readonly, i64, i1 immarg)",
        );
        let align = align.max(1);
        self.line(format!(
            "call void @llvm.memcpy.p0.p0.i64(ptr align {align} {dest}, ptr align {align} {source}, i64 {size}, i1 false)"
        ));
    }

    // -- the function --------------------------------------------------------

    /// Emit `define … { … }` for one function.
    pub fn function(
        mut self,
        func: &Function,
        rendered: &sig::Rendered,
        symbol: &str,
    ) -> Result<String> {
        let params = self.bind_header(func, rendered)?;

        // The entry block is written first so every `alloca` lands there, which
        // is what makes them promotable at all: an `alloca` in a loop body is a
        // fresh allocation per iteration and `mem2reg` will not touch it.
        self.out.push_str("entry:\n");
        self.allocate_locals(func)?;
        self.store_parameters(func, rendered)?;
        self.line(format!("br label %bb{}", BlockId::ENTRY.0));

        for (index, block) in func.blocks.iter().enumerate() {
            self.out.push('\n');
            self.label(BlockId(index as u32));

            if block.kind == BlockKind::Cleanup {
                // Cleanup paths exist in the MIR from the start so drop
                // elaboration can compute them while placing drops
                // (REWRITE-PLAN §11.5). Nothing can unwind yet, so reaching one
                // is impossible; a trap keeps the object file honest about it.
                self.trap();
                continue;
            }

            for statement in &block.statements {
                self.statement(statement)?;
            }
            self.terminator(&block.terminator, func)?;
        }

        let linkage = match func.linkage {
            goblin_mir::Linkage::Export => "",
            goblin_mir::Linkage::Internal => "internal ",
        };
        Ok(format!(
            "define {linkage}{} @{}({}) {{\n{}}}\n",
            rendered.returns,
            ident(symbol),
            params.join(", "),
            self.out
        ))
    }

    /// The parameter list, with a name bound to each incoming value.
    fn bind_header(&mut self, func: &Function, rendered: &sig::Rendered) -> Result<Vec<String>> {
        let signature = self
            .module
            .sig(func.sig)
            .ok_or_else(|| InternalError::new(format!("signature {} is missing", func.sig.0)))?;
        if signature.abi == Abi::C {
            let shape = abi::classify(self.layouts, signature, self.conv)?;
            if shape
                .params
                .iter()
                .any(|slot| !matches!(slot, Slot::Plain { .. } | Slot::None))
                || matches!(shape.returns, Slot::Registers { .. } | Slot::Sret { .. })
            {
                internal_error!(
                    "an exported function whose C signature passes an aggregate is not \
                     lowered yet (LLVM-PORT stage 3b)"
                );
            }
        }

        Ok(rendered
            .params
            .iter()
            .enumerate()
            .map(|(index, param)| format!("{param} %arg{index}"))
            .collect())
    }

    /// One `alloca` per local, all in the entry block.
    fn allocate_locals(&mut self, func: &Function) -> Result<()> {
        let signature = self
            .module
            .sig(func.sig)
            .ok_or_else(|| InternalError::new(format!("signature {} is missing", func.sig.0)))?;
        let param_count = signature.params.len();
        let internal = signature.abi != Abi::C;

        for (index, decl) in func.locals.iter().enumerate() {
            self.local_types.push(decl.ty);
            let repr = self.layouts.repr(decl.ty)?;

            // An aggregate parameter under the internal convention arrives as
            // the address of the caller's copy, so the local *is* that address
            // rather than storage of its own — copying it into a fresh slot
            // would be a second copy of an argument already copied once.
            if internal && matches!(repr, Repr::Aggregate) && (1..=param_count).contains(&index) {
                let ptr = format!("%p{index}");
                self.line(format!(
                    "{ptr} = alloca ptr, align {}",
                    self.pointer_bytes()
                ));
                self.locals.push(Local::Indirect { ptr });
                continue;
            }

            match repr {
                Repr::Void => self.locals.push(Local::Empty),
                Repr::Register(value) => {
                    let ptr = format!("%p{index}");
                    let layout = self.layouts.layout(decl.ty)?;
                    let align = layout.align.max(1);
                    let ty = scalar(value);
                    self.line(format!("{ptr} = alloca {ty}, align {align}"));
                    self.locals.push(Local::Slot { ptr, align });
                }
                Repr::Aggregate => {
                    let ptr = format!("%p{index}");
                    let layout = self.layouts.layout(decl.ty)?;
                    let (size, align) = (layout.size.max(1), layout.align.max(1));
                    // Bytes rather than the named type: the size is ours and
                    // this way there is one place that decides it.
                    self.line(format!("{ptr} = alloca [{size} x i8], align {align}"));
                    self.locals.push(Local::Slot { ptr, align });
                }
            }
        }
        Ok(())
    }

    fn store_parameters(&mut self, func: &Function, rendered: &sig::Rendered) -> Result<()> {
        let mut next = 0usize;
        if rendered.sret {
            self.sret = Some("%arg0".to_owned());
            next = 1;
        }

        let signature = self
            .module
            .sig(func.sig)
            .ok_or_else(|| InternalError::new(format!("signature {} is missing", func.sig.0)))?;
        for index in 0..signature.params.len() {
            let local = LocalId::param(index as u32);
            let argument = format!("%arg{next}");
            next += 1;
            match self.local(local)?.clone() {
                Local::Indirect { ptr } => {
                    self.line(format!(
                        "store ptr {argument}, ptr {ptr}, align {}",
                        self.pointer_bytes()
                    ));
                }
                Local::Slot { ptr, align } => {
                    let ty = self.value_type(self.local_types[local.index()])?;
                    self.line(format!("store {ty} {argument}, ptr {ptr}, align {align}"));
                }
                Local::Empty => internal_error!("a parameter cannot have type `void`"),
            }
        }
        Ok(())
    }

    fn local(&self, local: LocalId) -> Result<&Local> {
        self.locals
            .get(local.index())
            .ok_or_else(|| InternalError::new(format!("local _{} is not declared", local.0)))
    }

    // -- types ---------------------------------------------------------------

    /// The LLVM type a register holds for `ty`.
    fn value_type(&mut self, ty: TyId) -> Result<String> {
        match self.layouts.repr(ty)? {
            Repr::Register(value) => Ok(scalar(value).to_owned()),
            Repr::Void => Ok("void".to_owned()),
            Repr::Aggregate => Ok("ptr".to_owned()),
        }
    }

    fn is_aggregate(&mut self, ty: TyId) -> Result<bool> {
        Ok(matches!(self.layouts.repr(ty)?, Repr::Aggregate))
    }

    fn category(&self, ty: TyId) -> Result<Category> {
        self.module
            .ty(ty)
            .map(|def| def.category)
            .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))
    }

    fn signed(&self, ty: TyId) -> bool {
        matches!(self.module.ty(ty).map(|def| &def.kind), Some(TyKind::Int(int)) if int.is_signed())
    }

    /// The type one projection step lands on.
    fn projected(&self, ty: TyId, step: &Projection) -> Result<TyId> {
        let Some(def) = self.module.ty(ty) else {
            return Err(InternalError::new(format!("type {} is missing", ty.0)));
        };
        Ok(match (step, &def.kind) {
            (Projection::Deref, TyKind::Pointer(inner) | TyKind::Reference(inner)) => *inner,
            (Projection::Field(field), TyKind::Struct(id)) => self
                .module
                .strukt(*id)
                .and_then(|def| def.fields.get(field.index()))
                .map(|def| def.ty)
                .ok_or_else(|| {
                    InternalError::new(format!("struct {} has no field {}", id.0, field.0))
                })?,
            (Projection::Field(field), TyKind::Class(id)) => self
                .module
                .class(*id)
                .and_then(|def| def.fields.get(field.index()))
                .map(|def| def.ty)
                .ok_or_else(|| {
                    InternalError::new(format!("class {} has no field {}", id.0, field.0))
                })?,
            (
                Projection::Index(_) | Projection::ConstIndex(_),
                TyKind::Array(element) | TyKind::FixedArray { element, .. },
            ) => *element,
            (step, kind) => internal_error!(
                "{step:?} does not apply to a {}",
                crate::layout::render_type(self.module, {
                    let _ = kind;
                    ty
                })
            ),
        })
    }

    fn place_type(&self, place: &Place) -> Result<TyId> {
        let mut ty = *self.local_types.get(place.local.index()).ok_or_else(|| {
            InternalError::new(format!("local _{} is not declared", place.local.0))
        })?;
        for step in &place.projection {
            ty = self.projected(ty, step)?;
        }
        Ok(ty)
    }

    fn operand_type(&self, operand: &Operand) -> Result<TyId> {
        match operand {
            Operand::Copy(place) | Operand::Move(place) | Operand::Borrow(place) => {
                self.place_type(place)
            }
            Operand::Const(constant) => match constant {
                Const::Int { ty, .. }
                | Const::Float { ty, .. }
                | Const::Null(ty)
                | Const::Bool { ty, .. }
                | Const::Str { ty, .. }
                | Const::Func { ty, .. } => Ok(*ty),
                Const::Unit => Err(InternalError::new("`unit` has no type")),
            },
        }
    }

    // -- places --------------------------------------------------------------

    /// The address a place denotes.
    fn address(&mut self, place: &Place) -> Result<String> {
        let mut address = match self.local(place.local)?.clone() {
            Local::Slot { ptr, .. } => ptr,
            Local::Indirect { ptr } => {
                let out = self.tmp();
                self.line(format!(
                    "{out} = load ptr, ptr {ptr}, align {}",
                    self.pointer_bytes()
                ));
                out
            }
            Local::Empty => internal_error!("_{} has no storage", place.local.0),
        };

        let mut ty = self.local_types[place.local.index()];
        for step in &place.projection {
            address = match step {
                // Never a retype: the pointer is *loaded*, and what comes out is
                // an address into somebody else's storage (REWRITE-PLAN §10).
                Projection::Deref => {
                    let out = self.tmp();
                    self.line(format!(
                        "{out} = load ptr, ptr {address}, align {}",
                        self.pointer_bytes()
                    ));
                    out
                }
                Projection::Field(field) => {
                    let offset = self.field_offset(ty, field.index())?;
                    self.offset(&address, offset as i64)
                }
                Projection::ConstIndex(index) => {
                    let element = self.projected(ty, step)?;
                    let stride = self.layouts.layout(element)?.stride();
                    let base = self.array_base(ty, &address)?;
                    self.offset(&base, (stride as i64) * (*index as i64))
                }
                Projection::Index(local) => {
                    let element = self.projected(ty, step)?;
                    let stride = self.layouts.layout(element)?.stride();
                    let base = self.array_base(ty, &address)?;
                    let index = self.load_local(*local)?;
                    let widened = self.as_pointer_width(&index)?;
                    let scaled = self.tmp();
                    self.line(format!("{scaled} = mul i64 {widened}, {stride}"));
                    let out = self.tmp();
                    self.line(format!(
                        "{out} = getelementptr inbounds i8, ptr {base}, i64 {scaled}"
                    ));
                    out
                }
            };
            ty = self.projected(ty, step)?;
        }
        Ok(address)
    }

    /// A `T[]` is a handle; its elements live behind it. A `FixedArray` is
    /// inline, so its address is already its first element.
    fn array_base(&mut self, ty: TyId, address: &str) -> Result<String> {
        match self.module.ty(ty).map(|def| &def.kind) {
            Some(TyKind::Array(_)) => {
                internal_error!("indexing a `T[]` is not lowered yet (LLVM-PORT stage 3b)")
            }
            _ => Ok(address.to_owned()),
        }
    }

    fn field_offset(&mut self, ty: TyId, field: usize) -> Result<u32> {
        let layout = self.layouts.layout(ty)?;
        layout
            .fields
            .get(field)
            .copied()
            .ok_or_else(|| InternalError::new(format!("type {} has no field {field}", ty.0)))
    }

    /// A constant byte offset from an address, folded when it is zero.
    fn offset(&mut self, address: &str, bytes: i64) -> String {
        if bytes == 0 {
            return address.to_owned();
        }
        let out = self.tmp();
        self.line(format!(
            "{out} = getelementptr inbounds i8, ptr {address}, i64 {bytes}"
        ));
        out
    }

    fn as_pointer_width(&mut self, value: &Val) -> Result<String> {
        Ok(match value.ty.as_str() {
            "i64" => value.name.clone(),
            "ptr" => {
                let out = self.tmp();
                self.line(format!("{out} = ptrtoint ptr {} to i64", value.name));
                out
            }
            other => {
                let out = self.tmp();
                // An index is widened, not reinterpreted: a negative `i32`
                // index would otherwise become an enormous offset.
                let op = if other.starts_with('i') {
                    "sext"
                } else {
                    "zext"
                };
                self.line(format!("{out} = {op} {other} {} to i64", value.name));
                out
            }
        })
    }

    fn load_local(&mut self, local: LocalId) -> Result<Val> {
        let ty = self.local_types[local.index()];
        self.load(&Place::local(local), ty)
    }

    /// Read a scalar place.
    fn load(&mut self, place: &Place, ty: TyId) -> Result<Val> {
        let value_ty = self.value_type(ty)?;
        let address = self.address(place)?;
        let align = self.layouts.layout(ty)?.align.max(1);
        let out = self.tmp();
        self.line(format!(
            "{out} = load {value_ty}, ptr {address}, align {align}"
        ));
        Ok(Val::new(value_ty, out))
    }

    fn store(&mut self, address: &str, value: &Val, align: u32) {
        self.line(format!(
            "store {} {}, ptr {address}, align {align}",
            value.ty, value.name
        ));
    }

    // -- statements ----------------------------------------------------------

    fn statement(&mut self, statement: &Statement) -> Result<()> {
        match statement {
            // `StorageLive`/`StorageDead` mark the extent drop elaboration ran
            // on. With every local an entry-block `alloca`, LLVM's own
            // `llvm.lifetime` markers would say the same thing — they are not
            // emitted because nothing yet reads them and an inaccurate one is
            // worse than none.
            Statement::StorageLive(_) | Statement::StorageDead(_) | Statement::Nop => Ok(()),
            Statement::SetDropFlag { flag, value } => {
                let address = self.address(&Place::local(*flag))?;
                let flag_value = Val::new("i8", u8::from(*value).to_string());
                self.store(&address, &flag_value, 1);
                Ok(())
            }
            Statement::Init { place, rvalue } => self.write(place, rvalue),
            Statement::Assign { place, rvalue } => {
                // An assignment destroys what was there before the new value
                // lands. For a trivial type there is nothing to destroy and the
                // two nodes are the same machine operation.
                let ty = self.place_type(place)?;
                if self.category(ty)?.needs_drop() {
                    internal_error!(
                        "assigning over a live owning value is not lowered yet \
                         (LLVM-PORT stage 3b)"
                    );
                }
                self.write(place, rvalue)
            }
            Statement::Drop { place, .. } => {
                let ty = self.place_type(place)?;
                if self.category(ty)?.needs_drop() {
                    internal_error!("`Drop` is not lowered yet (LLVM-PORT stage 3b)");
                }
                // A trivial type's destructor is nothing at all.
                Ok(())
            }
        }
    }

    /// Evaluate an rvalue into a place.
    fn write(&mut self, place: &Place, rvalue: &Rvalue) -> Result<()> {
        let ty = self.place_type(place)?;

        if self.is_aggregate(ty)? {
            return self.write_aggregate(place, rvalue, ty);
        }

        let value = self.rvalue(rvalue, ty)?;
        let Some(value) = value else {
            return Ok(());
        };
        let address = self.address(place)?;
        let align = self.layouts.layout(ty)?.align.max(1);
        self.store(&address, &value, align);
        Ok(())
    }

    /// An aggregate destination is filled in place rather than assigned into.
    fn write_aggregate(&mut self, place: &Place, rvalue: &Rvalue, ty: TyId) -> Result<()> {
        let layout = self.layouts.layout(ty)?;
        let (size, align) = (layout.size, layout.align.max(1));

        match rvalue {
            Rvalue::Default => {
                self.intrinsic(
                    "declare void @llvm.memset.p0.i64(ptr writeonly, i8, i64, i1 immarg)",
                );
                let address = self.address(place)?;
                if size > 0 {
                    self.line(format!(
                        "call void @llvm.memset.p0.i64(ptr align {align} {address}, i8 0, i64 {size}, i1 false)"
                    ));
                }
                Ok(())
            }
            Rvalue::Use(operand) => {
                if self.category(ty)?.needs_drop() {
                    internal_error!(
                        "copying an owning aggregate is not lowered yet (LLVM-PORT stage 3b)"
                    );
                }
                let source = match operand {
                    Operand::Copy(from) | Operand::Move(from) | Operand::Borrow(from) => {
                        self.address(from)?
                    }
                    Operand::Const(_) => {
                        internal_error!("an aggregate constant has no lowering")
                    }
                };
                let dest = self.address(place)?;
                self.memcpy(&dest, &source, size, align);
                Ok(())
            }
            Rvalue::Aggregate { fields, .. } => {
                let dest = self.address(place)?;
                let offsets = self.layouts.layout(ty)?.fields.clone();
                for (index, field) in fields.iter().enumerate() {
                    let field_ty = self.operand_type(field)?;
                    let offset = offsets.get(index).copied().unwrap_or(0);
                    let at = self.offset(&dest, offset as i64);
                    if self.is_aggregate(field_ty)? {
                        let source = match field {
                            Operand::Copy(from) | Operand::Move(from) | Operand::Borrow(from) => {
                                self.address(from)?
                            }
                            Operand::Const(_) => {
                                internal_error!("an aggregate constant has no lowering")
                            }
                        };
                        let field_layout = self.layouts.layout(field_ty)?;
                        self.memcpy(&at, &source, field_layout.size, field_layout.align.max(1));
                    } else {
                        let value = self.operand(field)?.ok_or_else(|| {
                            InternalError::new("an aggregate field produced no value")
                        })?;
                        let field_align = self.layouts.layout(field_ty)?.align.max(1);
                        self.store(&at, &value, field_align);
                    }
                }
                Ok(())
            }
            other => internal_error!(
                "{} into an aggregate is not lowered yet (LLVM-PORT stage 3b)",
                rvalue_name(other)
            ),
        }
    }

    // -- rvalues -------------------------------------------------------------

    fn rvalue(&mut self, rvalue: &Rvalue, ty: TyId) -> Result<Option<Val>> {
        Ok(match rvalue {
            Rvalue::Use(operand) => self.operand(operand)?,
            Rvalue::Default => Some(self.zero(ty)?),
            Rvalue::Binary { op, lhs, rhs } => Some(self.binary(*op, lhs, rhs, ty)?),
            Rvalue::Unary { op, operand } => Some(self.unary(*op, operand)?),
            Rvalue::Cast { op, operand, to } => Some(self.cast(*op, operand, *to)?),
            Rvalue::Ref(place) | Rvalue::AddrOf(place) => {
                Some(Val::new("ptr", self.address(place)?))
            }
            Rvalue::SizeOf(of) => {
                let size = self.layouts.layout(*of)?.size;
                Some(Val::new(self.value_type(ty)?, size.to_string()))
            }
            Rvalue::AlignOf(of) => {
                let align = self.layouts.layout(*of)?.align.max(1);
                Some(Val::new(self.value_type(ty)?, align.to_string()))
            }
            other => internal_error!(
                "{} is not lowered yet (LLVM-PORT stage 3b)",
                rvalue_name(other)
            ),
        })
    }

    fn zero(&mut self, ty: TyId) -> Result<Val> {
        let value_ty = self.value_type(ty)?;
        let text = match value_ty.as_str() {
            "float" | "double" => "0.0",
            "ptr" => "null",
            _ => "0",
        };
        Ok(Val::new(value_ty, text))
    }

    fn operand(&mut self, operand: &Operand) -> Result<Option<Val>> {
        match operand {
            // For a trivial type all three read the same machine value; the
            // difference between them is ownership, and a trivial type owns
            // nothing. The owning cases are stage 3b.
            Operand::Copy(place) | Operand::Move(place) | Operand::Borrow(place) => {
                let ty = self.place_type(place)?;
                if matches!(operand, Operand::Copy(_)) && self.category(ty)?.needs_drop() {
                    internal_error!(
                        "copying an owning value is not lowered yet (LLVM-PORT stage 3b)"
                    );
                }
                if self.is_aggregate(ty)? {
                    return Ok(Some(Val::new("ptr", self.address(place)?)));
                }
                Ok(Some(self.load(place, ty)?))
            }
            Operand::Const(constant) => self.constant(constant),
        }
    }

    fn constant(&mut self, constant: &Const) -> Result<Option<Val>> {
        Ok(match constant {
            Const::Unit => None,
            Const::Bool { value, .. } => Some(Val::new("i8", u8::from(*value).to_string())),
            Const::Int { bits, ty } => {
                let value_ty = self.value_type(*ty)?;
                // The frontend has already folded any sign into the bit pattern
                // and range-checked it, so this is a reinterpretation and never
                // a conversion.
                let width = self.layouts.layout(*ty)?.size * 8;
                let text = if self.signed(*ty) {
                    sign_extend(*bits, width).to_string()
                } else {
                    truncate(*bits, width).to_string()
                };
                Some(Val::new(value_ty, text))
            }
            Const::Float { bits, ty } => {
                let value_ty = self.value_type(*ty)?;
                // LLVM takes a float constant as hex bits, which is exact and
                // survives NaN payloads — the reason MIR carries bits at all.
                let text = match self.module.ty(*ty).map(|def| &def.kind) {
                    Some(TyKind::Float(FloatTy::F32)) => {
                        // A `float` constant is written as the *double* it
                        // widens to, which is what LLVM's textual form expects.
                        let single = f32::from_bits(*bits as u32);
                        format!("0x{:016X}", (single as f64).to_bits())
                    }
                    _ => format!("0x{bits:016X}"),
                };
                Some(Val::new(value_ty, text))
            }
            Const::Null(_) => Some(Val::new("ptr", "null")),
            Const::Str { text, .. } => {
                let text = self
                    .module
                    .sym(*text)
                    .ok_or_else(|| InternalError::new("a string literal has no text"))?;
                let symbol = self.literals.symbol(self.globals, text);
                // What the program carries is the address past the header, so a
                // literal and a heap string are indistinguishable downstream.
                let out = self.tmp();
                self.line(format!(
                    "{out} = getelementptr inbounds i8, ptr @{}, i64 {STRING_HEADER_BYTES}",
                    ident(&symbol)
                ));
                Some(Val::new("ptr", out))
            }
            Const::Func { func, .. } => {
                let symbol = self.func_symbol(func)?;
                Some(Val::new("ptr", format!("@{}", ident(&symbol))))
            }
        })
    }

    fn func_symbol(&self, func: &FuncRef) -> Result<String> {
        let name = match func {
            FuncRef::Local(id) => self.symbols.defined.get(id.index()),
            FuncRef::Extern(id) => self.symbols.imported.get(id.index()),
        };
        name.cloned()
            .ok_or_else(|| InternalError::new(format!("{func:?} is not in the module")))
    }

    fn binary(&mut self, op: BinOp, lhs: &Operand, rhs: &Operand, ty: TyId) -> Result<Val> {
        let operand_ty = self.operand_type(lhs)?;
        let left = self
            .operand(lhs)?
            .ok_or_else(|| InternalError::new("a binary operand produced no value"))?;
        let right = self
            .operand(rhs)?
            .ok_or_else(|| InternalError::new("a binary operand produced no value"))?;

        let float = matches!(left.ty.as_str(), "float" | "double");
        let signed = self.signed(operand_ty);

        if let Some(predicate) = comparison(op, float, signed) {
            let bit = self.tmp();
            let kind = if float { "fcmp" } else { "icmp" };
            self.line(format!(
                "{bit} = {kind} {predicate} {} {}, {}",
                left.ty, left.name, right.name
            ));
            // A `bool` is one byte in a register, so the `i1` a comparison
            // yields is widened rather than stored as it is.
            let out = self.tmp();
            self.line(format!("{out} = zext i1 {bit} to i8"));
            return Ok(Val::new("i8", out));
        }

        // No `nsw`/`nuw`. See the module note: the language says arithmetic
        // wraps, and an accidental poison flag is the failure §17 warns about.
        let instruction = match (op, float) {
            (BinOp::Add, false) => "add",
            (BinOp::Add, true) => "fadd",
            (BinOp::Sub, false) => "sub",
            (BinOp::Sub, true) => "fsub",
            (BinOp::Mul, false) => "mul",
            (BinOp::Mul, true) => "fmul",
            (BinOp::Div, true) => "fdiv",
            (BinOp::Div, false) if signed => "sdiv",
            (BinOp::Div, false) => "udiv",
            (BinOp::Rem, true) => {
                internal_error!("`%` on a float reaches the backend; GF0162 should have caught it")
            }
            (BinOp::Rem, false) if signed => "srem",
            (BinOp::Rem, false) => "urem",
            (BinOp::BitAnd, false) => "and",
            (BinOp::BitOr, false) => "or",
            (BinOp::BitXor, false) => "xor",
            (BinOp::Shl, false) => "shl",
            (BinOp::Shr, false) if signed => "ashr",
            (BinOp::Shr, false) => "lshr",
            (op, _) => internal_error!("{op:?} has no lowering for {}", left.ty),
        };

        // The shift count is converted to the value's type rather than promoted
        // to a common type with it (REWRITE-PLAN §7), and LLVM requires both
        // operands of a shift to have the same type outright.
        let right_name = if matches!(op, BinOp::Shl | BinOp::Shr) && right.ty != left.ty {
            self.convert_integer(&right, &left.ty, self.signed(self.operand_type(rhs)?))?
        } else {
            right.name.clone()
        };

        let out = self.tmp();
        self.line(format!(
            "{out} = {instruction} {} {}, {right_name}",
            left.ty, left.name
        ));
        let _ = ty;
        Ok(Val::new(left.ty, out))
    }

    fn convert_integer(&mut self, value: &Val, to: &str, signed: bool) -> Result<String> {
        let from_bits = int_bits(&value.ty)?;
        let to_bits = int_bits(to)?;
        if from_bits == to_bits {
            return Ok(value.name.clone());
        }
        let out = self.tmp();
        let op = if to_bits < from_bits {
            "trunc"
        } else if signed {
            "sext"
        } else {
            "zext"
        };
        self.line(format!("{out} = {op} {} {} to {to}", value.ty, value.name));
        Ok(out)
    }

    fn unary(&mut self, op: UnOp, operand: &Operand) -> Result<Val> {
        let value = self
            .operand(operand)?
            .ok_or_else(|| InternalError::new("a unary operand produced no value"))?;
        let out = self.tmp();
        match op {
            UnOp::Neg if matches!(value.ty.as_str(), "float" | "double") => {
                self.line(format!("{out} = fneg {} {}", value.ty, value.name));
            }
            UnOp::Neg => {
                self.line(format!("{out} = sub {} 0, {}", value.ty, value.name));
            }
            UnOp::BitNot => {
                self.line(format!("{out} = xor {} {}, -1", value.ty, value.name));
            }
            // A `bool` is a byte holding 0 or 1, so complementing the low bit is
            // the whole operation.
            UnOp::Not => {
                self.line(format!("{out} = xor {} {}, 1", value.ty, value.name));
            }
        }
        Ok(Val::new(value.ty, out))
    }

    fn cast(&mut self, op: CastKind, operand: &Operand, to: TyId) -> Result<Val> {
        let from_ty = self.operand_type(operand)?;
        let value = self
            .operand(operand)?
            .ok_or_else(|| InternalError::new("a cast operand produced no value"))?;
        let target_ty = self.value_type(to)?;

        // Opaque pointers make a pointer-to-pointer cast nothing at all.
        if op == CastKind::PtrToPtr {
            return Ok(Val::new(target_ty, value.name));
        }

        let out = self.tmp();
        match op {
            CastKind::IntToInt => {
                let name = self.convert_integer(&value, &target_ty, self.signed(from_ty))?;
                return Ok(Val::new(target_ty, name));
            }
            CastKind::BoolToInt => {
                let name = self.convert_integer(&value, &target_ty, false)?;
                return Ok(Val::new(target_ty, name));
            }
            CastKind::IntToFloat => {
                let op = if self.signed(from_ty) {
                    "sitofp"
                } else {
                    "uitofp"
                };
                self.line(format!(
                    "{out} = {op} {} {} to {target_ty}",
                    value.ty, value.name
                ));
            }
            // Saturating, so an out-of-range float becomes the nearest
            // representable integer rather than poison — which is what a plain
            // `fptosi` would produce, and is the single most dangerous default
            // in this whole translation.
            CastKind::FloatToInt => {
                let signed = self.signed(to);
                let name = if signed { "fptosi" } else { "fptoui" };
                self.intrinsic(&format!(
                    "declare {target_ty} @llvm.{name}.sat.{target_ty}.{}({})",
                    value.ty, value.ty
                ));
                self.line(format!(
                    "{out} = call {target_ty} @llvm.{name}.sat.{target_ty}.{}({} {})",
                    value.ty, value.ty, value.name
                ));
            }
            CastKind::FloatToFloat => {
                let wider = target_ty == "double" && value.ty == "float";
                let op = if wider { "fpext" } else { "fptrunc" };
                if target_ty == value.ty {
                    return Ok(Val::new(target_ty, value.name));
                }
                self.line(format!(
                    "{op_out} = {op} {} {} to {target_ty}",
                    value.ty,
                    value.name,
                    op_out = out
                ));
            }
            CastKind::PtrToInt => {
                self.line(format!(
                    "{out} = ptrtoint ptr {} to {target_ty}",
                    value.name
                ));
            }
            CastKind::IntToPtr => {
                self.line(format!(
                    "{out} = inttoptr {} {} to ptr",
                    value.ty, value.name
                ));
            }
            CastKind::PtrToPtr => unreachable!("handled above"),
        }
        Ok(Val::new(target_ty, out))
    }

    // -- terminators ---------------------------------------------------------

    fn trap(&mut self) {
        self.intrinsic("declare void @llvm.trap()");
        self.line("call void @llvm.trap()");
        self.line("unreachable");
    }

    fn terminator(&mut self, terminator: &Terminator, func: &Function) -> Result<()> {
        match terminator {
            Terminator::Goto(block) => {
                self.line(format!("br label %bb{}", block.0));
                Ok(())
            }
            Terminator::Branch {
                cond,
                then_block,
                else_block,
            } => {
                let value = self
                    .operand(cond)?
                    .ok_or_else(|| InternalError::new("a branch condition produced no value"))?;
                // A `bool` is a byte; LLVM branches on `i1`.
                let bit = self.tmp();
                self.line(format!("{bit} = icmp ne {} {}, 0", value.ty, value.name));
                self.line(format!(
                    "br i1 {bit}, label %bb{}, label %bb{}",
                    then_block.0, else_block.0
                ));
                Ok(())
            }
            Terminator::Switch {
                discr,
                targets,
                default,
            } => {
                let value = self
                    .operand(discr)?
                    .ok_or_else(|| InternalError::new("a switch discriminant produced no value"))?;
                let arms: Vec<String> = targets
                    .iter()
                    .map(|target| {
                        format!("{} {}, label %bb{}", value.ty, target.value, target.block.0)
                    })
                    .collect();
                self.line(format!(
                    "switch {} {}, label %bb{} [ {} ]",
                    value.ty,
                    value.name,
                    default.0,
                    arms.join(" ")
                ));
                Ok(())
            }
            Terminator::Return => self.emit_return(func),
            Terminator::Unreachable => {
                self.trap();
                Ok(())
            }
            Terminator::Resume => {
                internal_error!("unwinding has no lowering until there is a `throw`")
            }
            // The reason is carried so a runtime can one day print something
            // better than "aborted". Cranelift encodes it as a trap code; LLVM
            // has no equivalent, and on x86 both are `ud2` regardless.
            Terminator::Abort(_) => {
                self.trap();
                Ok(())
            }
            Terminator::Call { .. } => self.call(terminator),
        }
    }

    fn emit_return(&mut self, func: &Function) -> Result<()> {
        let ret = self
            .module
            .sig(func.sig)
            .map(|sig| sig.ret)
            .ok_or_else(|| InternalError::new("a function has no signature"))?;

        if let Some(sret) = self.sret.clone() {
            let layout = self.layouts.layout(ret)?;
            let source = self.address(&Place::local(LocalId::RETURN))?;
            self.memcpy(&sret, &source, layout.size, layout.align.max(1));
            self.line("ret void");
            return Ok(());
        }

        match self.layouts.repr(ret)? {
            Repr::Void => self.line("ret void"),
            Repr::Register(_) => {
                let value = self.load(&Place::local(LocalId::RETURN), ret)?;
                self.line(format!("ret {}", value.used()));
            }
            Repr::Aggregate => internal_error!("an aggregate return without a return pointer"),
        }
        Ok(())
    }

    fn call(&mut self, terminator: &Terminator) -> Result<()> {
        let Terminator::Call {
            callee,
            args,
            destination,
            ..
        } = terminator
        else {
            internal_error!("`call` was handed a {terminator:?}");
        };

        let goblin_mir::Callee::Direct(func) = callee else {
            internal_error!(
                "indirect, virtual and interface calls are not lowered yet (LLVM-PORT stage 3b)"
            );
        };
        let symbol = self.func_symbol(func)?;
        let sig_id = match func {
            FuncRef::Local(id) => self.module.funcs.get(id.index()).map(|def| def.sig),
            FuncRef::Extern(id) => self.module.externs.get(id.index()).map(|def| def.sig),
        }
        .ok_or_else(|| InternalError::new("a callee has no signature"))?;
        let signature = self
            .module
            .sig(sig_id)
            .cloned()
            .ok_or_else(|| InternalError::new(format!("signature {} is missing", sig_id.0)))?;

        let rendered = sig::render(self.types, self.layouts, &signature, self.conv)?;

        if signature.abi == Abi::C {
            let shape = abi::classify(self.layouts, &signature, self.conv)?;
            if shape
                .params
                .iter()
                .any(|slot| !matches!(slot, Slot::Plain { .. } | Slot::None))
                || matches!(shape.returns, Slot::Registers { .. } | Slot::Sret { .. })
            {
                internal_error!(
                    "a C call passing an aggregate is not lowered yet (LLVM-PORT stage 3b)"
                );
            }
        }

        // An aggregate result is constructed into the caller's storage, which
        // is the same mechanism as the C ABI's hidden return pointer because it
        // must be one mechanism and not two (REWRITE-PLAN §4.5).
        let mut arguments: Vec<String> = Vec::with_capacity(args.len() + 1);
        let mut result_place = None;
        if rendered.sret {
            let Some(dest) = destination else {
                internal_error!("a call returning an aggregate has nowhere to put it");
            };
            let address = self.address(&dest.place)?;
            arguments.push(format!("ptr {address}"));
            result_place = Some(dest.place.clone());
        }

        for argument in args {
            let value = self
                .operand(argument)?
                .ok_or_else(|| InternalError::new("a call argument produced no value"))?;
            arguments.push(value.used());
        }

        let returns = rendered.returns.clone();
        if returns == "void" {
            self.line(format!(
                "call void @{}({})",
                ident(&symbol),
                arguments.join(", ")
            ));
        } else {
            let out = self.tmp();
            self.line(format!(
                "{out} = call {returns} @{}({})",
                ident(&symbol),
                arguments.join(", ")
            ));
            if let Some(dest) = destination
                && result_place.is_none()
            {
                let ty = self.place_type(&dest.place)?;
                let align = self.layouts.layout(ty)?.align.max(1);
                let address = self.address(&dest.place)?;
                self.store(&address, &Val::new(returns, out), align);
            }
        }

        match destination {
            Some(dest) => self.line(format!("br label %bb{}", dest.target.0)),
            // A call that cannot return.
            None => {
                self.line("unreachable");
            }
        }
        Ok(())
    }
}

/// The comparison predicate for an operator, or `None` when it is arithmetic.
///
/// Float comparisons are **ordered**: `NaN` compares false against everything,
/// including itself, which is IEEE-754's rule and what every other language
/// with a `NaN` does.
fn comparison(op: BinOp, float: bool, signed: bool) -> Option<&'static str> {
    Some(match (op, float) {
        (BinOp::Eq, false) => "eq",
        (BinOp::Ne, false) => "ne",
        (BinOp::Lt, false) if signed => "slt",
        (BinOp::Lt, false) => "ult",
        (BinOp::Le, false) if signed => "sle",
        (BinOp::Le, false) => "ule",
        (BinOp::Gt, false) if signed => "sgt",
        (BinOp::Gt, false) => "ugt",
        (BinOp::Ge, false) if signed => "sge",
        (BinOp::Ge, false) => "uge",
        (BinOp::Eq, true) => "oeq",
        (BinOp::Ne, true) => "une",
        (BinOp::Lt, true) => "olt",
        (BinOp::Le, true) => "ole",
        (BinOp::Gt, true) => "ogt",
        (BinOp::Ge, true) => "oge",
        _ => return None,
    })
}

fn int_bits(ty: &str) -> Result<u32> {
    match ty {
        "i8" => Ok(8),
        "i16" => Ok(16),
        "i32" => Ok(32),
        "i64" => Ok(64),
        other => Err(InternalError::new(format!("`{other}` is not an integer"))),
    }
}

/// A bit pattern as LLVM wants it written: signed types get the negative form.
fn sign_extend(bits: u64, width: u32) -> i64 {
    if width >= 64 {
        return bits as i64;
    }
    let shift = 64 - width;
    ((bits << shift) as i64) >> shift
}

fn truncate(bits: u64, width: u32) -> u64 {
    if width >= 64 {
        return bits;
    }
    bits & ((1u64 << width) - 1)
}

fn rvalue_name(rvalue: &Rvalue) -> &'static str {
    match rvalue {
        Rvalue::Use(_) => "`use`",
        Rvalue::Default => "`default`",
        Rvalue::Binary { .. } => "a binary operation",
        Rvalue::Unary { .. } => "a unary operation",
        Rvalue::Cast { .. } => "a cast",
        Rvalue::Ref(_) => "`&`",
        Rvalue::AddrOf(_) => "`addrOf`",
        Rvalue::Aggregate { .. } => "an aggregate literal",
        Rvalue::Len(_) => "`length`",
        Rvalue::MakeInterface { .. } => "an interface conversion",
        Rvalue::TryInterface { .. } => "`tryCast` to an interface",
        Rvalue::TryClass { .. } => "`tryCast` to a class",
        Rvalue::InterfaceIsNull(_) => "an interface null check",
        Rvalue::ArrayPushSlot(_) => "`push`",
        Rvalue::SizeOf(_) => "`sizeOf`",
        Rvalue::AlignOf(_) => "`alignOf`",
    }
}
