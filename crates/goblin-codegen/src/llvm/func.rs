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
    Abi, BinOp, BlockId, BlockKind, Callee, CastKind, Category, ClassId, Const, FloatTy, FuncId,
    FuncRef, Function, InterfaceId, LocalId, Module, Operand, Place, Projection, Rvalue, Statement,
    Terminator, TyId, TyKind, UnOp, UnwindAction,
};

use crate::abi::{self, Conv, Shape, Slot};
use crate::error::{InternalError, Result};
use crate::internal_error;
use crate::layout::{Layouts, Repr, TargetInfo};
use crate::llvm::data::Globals;
use crate::llvm::debug::{self, Subprogram};
use crate::llvm::sig;
use crate::llvm::ty::{Types, ident, scalar};
use crate::llvm::vtable::ClassSymbols;
use crate::llvm::{Literals, Symbols};
use crate::runtime::{RuntimeFn, STRING_HEADER_BYTES};

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
    /// The descriptor, vtable and itab symbols of every class, by `ClassId`.
    classes: &'a [ClassSymbols],
    /// Intrinsic and runtime declarations discovered while emitting.
    intrinsics: &'a mut BTreeSet<String>,
    conv: Conv,
    target: TargetInfo,
    out: String,
    next: u32,
    /// Labels for the blocks this emitter introduces — loops inside a copy or a
    /// destroy — kept apart from `bb{n}`, which belongs to the MIR.
    next_label: u32,
    /// Scratch slots discovered mid-body, hoisted into the entry block.
    entry_allocas: Vec<String>,
    /// This function's debug scope, when debug info was asked for.
    subprogram: Option<Subprogram>,
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
        classes: &'a [ClassSymbols],
        intrinsics: &'a mut BTreeSet<String>,
        conv: Conv,
        subprogram: Option<Subprogram>,
    ) -> Emitter<'a, 'm> {
        let target = layouts.target();
        Emitter {
            module,
            layouts,
            types,
            globals,
            literals,
            symbols,
            classes,
            intrinsics,
            conv,
            target,
            out: String::new(),
            next: 0,
            next_label: 0,
            entry_allocas: Vec::new(),
            subprogram,
            locals: Vec::new(),
            local_types: Vec::new(),
            sret: None,
        }
    }

    // -- runtime and control-flow helpers ------------------------------------

    /// A scratch slot, allocated in the entry block however deep the use is.
    ///
    /// **Never `alloca` where the value is used.** An `alloca` inside a loop is
    /// a fresh allocation every iteration, so the stack grows without bound —
    /// and `mem2reg` will not promote one either, which is the whole reason
    /// every local is an entry-block slot in the first place. One slot per
    /// *site* is correct because nothing here outlives the statement that
    /// wanted it.
    fn scratch_slot(&mut self, size: u32, align: u32) -> String {
        self.next += 1;
        let name = format!("%s{}", self.next);
        self.entry_allocas.push(format!(
            "{name} = alloca [{} x i8], align {}",
            size.max(1),
            align.max(1)
        ));
        name
    }

    /// A label for a block this emitter introduces, kept apart from `bb{n}`.
    fn new_label(&mut self) -> String {
        self.next_label += 1;
        format!("l{}", self.next_label)
    }

    fn goto(&mut self, label: &str) {
        self.line(format!("br label %{label}"));
    }

    fn begin(&mut self, label: &str) {
        self.out.push_str(&format!("{label}:\n"));
    }

    /// A pointer-width integer: `usize` and `isize`, and every length and
    /// stride the runtime counts in.
    fn usize_ty(&self) -> &'static str {
        match self.target.pointer_bytes {
            4 => "i32",
            _ => "i64",
        }
    }

    /// Call a runtime function, declaring it on first use.
    ///
    /// Every operation an owning type needs is a call across the same
    /// `extern "C"` boundary user code crosses — there is no privileged
    /// channel, so a bug in `gf_string_clone` looks like a bug in any other C
    /// function and can be found the same way.
    fn runtime(&mut self, which: RuntimeFn, args: &[Val]) -> Result<Option<Val>> {
        let (params, returns) = self.runtime_signature(which);
        let symbol = which.symbol();
        // Only if the module has not already named it. The runtime's entry
        // points are ordinary `extern "C"` functions with no privileged
        // channel, so a program is free to import one itself — `cstringFree`
        // is `gf_string_free` — and LLVM rejects a symbol declared twice.
        let already = self.symbols.imported.iter().any(|name| name == symbol)
            || self.symbols.defined.iter().any(|name| name == symbol);
        if !already {
            self.intrinsic(&format!(
                "declare {returns} @{symbol}({})",
                params.join(", ")
            ));
        }

        let arguments: Vec<String> = args.iter().map(Val::used).collect();
        if returns == "void" {
            self.line(format!("call void @{symbol}({})", arguments.join(", ")));
            return Ok(None);
        }
        let out = self.tmp();
        self.line(format!(
            "{out} = call {returns} @{symbol}({})",
            arguments.join(", ")
        ));
        Ok(Some(Val::new(returns, out)))
    }

    /// Parameter and return types, in LLVM terms.
    ///
    /// Deliberately written out rather than mapped from `runtime.rs`'s
    /// Cranelift table: there, a length and an address are both `pointer`,
    /// because Cranelift has no pointer type. Here they are `i64` and `ptr`,
    /// and collapsing them would put an `inttoptr` on every length.
    fn runtime_signature(&self, which: RuntimeFn) -> (Vec<String>, String) {
        let usize_ty = self.usize_ty().to_owned();
        let p = || "ptr".to_owned();
        let (params, returns): (Vec<String>, String) = match which {
            RuntimeFn::StringClone => (vec![p()], p()),
            RuntimeFn::StringFree => (vec![p()], "void".into()),
            RuntimeFn::StringLen | RuntimeFn::CStrLen => (vec![p()], usize_ty.clone()),
            RuntimeFn::StringConcat => (vec![p(), p()], p()),
            RuntimeFn::StringEq => (vec![p(), p()], "i8".into()),
            RuntimeFn::StringFromI64 | RuntimeFn::StringFromU64 => (vec!["i64".into()], p()),
            RuntimeFn::StringFromF64 => (vec!["double".into()], p()),
            RuntimeFn::StringFromBool => (vec!["i8".into()], p()),
            RuntimeFn::Print | RuntimeFn::EPrint => (vec![p()], "void".into()),
            // The key is always 64 bits, so a 32-bit target agrees with the
            // runtime about an interface name's hash rather than truncating it.
            RuntimeFn::FindItab => (vec![p(), "i64".into()], p()),
            RuntimeFn::IsA => (vec![p(), p()], "i8".into()),
            // Lengths, strides and alignments are 64 bits on every target.
            RuntimeFn::ArrayNew => (vec!["i64".into(); 3], p()),
            RuntimeFn::ArrayEmpty => (Vec::new(), p()),
            RuntimeFn::ArrayLen => (vec![p()], usize_ty.clone()),
            RuntimeFn::ArrayPushSlot => (vec![p(), "i64".into(), "i64".into()], p()),
            RuntimeFn::ArrayPop | RuntimeFn::ArrayFree => (vec![p()], "void".into()),
        };
        (params, returns)
    }

    fn int(&self, ty: &str, value: impl std::fmt::Display) -> Val {
        Val::new(ty, value.to_string())
    }

    /// The value an object of `class` carries at offset 0.
    ///
    /// Biased past the descriptor word, so a virtual call indexes from it with
    /// no adjustment — see the module docs on `crate::vtable`.
    fn vtable_pointer(&mut self, class: ClassId) -> Result<Val> {
        let symbols = self
            .classes
            .get(class.index())
            .ok_or_else(|| InternalError::new(format!("class {} has no vtable", class.0)))?;
        let out = self.tmp();
        self.line(format!(
            "{out} = getelementptr inbounds i8, ptr @{}, i64 {}",
            ident(&symbols.vtable),
            crate::llvm::vtable::vtable_bias(self.target)
        ));
        Ok(Val::new("ptr", out))
    }

    // -- emission primitives -------------------------------------------------

    fn tmp(&mut self) -> String {
        self.next += 1;
        format!("%v{}", self.next)
    }

    /// One instruction, carrying this function's debug location.
    ///
    /// Every instruction, not only the calls. LLVM's verifier requires a `!dbg`
    /// on an inlinable call site inside a function that has debug info, and
    /// "which calls will the inliner touch" is not a question worth answering
    /// per site — attaching it everywhere is uniform and costs one metadata
    /// reference per line.
    fn line(&mut self, text: impl AsRef<str>) {
        self.out.push_str("  ");
        self.out.push_str(text.as_ref());
        self.out.push_str(&debug::attach(
            self.subprogram.map(|program| program.location),
        ));
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

        // The scratch slots the body asked for are spliced into the entry
        // block, which is the only place an `alloca` may live.
        let mut body = String::from("entry:\n");
        for slot in &self.entry_allocas {
            body.push_str("  ");
            body.push_str(slot);
            body.push('\n');
        }
        body.push_str(self.out.strip_prefix("entry:\n").unwrap_or(&self.out));

        Ok(format!(
            "define {linkage}{} @{}({}){} {{\n{body}}}\n",
            rendered.returns,
            ident(symbol),
            params.join(", "),
            debug::on_define(self.subprogram),
        ))
    }

    /// The parameter list, with a name bound to each incoming value.
    fn bind_header(&mut self, _func: &Function, rendered: &sig::Rendered) -> Result<Vec<String>> {
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

            // An aggregate parameter usually arrives as the address of the
            // caller's copy, so the local *is* that address rather than storage
            // of its own — copying it into a fresh slot would be a second copy
            // of an argument already copied once.
            //
            // Not always, though. At the C boundary a small struct arrives
            // **packed into registers**, and then there is no caller copy to
            // point at: the callee has to reassemble it into storage of its
            // own. Handing that case an `Indirect` gives the parameter binding
            // a pointer that was never set, which is an access violation at the
            // first call — and one that only shows up when C calls *into*
            // Goblin, because the caller's half is a different function.
            let by_address = if internal {
                true
            } else {
                let shape = abi::classify(self.layouts, signature, self.conv)?;
                !matches!(
                    shape.params.get(index.wrapping_sub(1)),
                    Some(Slot::Registers { .. })
                )
            };
            if by_address && matches!(repr, Repr::Aggregate) && (1..=param_count).contains(&index) {
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

        let signature =
            self.module.sig(func.sig).cloned().ok_or_else(|| {
                InternalError::new(format!("signature {} is missing", func.sig.0))
            })?;
        let shape = if signature.abi == Abi::C {
            Some(abi::classify(self.layouts, &signature, self.conv)?)
        } else {
            None
        };

        for index in 0..signature.params.len() {
            let local = LocalId::param(index as u32);

            // A struct packed into registers has no caller copy to point at, so
            // the callee puts the pieces back together into storage of its own.
            if let Some(Slot::Registers {
                carriers,
                size,
                align,
            }) = shape.as_ref().and_then(|shape| shape.params.get(index))
            {
                let values: Vec<Val> = carriers
                    .iter()
                    .map(|carrier| {
                        let value = Val::new(scalar(*carrier), format!("%arg{next}"));
                        next += 1;
                        value
                    })
                    .collect();
                let Local::Slot { ptr, .. } = self.local(local)?.clone() else {
                    internal_error!("_{} holds a struct but has no storage", local.0);
                };
                let (size, align) = (*size, *align);
                self.scatter_values(&ptr, &values, size, align)?;
                continue;
            }

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

    /// Write carrier registers into a struct's storage, through a padded slot.
    ///
    /// The mirror of [`Emitter::gather_carriers`], and padded for the same
    /// reason: a carrier is eight bytes wide even when the tail of the struct
    /// is not, so storing it directly would write past the end.
    fn scatter_values(&mut self, dest: &str, values: &[Val], size: u32, align: u32) -> Result<()> {
        let padded = ((values.len() as u32) * 8).max(8);
        let scratch = self.scratch_slot(padded, 8);
        for (index, value) in values.iter().enumerate() {
            let at = self.offset(&scratch, (index as i64) * 8);
            self.line(format!(
                "store {} {}, ptr {at}, align 8",
                value.ty, value.name
            ));
        }
        self.memcpy(dest, &scratch, size, align.max(1));
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
            // Indexing a pointer is pointer arithmetic, and it does not go
            // through a `Deref` first: `p[0]` and `*p` are the same address,
            // reached by two different projections.
            (
                Projection::Index(_) | Projection::ConstIndex(_),
                TyKind::Array(element)
                | TyKind::FixedArray { element, .. }
                | TyKind::Pointer(element)
                | TyKind::Reference(element),
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
            // The handle points at the first element, with the length behind
            // it — the same arrangement a `string` has, so one load reaches the
            // buffer and nothing has to know which it got. A `Pointer<T>` is
            // loaded for the same reason: the local holds the address, not the
            // elements.
            Some(TyKind::Array(_) | TyKind::Pointer(_) | TyKind::Reference(_)) => {
                let out = self.tmp();
                self.line(format!(
                    "{out} = load ptr, ptr {address}, align {}",
                    self.pointer_bytes()
                ));
                Ok(out)
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

    // -- copy and destroy ----------------------------------------------------

    /// The copy operation for a value of `ty`.
    ///
    /// REWRITE-PLAN §4.3's `copy`. A trivial type is its bits; a `string` is
    /// cloned; a `T[]` is deep-copied. An aggregate hands back its address and
    /// lets [`Emitter::copy_aggregate`] do the field-wise work, because a
    /// `memcpy` there would shallow-copy every owning field and double free
    /// every one of them.
    fn copy_of(&mut self, ty: TyId, value: Val) -> Result<Val> {
        if !self.category(ty)?.needs_drop() {
            return Ok(value);
        }
        let kind = self
            .module
            .ty(ty)
            .map(|def| def.kind.clone())
            .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))?;
        match kind {
            TyKind::Str => self
                .runtime(RuntimeFn::StringClone, &[value])?
                .ok_or_else(|| InternalError::new("`gf_string_clone` returned nothing")),
            TyKind::Array(_) => self.clone_array(ty, value),
            TyKind::FixedArray { .. } | TyKind::Struct(_) | TyKind::Class(_) => Ok(value),
            _ => internal_error!("no copy operation for this type yet"),
        }
    }

    /// Copy an aggregate field by field, applying each field's own operation.
    ///
    /// REWRITE-PLAN §10: `memcpy` is the right copy for a struct of `i32` and a
    /// double free for one holding a `string`. The operation comes from the
    /// field's type, and there is no default.
    fn copy_aggregate(&mut self, dest: &str, source: &str, ty: TyId) -> Result<()> {
        let layout = self.layouts.layout(ty)?;
        if !self.category(ty)?.needs_drop() {
            // Nothing inside owns anything, so the bytes are the whole value —
            // padding included, which is what keeps it identical to what a C
            // compiler produces for the same declaration.
            self.memcpy(dest, source, layout.size, layout.align.max(1));
            return Ok(());
        }

        let kind = self
            .module
            .ty(ty)
            .map(|def| def.kind.clone())
            .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))?;

        if let TyKind::FixedArray { element, length } = kind {
            let stride = self.layouts.layout(element)?.stride();
            for index in 0..length {
                let at = stride * (index as u32);
                let into = self.offset(dest, at as i64);
                let from = self.offset(source, at as i64);
                self.copy_element(&into, &from, element)?;
            }
            return Ok(());
        }

        let fields = match kind {
            TyKind::Struct(id) => self
                .module
                .strukt(id)
                .map(|def| def.fields.iter().map(|field| field.ty).collect::<Vec<_>>())
                .ok_or_else(|| InternalError::new(format!("struct {} is missing", id.0)))?,
            // **Copying a class slices** (REWRITE-PLAN §4.1, §4.7). The
            // destination takes the *static* type's vtable and the *static*
            // type's fields, so assigning a `Derived` to a `Base` keeps a
            // `Base`. Writing the vtable pointer here rather than letting a
            // byte copy carry offset 0 across is the whole of that rule.
            TyKind::Class(id) => {
                let vtable = self.vtable_pointer(id)?;
                self.store(dest, &vtable, self.pointer_bytes());
                self.class_field_types(id)?
            }
            _ => internal_error!("an owning aggregate that is neither a struct nor an array"),
        };

        for (index, field_ty) in fields.iter().enumerate() {
            let at = *layout.fields.get(index).ok_or_else(|| {
                InternalError::new(format!("the aggregate being copied has no field {index}"))
            })?;
            let into = self.offset(dest, at as i64);
            let from = self.offset(source, at as i64);
            self.copy_element(&into, &from, *field_ty)?;
        }
        Ok(())
    }

    /// One field or element: recurse for an aggregate, copy the value otherwise.
    fn copy_element(&mut self, dest: &str, source: &str, ty: TyId) -> Result<()> {
        if self.is_aggregate(ty)? {
            return self.copy_aggregate(dest, source, ty);
        }
        let value_ty = self.value_type(ty)?;
        let align = self.layouts.layout(ty)?.align.max(1);
        let out = self.tmp();
        self.line(format!(
            "{out} = load {value_ty}, ptr {source}, align {align}"
        ));
        let copied = self.copy_of(ty, Val::new(value_ty, out))?;
        self.store(dest, &copied, align);
        Ok(())
    }

    fn class_field_types(&self, id: ClassId) -> Result<Vec<TyId>> {
        self.module
            .class(id)
            .map(|def| def.fields.iter().map(|field| field.ty).collect())
            .ok_or_else(|| InternalError::new(format!("class {} is missing", id.0)))
    }

    /// Destroy the value at an address.
    fn destroy_at(&mut self, ty: TyId, address: &str) -> Result<()> {
        if !self.category(ty)?.needs_drop() {
            return Ok(());
        }
        if self.is_aggregate(ty)? {
            return self.destroy_aggregate(ty, address);
        }
        let value_ty = self.value_type(ty)?;
        let align = self.layouts.layout(ty)?.align.max(1);
        let out = self.tmp();
        self.line(format!(
            "{out} = load {value_ty}, ptr {address}, align {align}"
        ));
        self.destroy(ty, Val::new(value_ty, out))
    }

    /// Destroy a value held in a register — a `string` or a `T[]` handle.
    fn destroy(&mut self, ty: TyId, value: Val) -> Result<()> {
        let kind = self
            .module
            .ty(ty)
            .map(|def| def.kind.clone())
            .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))?;
        match kind {
            TyKind::Str => {
                self.runtime(RuntimeFn::StringFree, &[value])?;
                Ok(())
            }
            // Every element, then the buffer. Unlike a `FixedArray` the array's
            // storage *is* its own to reclaim: it came from the allocator.
            TyKind::Array(_) => self.destroy_array(ty, value),
            _ => internal_error!("no destroy operation for this type yet"),
        }
    }

    fn destroy_aggregate(&mut self, ty: TyId, address: &str) -> Result<()> {
        let layout = self.layouts.layout(ty)?;
        let kind = self
            .module
            .ty(ty)
            .map(|def| def.kind.clone())
            .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))?;

        match kind {
            // Every element, in reverse. The array's own storage is its
            // parent's to reclaim; an inline value is never handed back to the
            // allocator on its own (REWRITE-PLAN §4.2).
            TyKind::FixedArray { element, length } => {
                let stride = self.layouts.layout(element)?.stride();
                for index in (0..length).rev() {
                    let at = self.offset(address, (stride * (index as u32)) as i64);
                    self.destroy_at(element, &at)?;
                }
                Ok(())
            }
            TyKind::Struct(id) => {
                let fields = self
                    .module
                    .strukt(id)
                    .map(|def| def.fields.iter().map(|field| field.ty).collect::<Vec<_>>())
                    .ok_or_else(|| InternalError::new(format!("struct {} is missing", id.0)))?;
                // Reverse declaration order, because destruction is
                // construction backwards.
                for (index, field_ty) in fields.iter().enumerate().rev() {
                    if !self.category(*field_ty)?.needs_drop() {
                        continue;
                    }
                    let at = *layout.fields.get(index).ok_or_else(|| {
                        InternalError::new(format!("struct {} has no field {index}", id.0))
                    })?;
                    let field = self.offset(address, at as i64);
                    self.destroy_at(*field_ty, &field)?;
                }
                Ok(())
            }
            // A **direct** call to this class's own destructor, not a virtual
            // one — and that is not an optimisation, it is the only correct
            // choice. The address is storage laid out for exactly this class,
            // so its dynamic type *is* its static type: anything else put there
            // would have been sliced on the way in (REWRITE-PLAN §4.2).
            TyKind::Class(id) => {
                let destructor = self
                    .module
                    .class(id)
                    .and_then(|def| def.vtable.first().copied())
                    .ok_or_else(|| {
                        InternalError::new(format!(
                            "class {} has no destructor in vtable slot 0",
                            id.0
                        ))
                    })?;
                self.call_local(destructor, &[Val::new("ptr", address)])?;
                Ok(())
            }
            _ => internal_error!("no destroy operation for this aggregate yet"),
        }
    }

    fn call_local(&mut self, func: FuncId, args: &[Val]) -> Result<Option<Val>> {
        let symbol = self
            .symbols
            .defined
            .get(func.index())
            .cloned()
            .ok_or_else(|| InternalError::new(format!("function {} is missing", func.0)))?;
        let signature = self
            .module
            .funcs
            .get(func.index())
            .map(|def| def.sig)
            .and_then(|sig| self.module.sig(sig).cloned())
            .ok_or_else(|| InternalError::new("a callee has no signature"))?;
        let rendered = sig::render(self.types, self.layouts, &signature, self.conv)?;
        let arguments: Vec<String> = args.iter().map(Val::used).collect();
        if rendered.returns == "void" {
            self.line(format!(
                "call void @{}({})",
                ident(&symbol),
                arguments.join(", ")
            ));
            return Ok(None);
        }
        let out = self.tmp();
        self.line(format!(
            "{out} = call {} @{}({})",
            rendered.returns,
            ident(&symbol),
            arguments.join(", ")
        ));
        Ok(Some(Val::new(rendered.returns_type, out)))
    }

    // -- arrays --------------------------------------------------------------

    fn element_of(&self, ty: TyId) -> Result<TyId> {
        match self.module.ty(ty).map(|def| &def.kind) {
            Some(TyKind::Array(element)) => Ok(*element),
            _ => Err(InternalError::new(
                "an array operation on something that is not an array",
            )),
        }
    }

    /// `gf_array_len`, widened to the 64 bits the runtime's counts use.
    fn array_len(&mut self, handle: &Val) -> Result<Val> {
        self.runtime(RuntimeFn::ArrayLen, std::slice::from_ref(handle))?
            .ok_or_else(|| InternalError::new("`gf_array_len` returned nothing"))
    }

    /// The copy operation for `T[]`: a fresh buffer, then every element copied
    /// with *its* copy operation.
    ///
    /// Value semantics, as `std::vector`'s copy constructor has. A byte copy
    /// would be right for `i32[]` and a double free for `string[]`, so the fast
    /// path is taken from the element's category and never from how the array
    /// was built.
    fn clone_array(&mut self, ty: TyId, handle: Val) -> Result<Val> {
        let element = self.element_of(ty)?;
        let layout = self.layouts.layout(element)?;
        let (stride, align) = (layout.stride(), layout.align.max(1));

        let len = self.array_len(&handle)?;
        let len64 = self.widen_to_i64(&len)?;
        let fresh = self
            .runtime(
                RuntimeFn::ArrayNew,
                &[
                    Val::new("i64", len64.clone()),
                    self.int("i64", stride),
                    self.int("i64", align),
                ],
            )?
            .ok_or_else(|| InternalError::new("`gf_array_new` returned nothing"))?;

        if !self.category(element)?.needs_drop() {
            let bytes = self.tmp();
            self.line(format!("{bytes} = mul i64 {len64}, {stride}"));
            self.intrinsic(
                "declare void @llvm.memcpy.p0.p0.i64(ptr noalias writeonly, ptr noalias readonly, i64, i1 immarg)",
            );
            self.line(format!(
                "call void @llvm.memcpy.p0.p0.i64(ptr align {align} {}, ptr align {align} {}, i64 {bytes}, i1 false)",
                fresh.name, handle.name
            ));
            return Ok(fresh);
        }

        // Counting up, so elements are constructed in order.
        let counter = self.scratch_slot(8, 8);
        self.line(format!("store i64 0, ptr {counter}, align 8"));
        let (header, body, exit) = (self.new_label(), self.new_label(), self.new_label());
        self.goto(&header);

        self.begin(&header);
        let i = self.tmp();
        self.line(format!("{i} = load i64, ptr {counter}, align 8"));
        let more = self.tmp();
        self.line(format!("{more} = icmp ult i64 {i}, {len64}"));
        self.line(format!("br i1 {more}, label %{body}, label %{exit}"));

        self.begin(&body);
        let i = self.tmp();
        self.line(format!("{i} = load i64, ptr {counter}, align 8"));
        let byte_offset = self.tmp();
        self.line(format!("{byte_offset} = mul i64 {i}, {stride}"));
        let into = self.tmp();
        self.line(format!(
            "{into} = getelementptr inbounds i8, ptr {}, i64 {byte_offset}",
            fresh.name
        ));
        let from = self.tmp();
        self.line(format!(
            "{from} = getelementptr inbounds i8, ptr {}, i64 {byte_offset}",
            handle.name
        ));
        self.copy_element(&into, &from, element)?;
        let next = self.tmp();
        self.line(format!("{next} = add i64 {i}, 1"));
        self.line(format!("store i64 {next}, ptr {counter}, align 8"));
        self.goto(&header);

        self.begin(&exit);
        Ok(fresh)
    }

    fn destroy_array(&mut self, ty: TyId, handle: Val) -> Result<()> {
        let element = self.element_of(ty)?;
        if self.category(element)?.needs_drop() {
            let stride = self.layouts.layout(element)?.stride();
            let len = self.array_len(&handle)?;
            let len64 = self.widen_to_i64(&len)?;

            let counter = self.scratch_slot(8, 8);
            self.line(format!("store i64 {len64}, ptr {counter}, align 8"));
            let (header, body, exit) = (self.new_label(), self.new_label(), self.new_label());
            self.goto(&header);

            self.begin(&header);
            let i = self.tmp();
            self.line(format!("{i} = load i64, ptr {counter}, align 8"));
            let more = self.tmp();
            self.line(format!("{more} = icmp ugt i64 {i}, 0"));
            self.line(format!("br i1 {more}, label %{body}, label %{exit}"));

            // Counting down, so the index is decremented *before* it is used
            // and the last element is the first destroyed.
            self.begin(&body);
            let i = self.tmp();
            self.line(format!("{i} = load i64, ptr {counter}, align 8"));
            let at = self.tmp();
            self.line(format!("{at} = sub i64 {i}, 1"));
            self.line(format!("store i64 {at}, ptr {counter}, align 8"));
            let byte_offset = self.tmp();
            self.line(format!("{byte_offset} = mul i64 {at}, {stride}"));
            let slot = self.tmp();
            self.line(format!(
                "{slot} = getelementptr inbounds i8, ptr {}, i64 {byte_offset}",
                handle.name
            ));
            self.destroy_at(element, &slot)?;
            self.goto(&header);

            self.begin(&exit);
        }
        self.runtime(RuntimeFn::ArrayFree, &[handle])?;
        Ok(())
    }

    /// `[a, b, c]` — a buffer of exactly the right size, then the elements.
    fn build_array(&mut self, ty: TyId, elements: &[Operand]) -> Result<Val> {
        let element = self.element_of(ty)?;
        let layout = self.layouts.layout(element)?;
        let (stride, align) = (layout.stride(), layout.align.max(1));

        if elements.is_empty() {
            // The shared static empty array. No allocation, so an empty literal
            // does not cost a trip to the allocator.
            return self
                .runtime(RuntimeFn::ArrayEmpty, &[])?
                .ok_or_else(|| InternalError::new("`gf_array_empty` returned nothing"));
        }

        let buffer = self
            .runtime(
                RuntimeFn::ArrayNew,
                &[
                    self.int("i64", elements.len()),
                    self.int("i64", stride),
                    self.int("i64", align),
                ],
            )?
            .ok_or_else(|| InternalError::new("`gf_array_new` returned nothing"))?;

        for (index, operand) in elements.iter().enumerate() {
            let at = self.offset(&buffer.name, (stride as i64) * (index as i64));
            self.write_operand_to(&at, operand, element)?;
        }
        Ok(buffer)
    }

    fn widen_to_i64(&mut self, value: &Val) -> Result<String> {
        if value.ty == "i64" {
            return Ok(value.name.clone());
        }
        let out = self.tmp();
        self.line(format!("{out} = zext {} {} to i64", value.ty, value.name));
        Ok(out)
    }

    /// Construct an operand's value into storage that holds nothing yet.
    fn write_operand_to(&mut self, dest: &str, operand: &Operand, ty: TyId) -> Result<()> {
        if self.is_aggregate(ty)? {
            let source = match operand {
                Operand::Copy(from) => {
                    let address = self.address(from)?;
                    return self.copy_aggregate(dest, &address, ty);
                }
                Operand::Move(from) | Operand::Borrow(from) => self.address(from)?,
                Operand::Const(_) => internal_error!("an aggregate constant has no lowering"),
            };
            let layout = self.layouts.layout(ty)?;
            self.memcpy(dest, &source, layout.size, layout.align.max(1));
            return Ok(());
        }
        let value = self
            .operand(operand)?
            .ok_or_else(|| InternalError::new("an element produced no value"))?;
        let align = self.layouts.layout(ty)?.align.max(1);
        self.store(dest, &value, align);
        Ok(())
    }

    // -- interfaces ----------------------------------------------------------

    /// Build a `Reference<I>` in place: the itab, then the object's address.
    ///
    /// Two stores and no lookup. The class is the *static* type of the source,
    /// so converting a `Base` yields a `Base`'s itab even when the object is
    /// really a `Derived` — and dispatch still reaches the derived override,
    /// because the itab holds `Base`'s final overriders.
    fn make_interface(
        &mut self,
        dest: &str,
        interface: InterfaceId,
        class: ClassId,
        source: &Place,
    ) -> Result<()> {
        let symbols = self
            .classes
            .get(class.index())
            .ok_or_else(|| InternalError::new(format!("class {} has no static data", class.0)))?;
        let itab = symbols.itabs.get(&interface.0).cloned().ok_or_else(|| {
            InternalError::new(format!(
                "class {} has no itab for interface {} — the frontend records every \
                 conversion it lowers, so reaching here means one was not recorded",
                class.0, interface.0
            ))
        })?;

        let biased = self.tmp();
        self.line(format!(
            "{biased} = getelementptr inbounds i8, ptr @{}, i64 {}",
            ident(&itab),
            crate::llvm::vtable::vtable_bias(self.target)
        ));
        let object = self.address(source)?;
        self.store(dest, &Val::new("ptr", biased), self.pointer_bytes());
        let second = self.offset(dest, self.pointer_bytes() as i64);
        self.store(&second, &Val::new("ptr", object), self.pointer_bytes());
        Ok(())
    }

    /// `tryCast<I>(place)`: the same pair, resolved at run time.
    ///
    /// The object's vtable pointer leads to its **dynamic** type descriptor —
    /// the whole point, since the static type is what failed to answer — and
    /// the runtime searches that descriptor's itab table. The object address is
    /// stored either way; null-ness lives in the itab word alone, which is what
    /// keeps a failed cast branchless.
    fn try_interface(&mut self, dest: &str, interface: InterfaceId, source: &Place) -> Result<()> {
        let name = self
            .module
            .interface(interface)
            .and_then(|def| self.module.sym(def.name))
            .ok_or_else(|| InternalError::new(format!("interface {} is missing", interface.0)))?;
        let key = crate::llvm::vtable::interface_key(name);

        let object = self.address(source)?;
        let descriptor = self.descriptor_of(&object)?;
        let itab = self
            .runtime(
                RuntimeFn::FindItab,
                &[Val::new("ptr", descriptor), self.int("i64", key)],
            )?
            .ok_or_else(|| InternalError::new("`gf_find_itab` returned nothing"))?;

        self.store(dest, &itab, self.pointer_bytes());
        let second = self.offset(dest, self.pointer_bytes() as i64);
        self.store(&second, &Val::new("ptr", object), self.pointer_bytes());
        Ok(())
    }

    /// The dynamic type descriptor of the object at an address.
    ///
    /// The descriptor sits one pointer *before* the first method slot — see the
    /// module docs on `crate::vtable` for why the bias is that way round.
    fn descriptor_of(&mut self, object: &str) -> Result<String> {
        let vtable = self.tmp();
        self.line(format!(
            "{vtable} = load ptr, ptr {object}, align {}",
            self.pointer_bytes()
        ));
        let slot = self.offset(&vtable, -(self.pointer_bytes() as i64));
        let descriptor = self.tmp();
        self.line(format!(
            "{descriptor} = load ptr, ptr {slot}, align {}",
            self.pointer_bytes()
        ));
        Ok(descriptor)
    }

    /// `tryCast<C>(place)` for a class: walk the dynamic type's base chain.
    fn try_class(&mut self, class: ClassId, source: &Place) -> Result<Val> {
        let symbols = self
            .classes
            .get(class.index())
            .ok_or_else(|| InternalError::new(format!("class {} has no descriptor", class.0)))?;
        let target = format!("@{}", ident(&symbols.descriptor));

        let object = self.address(source)?;
        let descriptor = self.descriptor_of(&object)?;
        let answer = self
            .runtime(
                RuntimeFn::IsA,
                &[Val::new("ptr", descriptor), Val::new("ptr", target)],
            )?
            .ok_or_else(|| InternalError::new("`gf_is_a` returned nothing"))?;

        let yes = self.tmp();
        self.line(format!("{yes} = icmp ne i8 {}, 0", answer.name));
        let out = self.tmp();
        self.line(format!("{out} = select i1 {yes}, ptr {object}, ptr null"));
        Ok(Val::new("ptr", out))
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
                if !self.category(ty)?.needs_drop() {
                    return self.write(place, rvalue);
                }

                // The new value is built *before* the old one is destroyed, so
                // `s = s + s` and `a = a` are not reads of freed storage. The
                // scratch is a whole extra copy and that is the price of not
                // having to prove the two do not overlap.
                let layout = self.layouts.layout(ty)?;
                let (size, align) = (layout.size.max(1), layout.align.max(1));
                if self.is_aggregate(ty)? {
                    let scratch = self.scratch_slot(size, align);
                    self.write_into(&scratch, rvalue, ty)?;
                    let address = self.address(place)?;
                    self.destroy_at(ty, &address)?;
                    self.memcpy(&address, &scratch, layout.size, align);
                    return Ok(());
                }

                let Some(value) = self.rvalue(rvalue, ty)? else {
                    return Ok(());
                };
                let address = self.address(place)?;
                self.destroy_at(ty, &address)?;
                self.store(&address, &value, align);
                Ok(())
            }
            Statement::Drop {
                place,
                flag,
                unwind,
            } => {
                if let UnwindAction::Cleanup(_) = unwind {
                    internal_error!("a drop with a cleanup edge needs an unwinding runtime");
                }
                let ty = self.place_type(place)?;
                if !self.category(ty)?.needs_drop() {
                    // A trivial type's destructor is nothing at all.
                    return Ok(());
                }

                // A drop flag is set where a local may or may not be
                // initialised on the paths reaching here (REWRITE-PLAN §5.1).
                // The flag is a real branch, not an assumption.
                let Some(flag) = flag else {
                    let address = self.address(place)?;
                    return self.destroy_at(ty, &address);
                };
                let live = self.load_local(*flag)?;
                let bit = self.tmp();
                self.line(format!("{bit} = icmp ne {} {}, 0", live.ty, live.name));
                let (body, done) = (self.new_label(), self.new_label());
                self.line(format!("br i1 {bit}, label %{body}, label %{done}"));
                self.begin(&body);
                let address = self.address(place)?;
                self.destroy_at(ty, &address)?;
                self.goto(&done);
                self.begin(&done);
                Ok(())
            }
        }
    }

    /// Evaluate an rvalue into a place.
    fn write(&mut self, place: &Place, rvalue: &Rvalue) -> Result<()> {
        let ty = self.place_type(place)?;

        if self.is_aggregate(ty)? {
            let address = self.address(place)?;
            return self.write_into(&address, rvalue, ty);
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
    fn write_into(&mut self, dest: &str, rvalue: &Rvalue, ty: TyId) -> Result<()> {
        let layout = self.layouts.layout(ty)?;
        let (size, align) = (layout.size, layout.align.max(1));

        match rvalue {
            Rvalue::Default => {
                self.intrinsic(
                    "declare void @llvm.memset.p0.i64(ptr writeonly, i8, i64, i1 immarg)",
                );
                if size > 0 {
                    self.line(format!(
                        "call void @llvm.memset.p0.i64(ptr align {align} {dest}, i8 0, i64 {size}, i1 false)"
                    ));
                }
                // A default-constructed object still has a dynamic type, so its
                // vtable pointer is written rather than left zero.
                if let Some(TyKind::Class(id)) = self.module.ty(ty).map(|def| def.kind.clone()) {
                    let vtable = self.vtable_pointer(id)?;
                    self.store(dest, &vtable, self.pointer_bytes());
                }
                Ok(())
            }
            // `Copy` applies the type's copy operation field by field; `Move`
            // and `Borrow` transfer the bytes as they stand. That difference is
            // the whole of REWRITE-PLAN §4.3 in one match.
            Rvalue::Use(Operand::Copy(from)) => {
                let source = self.address(from)?;
                self.copy_aggregate(dest, &source, ty)
            }
            Rvalue::Use(Operand::Move(from) | Operand::Borrow(from)) => {
                let source = self.address(from)?;
                self.memcpy(dest, &source, size, align);
                Ok(())
            }
            Rvalue::Use(Operand::Const(_)) => {
                internal_error!("an aggregate constant has no lowering")
            }
            Rvalue::Aggregate { fields, .. } => {
                // A `FixedArray` has no field table — its elements are at
                // stride intervals — so the offsets come from the shape rather
                // than from `Layout::fields`.
                let offsets = match self.module.ty(ty).map(|def| def.kind.clone()) {
                    Some(TyKind::FixedArray { element, .. }) => {
                        let stride = self.layouts.layout(element)?.stride();
                        (0..fields.len()).map(|i| stride * (i as u32)).collect()
                    }
                    _ => self.layouts.layout(ty)?.fields.clone(),
                };
                for (index, field) in fields.iter().enumerate() {
                    let field_ty = self.operand_type(field)?;
                    let offset = offsets.get(index).copied().unwrap_or(0);
                    let at = self.offset(dest, offset as i64);
                    self.write_operand_to(&at, field, field_ty)?;
                }
                Ok(())
            }
            Rvalue::MakeInterface {
                interface,
                class,
                source,
            } => self.make_interface(dest, *interface, *class, source),
            Rvalue::TryInterface { interface, source } => {
                self.try_interface(dest, *interface, source)
            }
            other => internal_error!("{} into an aggregate has no lowering", rvalue_name(other)),
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
            // A `T[]` is a one-word handle, so an array literal is a value
            // rather than something built into a destination.
            Rvalue::Aggregate { ty: array, fields } => Some(self.build_array(*array, fields)?),
            Rvalue::Len(place) => Some(self.len_of(place)?),
            Rvalue::TryClass { class, source } => Some(self.try_class(*class, source)?),
            // Null-ness lives in the itab word alone, which is what lets
            // `Reference<I> | null` be the same sixteen bytes as `Reference<I>`.
            Rvalue::InterfaceIsNull(place) => {
                let address = self.address(place)?;
                let itab = self.tmp();
                self.line(format!(
                    "{itab} = load ptr, ptr {address}, align {}",
                    self.pointer_bytes()
                ));
                let bit = self.tmp();
                self.line(format!("{bit} = icmp eq ptr {itab}, null"));
                let out = self.tmp();
                self.line(format!("{out} = zext i1 {bit} to i8"));
                Some(Val::new("i8", out))
            }
            // Making room is the runtime's job and needs the element's stride
            // and alignment, which only the backend knows; storing the element
            // is an ordinary `Init` through the pointer this hands back. The
            // handle is **reseated**, because growing reallocates.
            Rvalue::ArrayPushSlot(place) => {
                let array_ty = self.place_type(place)?;
                let element = self.element_of(array_ty)?;
                let layout = self.layouts.layout(element)?;
                let handle = self.address(place)?;
                Some(
                    self.runtime(
                        RuntimeFn::ArrayPushSlot,
                        &[
                            Val::new("ptr", handle),
                            self.int("i64", layout.stride()),
                            self.int("i64", layout.align.max(1)),
                        ],
                    )?
                    .ok_or_else(|| InternalError::new("`gf_array_push_slot` returned nothing"))?,
                )
            }
            other => internal_error!("{} has no lowering", rvalue_name(other)),
        })
    }

    /// The element count of a `string`, a `CString` or a `T[]`.
    ///
    /// A `string`'s length is a load behind its pointer; a `CString`'s is a
    /// scan. That the two are different operations is what the two types are
    /// for.
    fn len_of(&mut self, place: &Place) -> Result<Val> {
        let ty = self.place_type(place)?;
        let handle = self.load(place, ty)?;
        let which = match self.module.ty(ty).map(|def| &def.kind) {
            Some(TyKind::Str) => RuntimeFn::StringLen,
            Some(TyKind::CStr) => RuntimeFn::CStrLen,
            Some(TyKind::Array(_)) => RuntimeFn::ArrayLen,
            _ => internal_error!("`length` on something with no length"),
        };
        self.runtime(which, &[handle])?
            .ok_or_else(|| InternalError::new("a length call returned nothing"))
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
                if self.is_aggregate(ty)? {
                    return Ok(Some(Val::new("ptr", self.address(place)?)));
                }
                let value = self.load(place, ty)?;
                match operand {
                    // `Copy` duplicates what the value owns; `Move` and
                    // `Borrow` read the machine value and leave ownership where
                    // it is. Passing `Copy` where `Borrow` belongs clones a
                    // second time and leaks (REWRITE-PLAN §4.5).
                    Operand::Copy(_) => Ok(Some(self.copy_of(ty, value)?)),
                    Operand::Move(_) => {
                        // **A moved-from handle is poisoned with null.** Only a
                        // one-word handle can be: an aggregate's "value" is its
                        // address, and there is no single word to null. Drop
                        // elaboration is what stops a moved-from aggregate being
                        // destroyed; this is the insurance for the handle case,
                        // where the frontend legitimately emits an `Assign` onto
                        // a moved-from binding — and without the null, that
                        // assignment's destroy is a double free.
                        if self.category(ty)?.needs_drop() {
                            let address = self.address(place)?;
                            let align = self.layouts.layout(ty)?.align.max(1);
                            self.store(&address, &Val::new(&value.ty, "null"), align);
                        }
                        Ok(Some(value))
                    }
                    _ => Ok(Some(value)),
                }
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

        // `+` on strings concatenates and `===` compares text, and both are
        // runtime calls rather than instructions. The operands were produced by
        // `Copy`, so concatenation consumes neither.
        if matches!(
            self.module.ty(operand_ty).map(|def| &def.kind),
            Some(TyKind::Str)
        ) {
            let which = match op {
                BinOp::Add => RuntimeFn::StringConcat,
                BinOp::Eq | BinOp::Ne => RuntimeFn::StringEq,
                other => internal_error!("{other:?} has no lowering for `string`"),
            };
            let result = self
                .runtime(which, &[left, right])?
                .ok_or_else(|| InternalError::new("a string operation returned nothing"))?;
            if op == BinOp::Ne {
                let out = self.tmp();
                self.line(format!("{out} = xor i8 {}, 1", result.name));
                return Ok(Val::new("i8", out));
            }
            return Ok(result);
        }

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
        let right_name = if matches!(op, BinOp::Shl | BinOp::Shr) {
            let converted = if right.ty != left.ty {
                self.convert_integer(&right, &left.ty, self.signed(self.operand_type(rhs)?))?
            } else {
                right.name.clone()
            };
            // **And then masked.** This is a place LLVM and Cranelift genuinely
            // differ: a shift of at least the value's width is *poison* in LLVM,
            // where Cranelift masks the count and the hardware does too. So
            // `1 << 9` in a `u8` would be poison rather than 2, and poison is
            // the failure mode §17 warns about — it does not crash, it makes
            // some later branch quietly unreachable. Masking here buys back the
            // language's own rule at the cost of one `and`.
            let width = int_bits(&left.ty)?;
            let masked = self.tmp();
            self.line(format!(
                "{masked} = and {} {converted}, {}",
                left.ty,
                width - 1
            ));
            masked
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
            // A small struct goes back to C **in registers** under both
            // conventions, so it is taken apart rather than returned by
            // address. Two or more carriers travel as an anonymous struct,
            // which is how clang spells a multi-register return.
            Repr::Aggregate => {
                let signature = self
                    .module
                    .sig(func.sig)
                    .cloned()
                    .ok_or_else(|| InternalError::new("a function has no signature"))?;
                let shape = abi::classify(self.layouts, &signature, self.conv)?;
                let Slot::Registers {
                    carriers,
                    size,
                    align,
                } = &shape.returns
                else {
                    internal_error!("an aggregate return without a return pointer");
                };
                let (carriers, size, align) = (carriers.clone(), *size, *align);
                let source = self.address(&Place::local(LocalId::RETURN))?;
                let values = self.gather_carriers(&source, &carriers, size, align)?;
                match values.as_slice() {
                    [] => internal_error!("a register return with no carriers"),
                    [one] => self.line(format!("ret {}", one.used())),
                    many => {
                        let struct_ty = format!(
                            "{{ {} }}",
                            many.iter()
                                .map(|value| value.ty.clone())
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        let mut current = "undef".to_owned();
                        for (index, value) in many.iter().enumerate() {
                            let next = self.tmp();
                            self.line(format!(
                                "{next} = insertvalue {struct_ty} {current}, {}, {index}",
                                value.used()
                            ));
                            current = next;
                        }
                        self.line(format!("ret {struct_ty} {current}"));
                    }
                }
            }
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

        let sig_id = match callee {
            Callee::Direct(FuncRef::Local(id)) => {
                self.module.funcs.get(id.index()).map(|def| def.sig)
            }
            Callee::Direct(FuncRef::Extern(id)) => {
                self.module.externs.get(id.index()).map(|def| def.sig)
            }
            Callee::Indirect { sig, .. }
            | Callee::Virtual { sig, .. }
            | Callee::Interface { sig, .. } => Some(*sig),
        }
        .ok_or_else(|| InternalError::new("a call to a function that is not declared"))?;
        let signature = self
            .module
            .sig(sig_id)
            .cloned()
            .ok_or_else(|| InternalError::new(format!("signature {} is missing", sig_id.0)))?;
        let rendered = sig::render(self.types, self.layouts, &signature, self.conv)?;
        let shape = if signature.abi == Abi::C {
            Some(abi::classify(self.layouts, &signature, self.conv)?)
        } else {
            None
        };

        // An aggregate result is written straight into the destination place,
        // so the caller hands over its address rather than receiving a copy —
        // the same mechanism as the C ABI's hidden return pointer, because it
        // must be one mechanism and not two (REWRITE-PLAN §4.5).
        let mut arguments: Vec<String> = Vec::with_capacity(args.len() + 1);
        if rendered.sret {
            let Some(dest) = destination else {
                internal_error!("a call returning an aggregate has nowhere to put it");
            };
            let address = self.address(&dest.place)?;
            arguments.push(format!("ptr {address}"));
        }

        let mut receiver = None;
        for (index, argument) in args.iter().enumerate() {
            let value = self
                .operand(argument)?
                .ok_or_else(|| InternalError::new("a call argument produced no value"))?;
            if index == 0 {
                receiver = Some(value.clone());
            }
            self.marshal(&mut arguments, value, shape.as_ref(), index, &signature)?;
        }

        let target = self.call_target(callee, &mut arguments, receiver, &rendered)?;

        let returns = rendered.returns.clone();
        let result = if returns == "void" {
            self.line(format!("call void {target}({})", arguments.join(", ")));
            None
        } else {
            let out = self.tmp();
            self.line(format!(
                "{out} = call {returns} {target}({})",
                arguments.join(", ")
            ));
            Some(Val::new(rendered.returns_type.clone(), out))
        };

        if let Some(dest) = destination
            && !rendered.sret
            && let Some(value) = result
        {
            let ty = self.place_type(&dest.place)?;
            // A small struct comes back *in registers* under both conventions,
            // so it is reassembled rather than stored.
            if let Some(Slot::Registers { size, align, .. }) =
                shape.as_ref().map(|shape| &shape.returns)
            {
                let address = self.address(&dest.place)?;
                self.scatter_carriers(&address, &value, *size, *align)?;
            } else if !self.is_aggregate(ty)? {
                let align = self.layouts.layout(ty)?.align.max(1);
                let address = self.address(&dest.place)?;
                self.store(&address, &value, align);
            }
        }

        match destination {
            Some(dest) => self.line(format!("br label %bb{}", dest.target.0)),
            // A call that cannot return.
            None => self.line("unreachable"),
        }
        Ok(())
    }

    /// Put one argument into whatever the platform says it travels in.
    fn marshal(
        &mut self,
        arguments: &mut Vec<String>,
        value: Val,
        shape: Option<&Shape>,
        index: usize,
        signature: &goblin_mir::Signature,
    ) -> Result<()> {
        match shape.and_then(|shape| shape.params.get(index)) {
            Some(Slot::Registers {
                carriers,
                size,
                align,
            }) => {
                let carriers = carriers.clone();
                for carrier in self.gather_carriers(&value.name, &carriers, *size, *align)? {
                    arguments.push(carrier.used());
                }
                Ok(())
            }
            // "Pointing at a copy the caller made" — the caller is us, and the
            // copy is what stops the callee writing through to our value.
            Some(Slot::ByAddress { size, align }) => {
                let (size, align) = (*size, *align);
                let scratch = self.scratch_slot(size, align);
                self.memcpy(&scratch, &value.name, size, align);
                arguments.push(format!("ptr {scratch}"));
                Ok(())
            }
            // System V's MEMORY class: LLVM makes the copy, and the argument
            // has to carry the same `byval` the declaration does.
            Some(Slot::OnStack { align, .. }) => {
                let align = *align;
                let ty = signature
                    .params
                    .get(index)
                    .map(|param| param.ty)
                    .ok_or_else(|| InternalError::new("a shape longer than its signature"))?;
                let named = self.types.aggregate(self.layouts, ty)?;
                arguments.push(format!("ptr byval({named}) align {align} {}", value.name));
                Ok(())
            }
            _ => {
                arguments.push(value.used());
                Ok(())
            }
        }
    }

    /// Where the call goes: a symbol, or an address computed at run time.
    fn call_target(
        &mut self,
        callee: &Callee,
        arguments: &mut [String],
        receiver: Option<Val>,
        rendered: &sig::Rendered,
    ) -> Result<String> {
        Ok(match callee {
            Callee::Direct(func) => format!("@{}", ident(&self.func_symbol(func)?)),
            // A `FnPtr` value *is* the code address, so there is nothing to
            // load — where a virtual call reads a vtable slot and an interface
            // call reads an itab slot, this one is already there.
            Callee::Indirect { operand, .. } => {
                let value = self
                    .operand(operand)?
                    .ok_or_else(|| InternalError::new("an indirect callee produced no value"))?;
                value.name
            }
            // Two loads and an indirect call. The receiver is `args[0]` — read
            // once, used both as `this` and as the source of the vtable
            // pointer, so the two cannot disagree.
            Callee::Virtual { slot, .. } => {
                let receiver = receiver
                    .ok_or_else(|| InternalError::new("a virtual call with no receiver"))?;
                let vtable = self.tmp();
                self.line(format!(
                    "{vtable} = load ptr, ptr {}, align {}",
                    receiver.name,
                    self.pointer_bytes()
                ));
                self.load_slot(&vtable, *slot)?
            }
            // `args[0]` is the address of the `(itab, data)` pair. Both halves
            // come out of that one operand, and `data` **replaces** it as the
            // receiver — the callee is an ordinary method expecting an object
            // address and knows nothing about interfaces.
            Callee::Interface { slot, .. } => {
                let pair =
                    receiver.ok_or_else(|| InternalError::new("an interface call with no pair"))?;
                let itab = self.tmp();
                self.line(format!(
                    "{itab} = load ptr, ptr {}, align {}",
                    pair.name,
                    self.pointer_bytes()
                ));
                let data_at = self.offset(&pair.name, self.pointer_bytes() as i64);
                let data = self.tmp();
                self.line(format!(
                    "{data} = load ptr, ptr {data_at}, align {}",
                    self.pointer_bytes()
                ));
                let first = usize::from(rendered.sret);
                if let Some(argument) = arguments.get_mut(first) {
                    *argument = format!("ptr {data}");
                }
                self.load_slot(&itab, *slot)?
            }
        })
    }

    /// Slot `n` of a vtable or an itab, both of which the pointer handed here
    /// already addresses the first method of.
    fn load_slot(&mut self, table: &str, slot: u32) -> Result<String> {
        let at = self.offset(table, i64::from(slot) * i64::from(self.pointer_bytes()));
        let out = self.tmp();
        self.line(format!(
            "{out} = load ptr, ptr {at}, align {}",
            self.pointer_bytes()
        ));
        Ok(out)
    }

    /// Read a struct's storage out as the registers it travels in.
    ///
    /// Through a scratch slot of whole eightbytes, then a byte copy of the real
    /// size: a carrier is eight bytes wide even when the tail of the struct is
    /// not, and loading it directly would read past the end. The scratch is
    /// zeroed first, so the padding a struct does not fill is not whatever the
    /// frame happened to hold — a register carrying stack garbage into a C
    /// function is the kind of difference that shows up on one machine.
    fn gather_carriers(
        &mut self,
        source: &str,
        carriers: &[crate::layout::Scalar],
        size: u32,
        align: u32,
    ) -> Result<Vec<Val>> {
        let padded = ((carriers.len() as u32) * 8).max(8);
        let scratch = self.scratch_slot(padded, 8);
        self.intrinsic("declare void @llvm.memset.p0.i64(ptr writeonly, i8, i64, i1 immarg)");
        self.line(format!(
            "call void @llvm.memset.p0.i64(ptr align 8 {scratch}, i8 0, i64 {padded}, i1 false)"
        ));
        self.memcpy(&scratch, source, size, align.max(1));

        let mut out = Vec::with_capacity(carriers.len());
        for (index, carrier) in carriers.iter().enumerate() {
            let at = self.offset(&scratch, (index as i64) * 8);
            let ty = scalar(*carrier);
            let value = self.tmp();
            self.line(format!("{value} = load {ty}, ptr {at}, align 8"));
            out.push(Val::new(ty, value));
        }
        Ok(out)
    }

    /// Write a register return back into a struct's storage.
    fn scatter_carriers(&mut self, dest: &str, value: &Val, size: u32, align: u32) -> Result<()> {
        let padded = size.next_multiple_of(8).max(8);
        let scratch = self.scratch_slot(padded, 8);
        // A multi-register return is an anonymous struct, so the pieces come
        // out with `extractvalue`; a single carrier is the value itself.
        if let Some(inner) = value.ty.strip_prefix('{').and_then(|t| t.strip_suffix('}')) {
            let parts: Vec<String> = inner.split(',').map(|p| p.trim().to_owned()).collect();
            for (index, ty) in parts.iter().enumerate() {
                let piece = self.tmp();
                self.line(format!(
                    "{piece} = extractvalue {} {}, {index}",
                    value.ty, value.name
                ));
                let at = self.offset(&scratch, (index as i64) * 8);
                self.line(format!("store {ty} {piece}, ptr {at}, align 8"));
            }
        } else {
            self.line(format!(
                "store {} {}, ptr {scratch}, align 8",
                value.ty, value.name
            ));
        }
        self.memcpy(dest, &scratch, size, align.max(1));
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
