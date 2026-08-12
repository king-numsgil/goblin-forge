//! MIR to Cranelift IR.
//!
//! The MIR is already a CFG, so this is close to a transcription: one Cranelift
//! block per MIR block, one Cranelift `Variable` per MIR local that never needs
//! an address. What it is *not* is a place where decisions get made. Copy
//! versus move, initialisation versus assignment, where a drop goes — all of
//! that was settled by the frontend, and this file obeys.

use std::collections::HashMap;

use cranelift_codegen::ir::condcodes::{FloatCC, IntCC};
use cranelift_codegen::ir::{
    AbiParam, Block as ClifBlock, InstBuilder, MemFlagsData, StackSlotData, StackSlotKind,
    TrapCode, Value, types,
};
use cranelift_codegen::isa::TargetFrontendConfig;
use cranelift_frontend::{FunctionBuilder, Switch, Variable};
use cranelift_module::{FuncId as ClifFuncId, Module as ClifModule};

use goblin_mir::{
    Abi, AbortReason, BinOp, BlockId, BlockKind, Callee, CastKind, Category, ClassId, Const,
    FloatTy, FuncId, FuncRef, Function, InterfaceId, LocalId, Module, Operand, Place, Projection,
    Rvalue, SigId, Signature, Statement, Terminator, TyId, TyKind, UnOp, UnwindAction,
};

use crate::abi::{self, Slot as AbiSlot};
use crate::error::{InternalError, Result};
use crate::internal_error;
use crate::layout::{Layouts, Repr, TargetInfo, align_to};
use crate::runtime::{RuntimeFn, RuntimeRefs, STRING_HEADER_BYTES};

/// Where a MIR local lives.
///
/// Distinct from [`AbiSlot`], which says how a value *travels* at a call — this
/// says where it *sits* inside one function.
#[derive(Debug, Clone, Copy)]
enum LocalSlot {
    /// An SSA variable. cranelift-frontend inserts the block parameters, so
    /// nothing here has to think about phis.
    Register(Variable),
    /// A variable holding the *address* of the value, not the value. An
    /// aggregate parameter, which arrives as a pointer to the caller's copy.
    Indirect(Variable),
    /// A stack slot, because something takes its address or reaches into it.
    Memory {
        slot: cranelift_codegen::ir::StackSlot,
        ty: TyId,
    },
    /// A `void` local — the return place of a `void` function. Occupies
    /// nothing and is never read.
    Empty,
}

/// Where a call goes.
///
/// A direct call names a symbol the linker resolves. An indirect one calls an
/// address computed at run time — a vtable slot today, a `FnPtr` value later —
/// and needs its signature imported, because there is no declaration to read it
/// off.
#[derive(Debug, Clone, Copy)]
enum CallTarget {
    Direct(cranelift_module::FuncId),
    Indirect(Value),
}

/// Build a Cranelift signature from a MIR one.
///
/// **Sub-register-width integers carry `zeroext`/`signext`.** Cranelift
/// defaults to neither; rustc and clang both attach them, and a callee compiled
/// that way may use the whole register without masking first (REWRITE-PLAN §6).
pub fn translate_signature(
    layouts: &mut Layouts<'_>,
    sig: &Signature,
    call_conv: cranelift_codegen::isa::CallConv,
) -> Result<cranelift_codegen::ir::Signature> {
    let pointer = layouts.target().pointer_type();

    // At the boundary, an aggregate is not an address — it is the struct, packed
    // into registers or copied onto the stack by rules that differ per platform.
    // Handing a C function an address instead produces an answer made of the
    // address, so `Abi::C` is classified rather than passed our way.
    if sig.abi == Abi::C {
        let conv = abi::Conv::of_call_conv(call_conv);
        let shape = abi::classify(layouts, sig, conv)?;
        return Ok(abi::to_signature(&shape, call_conv, pointer));
    }

    let mut out = cranelift_codegen::ir::Signature::new(call_conv);

    // An aggregate return is a hidden pointer parameter, and it comes *first*.
    //
    // Cranelift returns the `sret` pointer itself from the parameter's
    // `StructReturn` purpose. Declaring it as a return value as well panics
    // inside the ABI layer, with a message that does not obviously say so
    // (REWRITE-PLAN §10).
    let returns_aggregate = matches!(layouts.repr(sig.ret)?, Repr::Aggregate);
    if returns_aggregate {
        out.params.push(AbiParam::special(
            pointer,
            cranelift_codegen::ir::ArgumentPurpose::StructReturn,
        ));
    }

    for param in &sig.params {
        match layouts.repr(param.ty)? {
            Repr::Void => internal_error!("a parameter cannot have type `void`"),
            Repr::Register(ty) => out.params.push(extended(ty, param.ty, layouts, sig.abi)?),
            // `Internal` is whatever is fastest, and for an aggregate that is
            // by address: the caller has already made the copy that *is* the
            // argument, so passing its address costs one register instead of a
            // second copy (REWRITE-PLAN §6).
            Repr::Aggregate => out.params.push(AbiParam::new(pointer)),
        }
    }

    if !returns_aggregate {
        match layouts.repr(sig.ret)? {
            Repr::Void => {}
            Repr::Register(ty) => out.returns.push(extended(ty, sig.ret, layouts, sig.abi)?),
            Repr::Aggregate => unreachable!("handled above"),
        }
    }

    Ok(out)
}

fn extended(clif: types::Type, ty: TyId, layouts: &mut Layouts<'_>, abi: Abi) -> Result<AbiParam> {
    let param = AbiParam::new(clif);
    // Only the C ABI needs the extension: an internal call has both halves
    // compiled by us, and both agree that the high bits are undefined. Marking
    // it anyway would be harmless but slower.
    if abi != Abi::C || clif.bits() >= 32 {
        return Ok(param);
    }
    Ok(match signedness(layouts, ty) {
        Some(true) => param.sext(),
        _ => param.uext(),
    })
}

/// `Some(true)` for a signed integer, `Some(false)` for anything else that
/// occupies a sub-register width, `None` when the type is not in the table.
fn signedness(layouts: &Layouts<'_>, ty: TyId) -> Option<bool> {
    match &layouts.module().ty(ty)?.kind {
        TyKind::Int(int) => Some(int.is_signed()),
        _ => Some(false),
    }
}

pub struct FunctionTranslator<'a, 'm, M: ClifModule> {
    builder: FunctionBuilder<'a>,
    layouts: &'a mut Layouts<'m>,
    module: &'m Module,
    clif_module: &'a mut M,
    /// MIR function ids and extern ids to declared Cranelift functions.
    locals: Vec<LocalSlot>,
    /// The declared type of each local, so a place's type can be walked without
    /// carrying the whole `Function` around.
    local_types: Vec<TyId>,
    blocks: Vec<ClifBlock>,
    context: ModuleContext<'a>,
    /// The caller's storage for an aggregate return, when the signature has one.
    sret: Option<Value>,
    call_conv: cranelift_codegen::isa::CallConv,
    target: TargetInfo,
    frontend_config: TargetFrontendConfig,
}

/// The Cranelift ids of everything a module can call, resolved once.
pub struct FuncRefs {
    pub defined: Vec<ClifFuncId>,
    pub imported: Vec<ClifFuncId>,
}

/// State shared by every function in one module.
///
/// Grouped because it is one thing — "the module being compiled" — rather than
/// four, and because threading four more parameters through every translator is
/// how a signature becomes unreadable.
pub struct ModuleContext<'a> {
    pub func_refs: &'a FuncRefs,
    /// The descriptor and vtable of every class, indexed by `ClassId`.
    pub classes: &'a [crate::vtable::ClassData],
    pub runtime: &'a mut RuntimeRefs,
    /// String literals already emitted, so identical text is emitted once.
    pub literals: &'a mut HashMap<String, cranelift_module::DataId>,
}

impl<'a, 'm, M: ClifModule> FunctionTranslator<'a, 'm, M> {
    pub fn new(
        builder: FunctionBuilder<'a>,
        layouts: &'a mut Layouts<'m>,
        module: &'m Module,
        clif_module: &'a mut M,
        context: ModuleContext<'a>,
        call_conv: cranelift_codegen::isa::CallConv,
        frontend_config: TargetFrontendConfig,
    ) -> Self {
        let target = layouts.target();
        FunctionTranslator {
            builder,
            layouts,
            module,
            clif_module,
            locals: Vec::new(),
            local_types: Vec::new(),
            blocks: Vec::new(),
            context,
            sret: None,
            call_conv,
            target,
            frontend_config,
        }
    }

    pub fn translate(mut self, func: &Function) -> Result<()> {
        self.allocate_locals(func)?;

        for _ in &func.blocks {
            let block = self.builder.create_block();
            self.blocks.push(block);
        }

        let entry = self.blocks[BlockId::ENTRY.index()];
        self.builder.append_block_params_for_function_params(entry);
        self.builder.switch_to_block(entry);

        // Parameters are locals 1..=n, in order — after the hidden struct-return
        // pointer, when there is one.
        let params: Vec<Value> = self.builder.block_params(entry).to_vec();
        self.bind_parameters(func, &params)?;

        for (index, block) in func.blocks.iter().enumerate() {
            let clif_block = self.blocks[index];
            self.builder.switch_to_block(clif_block);

            if block.kind == BlockKind::Cleanup {
                // Cleanup paths exist in the MIR from the start so that drop
                // elaboration can compute them while it is placing drops
                // (REWRITE-PLAN §11.5). Nothing can unwind yet, so reaching one
                // at runtime is impossible; emitting a trap rather than the
                // drops keeps the object file honest about that.
                self.builder.ins().trap(TrapCode::unwrap_user(1));
                continue;
            }

            for statement in &block.statements {
                self.statement(statement)?;
            }
            self.terminator(&block.terminator, func)?;
        }

        self.builder.seal_all_blocks();
        self.builder.finalize(self.frontend_config);
        Ok(())
    }

    // -- locals -------------------------------------------------------------

    /// Decide, per local, between an SSA variable and a stack slot.
    ///
    /// A local needs real memory when its address is taken or when something
    /// reaches into it, because both need an address to compute from. Anything
    /// else is a variable, and cranelift-frontend turns the assignments into
    /// SSA for us.
    fn allocate_locals(&mut self, func: &Function) -> Result<()> {
        let addressed = addressed_locals(func);
        let param_count = self.module.sig(func.sig).map_or(0, |sig| sig.params.len());
        let pointer_ty = self.target.pointer_type();

        for (index, decl) in func.locals.iter().enumerate() {
            let local = LocalId(index as u32);
            self.local_types.push(decl.ty);
            let repr = self.layouts.repr(decl.ty)?;
            // A parameter of aggregate type arrives as an address the caller
            // owns, so the local *is* that address rather than storage of its
            // own. Copying it into a fresh slot would be a second copy of an
            // argument the caller already copied.
            if matches!(repr, Repr::Aggregate) && (1..=param_count).contains(&index) {
                self.locals
                    .push(LocalSlot::Indirect(self.builder.declare_var(pointer_ty)));
                continue;
            }
            let slot = match repr {
                Repr::Void => LocalSlot::Empty,
                Repr::Register(ty) if !addressed.contains(&local) => {
                    LocalSlot::Register(self.builder.declare_var(ty))
                }
                Repr::Register(_) | Repr::Aggregate => {
                    let layout = self.layouts.layout(decl.ty)?;
                    let size = align_to(layout.size.max(1), layout.align);
                    let slot = self.builder.create_sized_stack_slot(StackSlotData::new(
                        StackSlotKind::ExplicitSlot,
                        size,
                        layout.align.trailing_zeros() as u8,
                    ));
                    LocalSlot::Memory { slot, ty: decl.ty }
                }
            };
            self.locals.push(slot);
        }
        Ok(())
    }

    /// The classified shape of a signature, when it crosses the C boundary.
    fn shape_of(&mut self, sig: SigId) -> Result<Option<abi::Shape>> {
        let signature = self
            .module
            .sig(sig)
            .cloned()
            .ok_or_else(|| InternalError::new(format!("signature {} is missing", sig.0)))?;
        if signature.abi != Abi::C {
            return Ok(None);
        }
        let conv = abi::Conv::of_call_conv(self.call_conv);
        Ok(Some(abi::classify(self.layouts, &signature, conv)?))
    }

    /// Bind the incoming block parameters to the function's locals.
    ///
    /// For an internal call this is one value per local. At the C boundary it
    /// is not: a struct may arrive spread across two registers, or as the
    /// address of a copy the caller made, and putting it back together is what
    /// makes the callee's view of its own parameters ordinary again.
    fn bind_parameters(&mut self, func: &Function, params: &[Value]) -> Result<()> {
        let shape = self.shape_of(func.sig)?;
        let mut next = 0usize;
        let mut take = |count: usize| -> Vec<Value> {
            let out = params[next..next + count].to_vec();
            next += count;
            out
        };

        let Some(shape) = shape else {
            if self.returns_aggregate(func)? {
                self.sret = take(1).first().copied();
            }
            for (index, value) in params[next..].iter().enumerate() {
                self.store_local(LocalId::param(index as u32), *value)?;
            }
            return Ok(());
        };

        if shape.has_sret() {
            self.sret = take(1).first().copied();
        }

        for (index, slot) in shape.params.iter().enumerate() {
            let local = LocalId::param(index as u32);
            match slot {
                AbiSlot::None => {}
                AbiSlot::Plain { .. } => {
                    let value = take(1);
                    self.store_local(local, value[0])?;
                }
                AbiSlot::Registers {
                    carriers,
                    size,
                    align,
                } => {
                    let values = take(carriers.len());
                    let dest = self.address_of_local(local)?;
                    self.scatter_carriers(dest, &values, *size, *align)?;
                }
                // Already an address: the caller's copy, which the callee may
                // treat as its own storage.
                AbiSlot::ByAddress { .. } | AbiSlot::OnStack { .. } => {
                    let value = take(1);
                    self.store_local(local, value[0])?;
                }
                AbiSlot::Sret { .. } => {
                    internal_error!("a parameter classified as a struct return")
                }
            }
        }
        Ok(())
    }

    /// The address of a local's storage, for writing an incoming struct into.
    fn address_of_local(&mut self, local: LocalId) -> Result<Value> {
        let pointer = self.target.pointer_type();
        match self.slot(local)? {
            LocalSlot::Memory { slot, .. } => Ok(self.builder.ins().stack_addr(pointer, slot, 0)),
            LocalSlot::Indirect(var) => Ok(self.builder.use_var(var)),
            LocalSlot::Register(_) => {
                internal_error!("_{} holds a struct but lives in a register", local.0)
            }
            LocalSlot::Empty => internal_error!("_{} has no storage", local.0),
        }
    }

    /// Write register carriers into a struct's storage.
    ///
    /// Through a scratch slot of whole eightbytes, then a byte copy of the real
    /// size. A carrier is eight bytes wide even when the tail of the struct is
    /// not, and storing it directly would write past the end.
    fn scatter_carriers(
        &mut self,
        dest: Value,
        carriers: &[Value],
        size: u32,
        align: u32,
    ) -> Result<()> {
        let pointer = self.target.pointer_type();
        let padded = (carriers.len() as u32) * 8;
        let scratch = self.builder.create_sized_stack_slot(StackSlotData::new(
            StackSlotKind::ExplicitSlot,
            padded.max(8),
            3,
        ));
        for (index, carrier) in carriers.iter().enumerate() {
            self.builder
                .ins()
                .stack_store(pointer, *carrier, scratch, (index * 8) as i32);
        }
        let source = self.builder.ins().stack_addr(pointer, scratch, 0);
        self.copy_bytes(dest, source, size, align);
        Ok(())
    }

    /// Read a struct's storage back out as register carriers.
    fn gather_carriers(
        &mut self,
        source: Value,
        carriers: &[types::Type],
        size: u32,
        align: u32,
    ) -> Result<Vec<Value>> {
        let pointer = self.target.pointer_type();
        let padded = (carriers.len() as u32) * 8;
        let scratch = self.builder.create_sized_stack_slot(StackSlotData::new(
            StackSlotKind::ExplicitSlot,
            padded.max(8),
            3,
        ));
        let dest = self.builder.ins().stack_addr(pointer, scratch, 0);
        // Zeroed first, so the padding a struct does not fill is not whatever
        // the frame happened to hold — a register carrying stack garbage into a
        // C function is the kind of difference that shows up on one machine.
        let config = self.frontend_config;
        self.builder.emit_small_memset(
            config,
            dest,
            0,
            u64::from(padded.max(8)),
            8,
            MemFlagsData::trusted(),
        );
        self.copy_bytes(dest, source, size, align);

        let mut out = Vec::with_capacity(carriers.len());
        for (index, carrier) in carriers.iter().enumerate() {
            out.push(
                self.builder
                    .ins()
                    .stack_load(pointer, *carrier, scratch, (index * 8) as i32),
            );
        }
        Ok(out)
    }

    /// A stack copy of a struct, for an argument passed by address.
    fn copy_to_stack(&mut self, source: Value, size: u32, align: u32) -> Result<Value> {
        let pointer = self.target.pointer_type();
        let slot = self.builder.create_sized_stack_slot(StackSlotData::new(
            StackSlotKind::ExplicitSlot,
            size.max(1),
            align.min(16).trailing_zeros() as u8,
        ));
        let dest = self.builder.ins().stack_addr(pointer, slot, 0);
        self.copy_bytes(dest, source, size, align);
        Ok(dest)
    }

    fn returns_aggregate(&mut self, func: &Function) -> Result<bool> {
        let ret = self
            .module
            .sig(func.sig)
            .ok_or_else(|| InternalError::new("signature is missing"))?
            .ret;
        Ok(matches!(self.layouts.repr(ret)?, Repr::Aggregate))
    }

    fn slot(&self, local: LocalId) -> Result<LocalSlot> {
        self.locals
            .get(local.index())
            .copied()
            .ok_or_else(|| InternalError::new(format!("local _{} is not declared", local.0)))
    }

    fn store_local(&mut self, local: LocalId, value: Value) -> Result<()> {
        match self.slot(local)? {
            LocalSlot::Register(var) | LocalSlot::Indirect(var) => {
                self.builder.def_var(var, value);
                Ok(())
            }
            LocalSlot::Memory { slot, .. } => {
                let pointer = self.target.pointer_type();
                self.builder.ins().stack_store(pointer, value, slot, 0);
                Ok(())
            }
            LocalSlot::Empty => Ok(()),
        }
    }

    // -- statements ---------------------------------------------------------

    fn statement(&mut self, statement: &Statement) -> Result<()> {
        match statement {
            // `Init` and `Assign` differ in whether the destination already
            // holds a live value that must be destroyed first. For a trivial
            // type there is nothing to destroy, so they lower identically —
            // and they are still two nodes, because for an owning type they
            // are not (REWRITE-PLAN §4.3).
            Statement::Init { place, rvalue } => {
                // An aggregate literal is constructed *into* its destination
                // rather than built somewhere and copied. REWRITE-PLAN §4.4:
                // copy elision is an explicit decision, and this is where the
                // decision is spelled — `Init` of an `Aggregate`, not a pattern
                // the backend recognises after the fact.
                if let Rvalue::Aggregate { ty, fields } = rvalue {
                    return self.build_aggregate(place, *ty, fields);
                }
                if let Rvalue::MakeInterface {
                    interface,
                    class,
                    source,
                } = rvalue
                {
                    return self.make_interface(place, *interface, *class, source);
                }
                if let Rvalue::TryInterface { interface, source } = rvalue {
                    return self.try_interface(place, *interface, source);
                }
                // `default_init`, one of REWRITE-PLAN §4.3's four operations.
                // For an aggregate it zeroes the bytes, which is what §10 asks
                // for in so many words: constructing into a stack slot runs a
                // constructor, and a constructor releases whatever the slot used
                // to hold — on uninitialised stack that is a garbage pointer.
                if matches!(rvalue, Rvalue::Default) {
                    return self.default_init(place);
                }
                let moving = is_move(rvalue);
                let value = self.rvalue(rvalue)?;
                self.write_place_with(place, value, moving)
            }
            Statement::Assign { place, rvalue } => {
                self.destroy_before_overwrite(place)?;
                let moving = is_move(rvalue);
                let value = self.rvalue(rvalue)?;
                self.write_place_with(place, value, moving)
            }
            Statement::Drop {
                place,
                flag,
                unwind,
            } => self.drop_place(place, *flag, *unwind),
            Statement::SetDropFlag { flag, value } => {
                let constant = self.builder.ins().iconst(types::I8, i64::from(*value));
                self.store_local(*flag, constant)
            }
            // Storage markers exist for the drop pass, which has already run.
            // Cranelift computes its own stack frame, so there is nothing to
            // emit for either of them.
            Statement::StorageLive(_) | Statement::StorageDead(_) | Statement::Nop => Ok(()),
        }
    }

    /// `Assign` destroys the old value before the new one lands.
    ///
    /// This is the whole difference between `Assign` and `Init`, and it is why
    /// they are two nodes rather than one with a flag.
    fn destroy_before_overwrite(&mut self, place: &Place) -> Result<()> {
        let ty = self.place_type(place)?;
        if !self.category(ty)?.needs_drop() {
            return Ok(());
        }
        let old = self.read_raw(place)?;
        self.destroy(ty, old)
    }

    fn drop_place(
        &mut self,
        place: &Place,
        flag: Option<LocalId>,
        _unwind: UnwindAction,
    ) -> Result<()> {
        let ty = self.place_type(place)?;
        // A trivial type has nothing to destroy. The `Drop` statement is still
        // in the MIR and the pass that placed it still ran — which is what made
        // the pass testable before there was anything for it to destroy.
        if !self.category(ty)?.needs_drop() {
            return Ok(());
        }

        let Some(flag) = flag else {
            let value = self.read_raw(place)?;
            return self.destroy(ty, value);
        };

        // A conditional drop: the local may or may not have been initialised on
        // the paths reaching here, and the flag says which.
        let condition = match self.slot(flag)? {
            LocalSlot::Register(var) => self.builder.use_var(var),
            LocalSlot::Memory { slot, .. } => {
                let pointer = self.target.pointer_type();
                self.builder.ins().stack_load(pointer, types::I8, slot, 0)
            }
            LocalSlot::Indirect(_) => internal_error!("a drop flag is not an aggregate"),
            LocalSlot::Empty => internal_error!("a drop flag with no storage"),
        };

        let run = self.builder.create_block();
        let after = self.builder.create_block();
        self.builder.ins().brif(condition, run, &[], after, &[]);

        self.builder.switch_to_block(run);
        let value = self.read_raw(place)?;
        self.destroy(ty, value)?;
        self.builder.ins().jump(after, &[]);

        self.builder.switch_to_block(after);
        Ok(())
    }

    /// Emit the destroy operation for a value of `ty`.
    ///
    /// For an aggregate, `value` is its address and each owning field is
    /// destroyed **in place**, through a direct call to its own drop chain. An
    /// inline field is never handed back to the allocator on its own; its
    /// parent's storage is (REWRITE-PLAN §4.2).
    fn destroy(&mut self, ty: TyId, value: Value) -> Result<()> {
        let kind = self
            .module
            .ty(ty)
            .map(|def| def.kind.clone())
            .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))?;

        match kind {
            TyKind::Str => {
                self.call_runtime(RuntimeFn::StringFree, &[value])?;
                Ok(())
            }
            // Every element, in reverse. The array's own storage is its
            // parent's to reclaim; an inline value is never handed back to the
            // allocator on its own (REWRITE-PLAN §4.2).
            TyKind::FixedArray { element, length } => {
                let stride = self.layouts.layout(element)?.stride();
                for index in (0..length).rev() {
                    let at = stride * (index as u32);
                    let slot = self.field_value(value, at, element)?;
                    self.destroy(element, slot)?;
                }
                Ok(())
            }
            TyKind::Struct(id) => {
                let layout = self.layouts.layout(ty)?;
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
                    let field = self.field_value(value, at, *field_ty)?;
                    self.destroy(*field_ty, field)?;
                }
                Ok(())
            }
            // A **direct** call to this class's own destructor, not a virtual
            // one — and that is not an optimisation, it is the only correct
            // choice. `value` addresses storage laid out for exactly this
            // class, so its dynamic type *is* its static type: anything else
            // put there would have been sliced on the way in
            // (REWRITE-PLAN §4.2). Virtual destruction is for destroying
            // *through* a `Pointer<Base>`, which is a different operation with
            // a different spelling.
            TyKind::Class(id) => {
                let destructor = self
                    .module
                    .class(id)
                    .and_then(|def| def.vtable.first().copied())
                    .ok_or_else(|| {
                        InternalError::new(format!(
                            "class {} has no destructor in vtable slot 0",
                            id.0,
                        ))
                    })?;
                self.call_local(destructor, &[value])?;
                Ok(())
            }
            _ => internal_error!("no destroy operation for this type yet"),
        }
    }

    /// Call a function defined in this module, by id.
    fn call_local(&mut self, func: FuncId, args: &[Value]) -> Result<Option<Value>> {
        let clif_func = self
            .context
            .func_refs
            .defined
            .get(func.index())
            .copied()
            .ok_or_else(|| InternalError::new(format!("function {} is missing", func.0)))?;
        let func_ref = self
            .clif_module
            .declare_func_in_func(clif_func, self.builder.func);
        let call = self.builder.ins().call(func_ref, args);
        Ok(self.builder.inst_results(call).first().copied())
    }

    /// Build a `Reference<I>` in place: the itab, then the object's address.
    ///
    /// Two stores and no lookup. The class is the *static* type of the source,
    /// so converting a `Base` yields a `Base`'s itab even when the object is
    /// really a `Derived` — and dispatch still reaches the derived override,
    /// because the itab holds `Base`'s final overriders, which is where the
    /// vtable would have sent it too.
    fn make_interface(
        &mut self,
        place: &Place,
        interface: InterfaceId,
        class: ClassId,
        source: &Place,
    ) -> Result<()> {
        let data =
            self.context.classes.get(class.index()).ok_or_else(|| {
                InternalError::new(format!("class {} has no static data", class.0))
            })?;
        let itab_data = *data.itabs.get(&interface.0).ok_or_else(|| {
            InternalError::new(format!(
                "class {} has no itab for interface {} — the frontend records every \
                 conversion it lowers, so reaching here means one was not recorded",
                class.0, interface.0,
            ))
        })?;

        let pointer = self.target.pointer_type();
        let global = self
            .clif_module
            .declare_data_in_func(itab_data, self.builder.func);
        let itab = self.builder.ins().symbol_value(pointer, global);
        // Biased past the descriptor word, exactly as a vtable pointer is, so
        // that slot `n` is at `n * 8` and the descriptor is at `-8`.
        let itab = self
            .builder
            .ins()
            .iadd_imm_s(itab, crate::vtable::ClassData::vtable_bias(self.target));

        let (address, offset) = self.place_address(source)?;
        let object = if offset == 0 {
            address
        } else {
            self.builder.ins().iadd_imm_s(address, i64::from(offset))
        };

        let (dest, dest_offset) = self.place_address(place)?;
        let dest = if dest_offset == 0 {
            dest
        } else {
            self.builder.ins().iadd_imm_s(dest, i64::from(dest_offset))
        };
        let flags = MemFlagsData::trusted();
        self.builder.ins().store(flags, itab, dest, 0);
        self.builder
            .ins()
            .store(flags, object, dest, self.target.pointer_bytes as i32);
        Ok(())
    }

    /// `tryCast<I>(place)`: the same pair, resolved at run time.
    ///
    /// Three loads and a call. The object's vtable pointer leads to its
    /// **dynamic** type descriptor — the whole point, since the static type is
    /// what failed to answer the question — and the runtime searches that
    /// descriptor's itab table.
    ///
    /// The object address is stored either way. Null-ness lives in the itab
    /// word alone, which is what lets `Reference<I> | null` be the same sixteen
    /// bytes as `Reference<I>` and keeps a failed cast branchless.
    fn try_interface(
        &mut self,
        place: &Place,
        interface: InterfaceId,
        source: &Place,
    ) -> Result<()> {
        let name = self
            .module
            .interface(interface)
            .and_then(|def| self.module.sym(def.name))
            .ok_or_else(|| InternalError::new(format!("interface {} is missing", interface.0)))?;
        let key = crate::vtable::interface_key(name);

        let (address, offset) = self.place_address(source)?;
        let object = if offset == 0 {
            address
        } else {
            self.builder.ins().iadd_imm_s(address, i64::from(offset))
        };

        let pointer = self.target.pointer_type();
        let flags = MemFlagsData::trusted();
        let vtable = self.builder.ins().load(pointer, flags, object, 0);
        // The descriptor sits one pointer *before* the first method slot — see
        // the module docs on `crate::vtable` for why the bias is that way round.
        let descriptor =
            self.builder
                .ins()
                .load(pointer, flags, vtable, -(self.target.pointer_bytes as i32));

        let key = self.builder.ins().iconst(types::I64, key as i64);
        let itab = self
            .call_runtime(RuntimeFn::FindItab, &[descriptor, key])?
            .ok_or_else(|| InternalError::new("`gf_find_itab` returned nothing"))?;

        let (dest, dest_offset) = self.place_address(place)?;
        let dest = if dest_offset == 0 {
            dest
        } else {
            self.builder.ins().iadd_imm_s(dest, i64::from(dest_offset))
        };
        self.builder.ins().store(flags, itab, dest, 0);
        self.builder
            .ins()
            .store(flags, object, dest, self.target.pointer_bytes as i32);
        Ok(())
    }

    /// The value an object of `class` carries in its vtable slot at offset 0.
    ///
    /// Biased past the descriptor word, so a virtual call indexes from it with
    /// no adjustment — see the module docs on [`crate::vtable`].
    fn vtable_pointer(&mut self, class: ClassId) -> Result<Value> {
        let data = self
            .context
            .classes
            .get(class.index())
            .ok_or_else(|| InternalError::new(format!("class {} has no vtable", class.0)))?
            .vtable;
        let global = self
            .clif_module
            .declare_data_in_func(data, self.builder.func);
        let pointer = self.target.pointer_type();
        let base = self.builder.ins().symbol_value(pointer, global);
        Ok(self
            .builder
            .ins()
            .iadd_imm_s(base, crate::vtable::ClassData::vtable_bias(self.target)))
    }

    /// The types of a class's fields, flattened, base classes' first.
    fn class_field_types(&self, id: ClassId) -> Result<Vec<TyId>> {
        self.module
            .class(id)
            .map(|def| def.fields.iter().map(|field| field.ty).collect())
            .ok_or_else(|| InternalError::new(format!("class {} is missing", id.0)))
    }

    /// The value of a field at `offset` inside the aggregate at `base`.
    fn field_value(&mut self, base: Value, offset: u32, ty: TyId) -> Result<Value> {
        Ok(match self.layouts.repr(ty)? {
            // A nested aggregate is inline, so its "value" is its address.
            Repr::Aggregate => self.builder.ins().iadd_imm_s(base, i64::from(offset)),
            Repr::Register(clif) => {
                self.builder
                    .ins()
                    .load(clif, MemFlagsData::trusted(), base, offset as i32)
            }
            Repr::Void => internal_error!("a `void` field"),
        })
    }

    /// Emit the copy operation for a value of `ty`.
    ///
    /// Trivial types are the value itself. An owning type clones what it owns —
    /// and the operation comes from the *type*, never from the shape of the
    /// expression that produced the value. There is no default.
    fn copy_of(&mut self, ty: TyId, value: Value) -> Result<Value> {
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
                .call_runtime(RuntimeFn::StringClone, &[value])?
                .ok_or_else(|| InternalError::new("`gf_string_clone` returned nothing")),
            // An aggregate is copied *into* a destination rather than copied to
            // a value, so this hands back the address and lets `write_place`
            // do the field-wise work. `memcpy` here would shallow-copy every
            // owning field and double free every one of them.
            TyKind::FixedArray { .. } | TyKind::Struct(_) | TyKind::Class(_) => Ok(value),
            _ => internal_error!("no copy operation for this type yet"),
        }
    }

    /// Copy an aggregate field by field, applying each field's own copy op.
    ///
    /// REWRITE-PLAN §10: `memcpy` is the right copy for a struct of `i32` and a
    /// double free for one holding a `string`. The operation comes from the
    /// field's type, and there is no default.
    fn copy_aggregate(&mut self, dest: Value, src: Value, ty: TyId) -> Result<()> {
        let layout = self.layouts.layout(ty)?;

        if !self.category(ty)?.needs_drop() {
            // Nothing inside owns anything, so the bytes are the whole value —
            // padding included, which is what keeps it identical to what a C
            // compiler would do.
            self.copy_bytes(dest, src, layout.size, layout.align);
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
                let source = self.field_value(src, at, element)?;
                if matches!(self.layouts.repr(element)?, Repr::Aggregate) {
                    let into = self.builder.ins().iadd_imm_s(dest, i64::from(at));
                    self.copy_aggregate(into, source, element)?;
                } else {
                    let copied = self.copy_of(element, source)?;
                    self.builder
                        .ins()
                        .store(MemFlagsData::trusted(), copied, dest, at as i32);
                }
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
            // `Base` — the derived part is not copied and the object does not
            // pretend to be one. Writing the vtable pointer here rather than
            // letting the field loop memcpy it is the whole of that rule: a
            // byte copy of offset 0 would carry the source's dynamic type into
            // a slot that cannot hold the rest of it.
            TyKind::Class(id) => {
                let vtable = self.vtable_pointer(id)?;
                self.builder
                    .ins()
                    .store(MemFlagsData::trusted(), vtable, dest, 0);
                self.class_field_types(id)?
            }
            _ => internal_error!("an owning aggregate that is neither a struct nor an array"),
        };

        for (index, field_ty) in fields.iter().enumerate() {
            let at = *layout.fields.get(index).ok_or_else(|| {
                InternalError::new(format!("the aggregate being copied has no field {index}"))
            })?;
            let source = self.field_value(src, at, *field_ty)?;
            if matches!(self.layouts.repr(*field_ty)?, Repr::Aggregate) {
                let into = self.builder.ins().iadd_imm_s(dest, i64::from(at));
                self.copy_aggregate(into, source, *field_ty)?;
            } else {
                let copied = self.copy_of(*field_ty, source)?;
                self.builder
                    .ins()
                    .store(MemFlagsData::trusted(), copied, dest, at as i32);
            }
        }
        Ok(())
    }

    /// Call a runtime function, declaring it on first use.
    fn call_runtime(&mut self, which: RuntimeFn, args: &[Value]) -> Result<Option<Value>> {
        let id = self
            .context
            .runtime
            .get(self.clif_module, self.target, which)?;
        let func_ref = self.clif_module.declare_func_in_func(id, self.builder.func);
        let call = self.builder.ins().call(func_ref, args);
        Ok(self.builder.inst_results(call).first().copied())
    }

    // -- places -------------------------------------------------------------

    /// The type of a place, walked down its projection path.
    fn place_type(&self, place: &Place) -> Result<TyId> {
        let mut ty = *self.local_types.get(place.local.index()).ok_or_else(|| {
            InternalError::new(format!("local _{} is not declared", place.local.0))
        })?;

        for step in &place.projection {
            let kind = &self
                .module
                .ty(ty)
                .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))?
                .kind;
            ty = match (step, kind) {
                (Projection::Deref, TyKind::Pointer(inner) | TyKind::Reference(inner)) => *inner,
                (
                    Projection::Index(_) | Projection::ConstIndex(_),
                    TyKind::FixedArray { element: inner, .. }
                    | TyKind::Array(inner)
                    | TyKind::Pointer(inner)
                    | TyKind::Reference(inner),
                ) => *inner,
                (Projection::Field(field), TyKind::Struct(id)) => self
                    .module
                    .strukt(*id)
                    .and_then(|def| def.field(*field))
                    .map(|def| def.ty)
                    .ok_or_else(|| {
                        InternalError::new(format!("field {} is not on struct {}", field.0, id.0))
                    })?,
                // A class's field list is flattened, base classes' first, so a
                // field id means the same thing whatever the static type is and
                // no base chain is walked here.
                (Projection::Field(field), TyKind::Class(id)) => self
                    .module
                    .class(*id)
                    .and_then(|def| def.field(*field))
                    .map(|def| def.ty)
                    .ok_or_else(|| {
                        InternalError::new(format!("field {} is not on class {}", field.0, id.0))
                    })?,
                _ => {
                    return Err(InternalError::new(
                        "a projection does not match the type it is applied to",
                    ));
                }
            };
        }
        Ok(ty)
    }

    fn category(&self, ty: TyId) -> Result<Category> {
        self.module
            .ty(ty)
            .map(|def| def.category)
            .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))
    }

    fn write_place(&mut self, place: &Place, value: Option<Value>) -> Result<()> {
        self.write_place_with(place, value, false)
    }

    /// Store into a place, knowing whether ownership is being *transferred*.
    ///
    /// The distinction only shows up for an owning aggregate, and it is the
    /// whole difference between correct and a leak. A **copy** clones every
    /// owning field, because both the source and the destination will be
    /// destroyed. A **move** takes the bytes as they are, because the source
    /// has been made dead and will not be.
    fn write_place_with(
        &mut self,
        place: &Place,
        value: Option<Value>,
        moving: bool,
    ) -> Result<()> {
        let Some(value) = value else { return Ok(()) };
        let ty = self.place_type(place)?;

        // An aggregate arrives as an address, so storing it is a byte copy —
        // and the *whole* copy, because nested aggregates are inline and there
        // is nothing behind a pointer to chase.
        if matches!(self.layouts.repr(ty)?, Repr::Aggregate) {
            let (address, offset) = self.place_address(place)?;
            let dest = if offset == 0 {
                address
            } else {
                self.builder.ins().iadd_imm_s(address, i64::from(offset))
            };
            if moving {
                let layout = self.layouts.layout(ty)?;
                self.copy_bytes(dest, value, layout.size, layout.align);
            } else {
                self.copy_aggregate(dest, value, ty)?;
            }
            return Ok(());
        }

        if place.projection.is_empty() {
            return self.store_local(place.local, value);
        }
        let (address, offset) = self.place_address(place)?;
        self.builder
            .ins()
            .store(MemFlagsData::trusted(), value, address, offset as i32);
        Ok(())
    }

    /// Read the bytes at a place, with **no** copy operation applied.
    ///
    /// Everything that needs the type's copy semantics goes through
    /// {@link copy_of}; this is the raw load underneath it.
    fn read_raw(&mut self, place: &Place) -> Result<Value> {
        let ty = self.place_type(place)?;
        // An aggregate does not fit in a register, so its "value" *is* its
        // address. Everything that consumes one — a copy, a call argument, a
        // store — works from the address, and nothing ever tries to hold a
        // struct in a `Value`.
        if matches!(self.layouts.repr(ty)?, Repr::Aggregate) {
            let (address, offset) = self.place_address(place)?;
            return Ok(if offset == 0 {
                address
            } else {
                self.builder.ins().iadd_imm_s(address, i64::from(offset))
            });
        }

        if place.projection.is_empty() {
            return match self.slot(place.local)? {
                LocalSlot::Register(var) => Ok(self.builder.use_var(var)),
                LocalSlot::Memory { slot, ty } => {
                    let Repr::Register(clif) = self.layouts.repr(ty)? else {
                        internal_error!("an aggregate reached the scalar load path");
                    };
                    let pointer = self.target.pointer_type();
                    Ok(self.builder.ins().stack_load(pointer, clif, slot, 0))
                }
                LocalSlot::Indirect(_) => {
                    internal_error!("an aggregate reached the scalar load path")
                }
                LocalSlot::Empty => internal_error!("reading a `void` local"),
            };
        }

        let (address, offset) = self.place_address(place)?;
        let Repr::Register(clif) = self.layouts.repr(ty)? else {
            internal_error!("an aggregate reached the scalar load path");
        };
        Ok(self
            .builder
            .ins()
            .load(clif, MemFlagsData::trusted(), address, offset as i32))
    }

    /// The address a place denotes, plus a constant byte offset into it.
    ///
    /// The offset is kept separate so that a chain of field accesses folds into
    /// the load's displacement rather than into a chain of adds. Only an
    /// `Index` with a computed subscript needs real arithmetic.
    fn place_address(&mut self, place: &Place) -> Result<(Value, u32)> {
        let pointer = self.target.pointer_type();
        let mut ty = *self.local_types.get(place.local.index()).ok_or_else(|| {
            InternalError::new(format!("local _{} is not declared", place.local.0))
        })?;

        let mut address = match self.slot(place.local)? {
            LocalSlot::Memory { slot, .. } => self.builder.ins().stack_addr(pointer, slot, 0),
            // Already an address: an aggregate parameter.
            LocalSlot::Indirect(var) => self.builder.use_var(var),
            // A register local has no address. Reaching one here means the
            // "does this local need memory" analysis and the projection
            // disagree, which is a compiler bug rather than a program's.
            LocalSlot::Register(_) => {
                internal_error!(
                    "_{} is projected into but lives in a register",
                    place.local.0
                )
            }
            LocalSlot::Empty => internal_error!("_{} has no storage", place.local.0),
        };
        let mut offset = 0u32;

        for step in &place.projection {
            let kind = self
                .module
                .ty(ty)
                .map(|def| def.kind.clone())
                .ok_or_else(|| InternalError::new(format!("type {} is missing", ty.0)))?;

            match (step, &kind) {
                (Projection::Deref, TyKind::Pointer(inner) | TyKind::Reference(inner)) => {
                    // Through a pointer: load it, and start again from there.
                    // Nothing is retyped — v1 relabelled a pointer as its
                    // pointee so field offsets would resolve, and the
                    // destructor pass then freed storage the pointer was only
                    // borrowing (REWRITE-PLAN §10).
                    address = self.builder.ins().load(
                        pointer,
                        MemFlagsData::trusted(),
                        address,
                        offset as i32,
                    );
                    offset = 0;
                    ty = *inner;
                }
                (Projection::Field(field), TyKind::Struct(id)) => {
                    let layout = self.layouts.layout(ty)?;
                    let at = *layout.fields.get(field.index()).ok_or_else(|| {
                        InternalError::new(format!("struct {} has no field {}", id.0, field.0))
                    })?;
                    offset += at;
                    ty = self
                        .module
                        .strukt(*id)
                        .and_then(|def| def.field(*field))
                        .map(|def| def.ty)
                        .ok_or_else(|| {
                            InternalError::new(format!("field {} is missing", field.0))
                        })?;
                }
                // The same walk, on a class. The layout already accounts for
                // the vtable pointer at offset 0, so a field index means the
                // same thing here as it does in `place_type`.
                (Projection::Field(field), TyKind::Class(id)) => {
                    let layout = self.layouts.layout(ty)?;
                    let at = *layout.fields.get(field.index()).ok_or_else(|| {
                        InternalError::new(format!("class {} has no field {}", id.0, field.0))
                    })?;
                    offset += at;
                    ty = self
                        .module
                        .class(*id)
                        .and_then(|def| def.field(*field))
                        .map(|def| def.ty)
                        .ok_or_else(|| {
                            InternalError::new(format!("field {} is missing", field.0))
                        })?;
                }
                (
                    Projection::ConstIndex(index),
                    TyKind::FixedArray { element, .. } | TyKind::Array(element),
                ) => {
                    let stride = self.layouts.layout(*element)?.stride();
                    offset += stride * (*index as u32);
                    ty = *element;
                }
                // `p[i]` is `*(p + i)`, as in C: load the pointer, then scale.
                // A pointer to one `T` and a pointer to the first of many are
                // the same thing here, exactly as they are in C.
                (
                    Projection::Index(_) | Projection::ConstIndex(_),
                    TyKind::Pointer(element) | TyKind::Reference(element),
                ) => {
                    let element = *element;
                    let stride = self.layouts.layout(element)?.stride();
                    let base = self.builder.ins().load(
                        pointer,
                        MemFlagsData::trusted(),
                        address,
                        offset as i32,
                    );
                    address = match step {
                        Projection::ConstIndex(index) => {
                            let at = i64::from(stride) * (*index as i64);
                            self.builder.ins().iadd_imm_s(base, at)
                        }
                        Projection::Index(local) => {
                            let raw = self.read_raw(&Place::local(*local))?;
                            let widened = self.widen_to_pointer(raw)?;
                            let scaled = self.builder.ins().imul_imm_u(widened, i64::from(stride));
                            self.builder.ins().iadd(base, scaled)
                        }
                        _ => unreachable!("matched above"),
                    };
                    offset = 0;
                    ty = element;
                }
                (
                    Projection::Index(local),
                    TyKind::FixedArray { element, .. } | TyKind::Array(element),
                ) => {
                    let stride = self.layouts.layout(*element)?.stride();
                    let raw = self.read_raw(&Place::local(*local))?;
                    let widened = self.widen_to_pointer(raw)?;
                    // Stride, not element *size*: a `{ i32, i8 }` occupies five
                    // bytes and strides by eight, and using the size overlaps
                    // the array with itself (REWRITE-PLAN §10).
                    let scaled = self.builder.ins().imul_imm_u(widened, i64::from(stride));
                    let base = self.builder.ins().iadd_imm_s(address, i64::from(offset));
                    address = self.builder.ins().iadd(base, scaled);
                    offset = 0;
                    ty = *element;
                }
                _ => {
                    return Err(InternalError::new(
                        "a projection does not match the type it is applied to",
                    ));
                }
            }
        }
        Ok((address, offset))
    }

    /// Widen or narrow a value to the target's pointer width, for arithmetic.
    fn widen_to_pointer(&mut self, value: Value) -> Result<Value> {
        let pointer = self.target.pointer_type();
        let have = self.builder.func.dfg.value_type(value);
        Ok(if have == pointer {
            value
        } else if have.bits() < pointer.bits() {
            self.builder.ins().uextend(pointer, value)
        } else {
            self.builder.ins().ireduce(pointer, value)
        })
    }

    /// Copy `size` bytes from one address to another.
    fn copy_bytes(&mut self, dest: Value, src: Value, size: u32, align: u32) {
        if size == 0 {
            return;
        }
        let config = self.frontend_config;
        self.builder.emit_small_memory_copy(
            config,
            dest,
            src,
            u64::from(size),
            align.min(16) as u8,
            align.min(16) as u8,
            /* non_overlapping */ true,
            MemFlagsData::trusted(),
        );
    }

    // -- rvalues ------------------------------------------------------------

    /// Zero a place, whatever shape it is.
    fn default_init(&mut self, place: &Place) -> Result<()> {
        let ty = self.place_type(place)?;
        match self.layouts.repr(ty)? {
            Repr::Void => Ok(()),
            Repr::Register(clif) => {
                let zero = if clif.is_float() {
                    if clif == types::F32 {
                        self.builder.ins().f32const(0.0)
                    } else {
                        self.builder.ins().f64const(0.0)
                    }
                } else {
                    self.builder.ins().iconst(clif, 0)
                };
                self.write_place(place, Some(zero))
            }
            Repr::Aggregate => {
                let layout = self.layouts.layout(ty)?;
                let (address, offset) = self.place_address(place)?;
                let dest = if offset == 0 {
                    address
                } else {
                    self.builder.ins().iadd_imm_s(address, i64::from(offset))
                };
                let config = self.frontend_config;
                self.builder.emit_small_memset(
                    config,
                    dest,
                    0,
                    u64::from(layout.size),
                    layout.align.min(16) as u8,
                    MemFlagsData::trusted(),
                );
                // A class is zeroed like anything else and then gets its vtable
                // pointer, so `default_init` leaves behind an object that is
                // already dispatchable — including through its own destructor,
                // which is what makes a partly-constructed object safe to drop.
                if let Some(TyKind::Class(id)) = self.module.ty(ty).map(|def| &def.kind) {
                    let vtable = self.vtable_pointer(*id)?;
                    self.builder
                        .ins()
                        .store(MemFlagsData::trusted(), vtable, dest, 0);
                }
                Ok(())
            }
        }
    }

    /// Write each field of an aggregate straight into the destination.
    fn build_aggregate(&mut self, place: &Place, ty: TyId, fields: &[Operand]) -> Result<()> {
        let layout = self.layouts.layout(ty)?;
        let (address, base) = self.place_address(place)?;

        for (index, operand) in fields.iter().enumerate() {
            let at = *layout
                .fields
                .get(index)
                .ok_or_else(|| InternalError::new(format!("aggregate has no field {index}")))?;
            let Some(value) = self.operand(operand)? else {
                continue;
            };

            let field_ty = self.operand_type(operand)?;
            let offset = base + at;
            if matches!(self.layouts.repr(field_ty)?, Repr::Aggregate) {
                let dest = self.builder.ins().iadd_imm_s(address, i64::from(offset));
                if matches!(operand, Operand::Move(_)) {
                    let field_layout = self.layouts.layout(field_ty)?;
                    self.copy_bytes(dest, value, field_layout.size, field_layout.align);
                } else {
                    self.copy_aggregate(dest, value, field_ty)?;
                }
            } else {
                self.builder
                    .ins()
                    .store(MemFlagsData::trusted(), value, address, offset as i32);
            }
        }
        Ok(())
    }

    fn rvalue(&mut self, rvalue: &Rvalue) -> Result<Option<Value>> {
        Ok(match rvalue {
            Rvalue::Use(operand) => self.operand(operand)?,
            // Only reachable outside an `Init`, which the frontend does not
            // emit: a default value with nowhere to go is not a value.
            Rvalue::Default => internal_error!("`default` outside an `Init`"),
            // Built into a destination, like an aggregate literal, because the
            // pair is two words that have nowhere to live as a single value.
            Rvalue::MakeInterface { .. } | Rvalue::TryInterface { .. } => {
                internal_error!("a `Reference<I>` conversion outside an `Init`")
            }
            Rvalue::Binary { op, lhs, rhs } => Some(self.binary(*op, lhs, rhs)?),
            Rvalue::Unary { op, operand } => Some(self.unary(*op, operand)?),
            Rvalue::Cast { op, operand, to } => Some(self.cast(*op, operand, *to)?),
            // `Reference<T>` and `Pointer<T>` are both one machine word holding
            // an address, so the two nodes emit the same instruction. They stay
            // separate because they produce different *types*, and a null check
            // under `checked` belongs to one of them and not the other.
            Rvalue::Ref(place) | Rvalue::AddrOf(place) => {
                let (address, offset) = self.place_address(place)?;
                Some(if offset == 0 {
                    address
                } else {
                    self.builder.ins().iadd_imm_s(address, i64::from(offset))
                })
            }
            // Only reachable when an aggregate literal is *not* the rvalue of
            // an `Init` — which the frontend does not emit, because building
            // one anywhere else means building it and then copying it.
            Rvalue::Aggregate { .. } => {
                internal_error!("an aggregate literal outside an `Init`")
            }
            // The class half of `tryCast`, and unlike the interface half this
            // one *is* an ordinary value: a `Reference<C>` is one word, so the
            // result is the object's address or null, with no pair to build.
            Rvalue::TryClass { class, source } => {
                let target = self
                    .context
                    .classes
                    .get(class.index())
                    .ok_or_else(|| {
                        InternalError::new(format!("class {} has no descriptor", class.0))
                    })?
                    .descriptor;

                let (address, offset) = self.place_address(source)?;
                let object = if offset == 0 {
                    address
                } else {
                    self.builder.ins().iadd_imm_s(address, i64::from(offset))
                };

                let pointer = self.target.pointer_type();
                let flags = MemFlagsData::trusted();
                let vtable = self.builder.ins().load(pointer, flags, object, 0);
                let descriptor = self.builder.ins().load(
                    pointer,
                    flags,
                    vtable,
                    -(self.target.pointer_bytes as i32),
                );

                let global = self
                    .clif_module
                    .declare_data_in_func(target, self.builder.func);
                let wanted = self.builder.ins().symbol_value(pointer, global);
                let answer = self
                    .call_runtime(RuntimeFn::IsA, &[descriptor, wanted])?
                    .ok_or_else(|| InternalError::new("`gf_is_a` returned nothing"))?;

                let zero = self.builder.ins().iconst(pointer, 0);
                Some(self.builder.ins().select(answer, object, zero))
            }
            // One load and a compare. The pair's itab word is zero exactly when
            // the cast that produced it failed.
            Rvalue::InterfaceIsNull(place) => {
                let (address, offset) = self.place_address(place)?;
                let pointer = self.target.pointer_type();
                let itab = self.builder.ins().load(
                    pointer,
                    MemFlagsData::trusted(),
                    address,
                    offset as i32,
                );
                let zero = self.builder.ins().iconst(pointer, 0);
                Some(self.builder.ins().icmp(IntCC::Equal, itab, zero))
            }
            Rvalue::Len(place) => {
                let ty = self.place_type(place)?;
                let value = self.read_raw(place)?;
                match self.module.ty(ty).map(|def| &def.kind) {
                    Some(TyKind::Str) => Some(
                        self.call_runtime(RuntimeFn::StringLen, &[value])?
                            .ok_or_else(|| {
                                InternalError::new("`gf_string_len` returned nothing")
                            })?,
                    ),
                    _ => internal_error!("`length` on this type arrives with milestone 6"),
                }
            }
        })
    }

    fn operand(&mut self, operand: &Operand) -> Result<Option<Value>> {
        Ok(match operand {
            // For a trivial type these are the same instruction. They are still
            // two nodes, because for an owning type the difference is an
            // allocation — and the frontend already decided which one this is.
            Operand::Copy(place) => {
                let ty = self.place_type(place)?;
                let value = self.read_raw(place)?;
                Some(self.copy_of(ty, value)?)
            }
            Operand::Move(place) => Some(self.move_out(place)?),
            // Ownership stays where it is: no copy operation, and the source
            // is still live and still somebody's to destroy.
            Operand::Borrow(place) => Some(self.read_raw(place)?),
            Operand::Const(constant) => self.constant(constant)?,
        })
    }

    /// Take a value out of a place, leaving the source safe to destroy.
    ///
    /// For an owning type the source is nulled. Drop elaboration already knows
    /// not to destroy a moved-from local, so this is not what prevents the
    /// double free — it is what makes a *read* of a moved-from value produce an
    /// empty string rather than a dangling pointer. Cheap insurance on the one
    /// mistake whose consequence is memory corruption rather than a wrong answer.
    fn move_out(&mut self, place: &Place) -> Result<Value> {
        let ty = self.place_type(place)?;
        let value = self.read_raw(place)?;
        // Only a one-word handle can be poisoned. An aggregate's "value" is its
        // address, and there is no single word to null — writing one would
        // memcpy from address zero. Drop elaboration is what stops a moved-from
        // aggregate being destroyed; this is only the extra insurance for the
        // handle case, where a missed use-after-move would otherwise read freed
        // memory rather than an empty value.
        if self.category(ty)?.needs_drop() && matches!(self.layouts.repr(ty)?, Repr::Register(_)) {
            let pointer = self.target.pointer_type();
            let null = self.builder.ins().iconst(pointer, 0);
            self.write_place(place, Some(null))?;
        }
        Ok(value)
    }

    fn constant(&mut self, constant: &Const) -> Result<Option<Value>> {
        Ok(match constant {
            Const::Unit => None,
            Const::Bool { value, .. } => {
                Some(self.builder.ins().iconst(types::I8, i64::from(*value)))
            }
            Const::Int { bits, ty } => {
                let Repr::Register(clif) = self.layouts.repr(*ty)? else {
                    internal_error!("an integer constant with a non-register type");
                };
                // The frontend has already folded any sign into the bit
                // pattern and range-checked the result, so this is a
                // reinterpretation and never a conversion.
                Some(self.builder.ins().iconst(clif, *bits as i64))
            }
            Const::Float { bits, ty } => {
                let float = match self.module.ty(*ty).map(|d| &d.kind) {
                    Some(TyKind::Float(FloatTy::F32)) => FloatTy::F32,
                    Some(TyKind::Float(FloatTy::F64)) => FloatTy::F64,
                    _ => internal_error!("a float constant whose type is not a float"),
                };
                Some(match float {
                    FloatTy::F32 => {
                        let value = f32::from_bits(*bits as u32);
                        self.builder.ins().f32const(value)
                    }
                    FloatTy::F64 => {
                        let value = f64::from_bits(*bits);
                        self.builder.ins().f64const(value)
                    }
                })
            }
            Const::Null(_) => {
                let pointer = self.target.pointer_type();
                Some(self.builder.ins().iconst(pointer, 0))
            }
            Const::Str { text: sym, .. } => {
                let text = self
                    .module
                    .sym(*sym)
                    .ok_or_else(|| InternalError::new("a string literal has no text"))?
                    .to_owned();
                Some(self.string_literal(&text)?)
            }
            Const::Func(_) => internal_error!("function pointers arrive with milestone 6"),
        })
    }

    /// A string literal, as static data plus the offset past its header.
    ///
    /// The data is laid out exactly as the runtime expects, with `owned = 0`,
    /// so freeing a literal is a no-op the *runtime* decides. Nothing at the
    /// use site has to know it got a literal rather than a heap string, which
    /// is what keeps "the binding's scope releases it" a rule without
    /// exceptions.
    fn string_literal(&mut self, text: &str) -> Result<Value> {
        let data_id = match self.context.literals.get(text) {
            Some(id) => *id,
            None => {
                let symbol = format!("gf_str_{:016x}", fnv1a(text.as_bytes()));
                let id = self
                    .clif_module
                    .declare_data(&symbol, cranelift_module::Linkage::Local, false, false)
                    .map_err(|error| {
                        InternalError::new(format!("declaring `{symbol}`: {error}"))
                    })?;
                let mut description = cranelift_module::DataDescription::new();
                description.define(crate::runtime::literal_data(text).into_boxed_slice());
                self.clif_module
                    .define_data(id, &description)
                    .map_err(|error| InternalError::new(format!("defining `{symbol}`: {error}")))?;
                self.context.literals.insert(text.to_owned(), id);
                id
            }
        };

        let global = self
            .clif_module
            .declare_data_in_func(data_id, self.builder.func);
        let pointer = self.target.pointer_type();
        let base = self.builder.ins().symbol_value(pointer, global);
        Ok(self.builder.ins().iadd_imm_s(base, STRING_HEADER_BYTES))
    }

    fn binary(&mut self, op: BinOp, lhs: &Operand, rhs: &Operand) -> Result<Value> {
        let left = self
            .operand(lhs)?
            .ok_or_else(|| InternalError::new("a binary operand produced no value"))?;
        let right = self
            .operand(rhs)?
            .ok_or_else(|| InternalError::new("a binary operand produced no value"))?;

        let ty = self.operand_type(lhs)?;

        // `string` is not a machine scalar: its operators are runtime calls.
        if matches!(self.module.ty(ty).map(|def| &def.kind), Some(TyKind::Str)) {
            return self.string_binary(op, left, right);
        }

        let kind = self.numeric_kind(ty)?;

        Ok(match (op, kind) {
            (BinOp::Add, Numeric::Float) => self.builder.ins().fadd(left, right),
            (BinOp::Sub, Numeric::Float) => self.builder.ins().fsub(left, right),
            (BinOp::Mul, Numeric::Float) => self.builder.ins().fmul(left, right),
            (BinOp::Div, Numeric::Float) => self.builder.ins().fdiv(left, right),
            (BinOp::Add, _) => self.builder.ins().iadd(left, right),
            (BinOp::Sub, _) => self.builder.ins().isub(left, right),
            (BinOp::Mul, _) => self.builder.ins().imul(left, right),
            (BinOp::Div, Numeric::Signed) => self.builder.ins().sdiv(left, right),
            (BinOp::Div, Numeric::Unsigned) => self.builder.ins().udiv(left, right),
            (BinOp::Rem, Numeric::Signed) => self.builder.ins().srem(left, right),
            (BinOp::Rem, Numeric::Unsigned) => self.builder.ins().urem(left, right),
            // `someF64 % 2` is the exact expression that reached Cranelift in
            // v1 and came back as `Rem is not defined on f64`. The width pass
            // rejects it now; if one ever gets here, this is a compiler bug and
            // says so rather than producing a backend error with no line number.
            (BinOp::Rem, Numeric::Float) => {
                internal_error!("`%` on a float should have been rejected by the width pass")
            }
            (BinOp::BitAnd, _) => self.builder.ins().band(left, right),
            (BinOp::BitOr, _) => self.builder.ins().bor(left, right),
            (BinOp::BitXor, _) => self.builder.ins().bxor(left, right),
            (BinOp::Shl, _) => self.builder.ins().ishl(left, right),
            (BinOp::Shr, Numeric::Signed) => self.builder.ins().sshr(left, right),
            (BinOp::Shr, _) => self.builder.ins().ushr(left, right),
            (comparison, Numeric::Float) => {
                let cc = match comparison {
                    BinOp::Eq => FloatCC::Equal,
                    BinOp::Ne => FloatCC::NotEqual,
                    BinOp::Lt => FloatCC::LessThan,
                    BinOp::Le => FloatCC::LessThanOrEqual,
                    BinOp::Gt => FloatCC::GreaterThan,
                    BinOp::Ge => FloatCC::GreaterThanOrEqual,
                    _ => internal_error!("unhandled float operator"),
                };
                self.builder.ins().fcmp(cc, left, right)
            }
            (comparison, numeric) => {
                let signed = numeric == Numeric::Signed;
                let cc = match comparison {
                    BinOp::Eq => IntCC::Equal,
                    BinOp::Ne => IntCC::NotEqual,
                    BinOp::Lt if signed => IntCC::SignedLessThan,
                    BinOp::Lt => IntCC::UnsignedLessThan,
                    BinOp::Le if signed => IntCC::SignedLessThanOrEqual,
                    BinOp::Le => IntCC::UnsignedLessThanOrEqual,
                    BinOp::Gt if signed => IntCC::SignedGreaterThan,
                    BinOp::Gt => IntCC::UnsignedGreaterThan,
                    BinOp::Ge if signed => IntCC::SignedGreaterThanOrEqual,
                    BinOp::Ge => IntCC::UnsignedGreaterThanOrEqual,
                    _ => internal_error!("unhandled integer operator"),
                };
                self.builder.ins().icmp(cc, left, right)
            }
        })
    }

    fn string_binary(&mut self, op: BinOp, left: Value, right: Value) -> Result<Value> {
        match op {
            BinOp::Add => self
                .call_runtime(RuntimeFn::StringConcat, &[left, right])?
                .ok_or_else(|| InternalError::new("`gf_string_concat` returned nothing")),
            BinOp::Eq => self
                .call_runtime(RuntimeFn::StringEq, &[left, right])?
                .ok_or_else(|| InternalError::new("`gf_string_eq` returned nothing")),
            BinOp::Ne => {
                let equal = self
                    .call_runtime(RuntimeFn::StringEq, &[left, right])?
                    .ok_or_else(|| InternalError::new("`gf_string_eq` returned nothing"))?;
                Ok(self.builder.ins().bxor_imm_u(equal, 1))
            }
            _ => internal_error!("`{op:?}` is not defined on `string`"),
        }
    }

    fn unary(&mut self, op: UnOp, operand: &Operand) -> Result<Value> {
        let value = self
            .operand(operand)?
            .ok_or_else(|| InternalError::new("a unary operand produced no value"))?;
        let ty = self.operand_type(operand)?;

        Ok(match op {
            UnOp::Neg => match self.numeric_kind(ty)? {
                Numeric::Float => self.builder.ins().fneg(value),
                Numeric::Signed => self.builder.ins().ineg(value),
                // `-x` on an unsigned type has no meaningful result, and
                // allowing it walks `-1` past the range check as a `u8`.
                Numeric::Unsigned => {
                    internal_error!("unary minus on an unsigned type should have been rejected")
                }
            },
            UnOp::BitNot => self.builder.ins().bnot(value),
            // There is no truthiness, so the operand is always a `bool`, which
            // is one byte holding 0 or 1.
            UnOp::Not => self.builder.ins().bxor_imm_u(value, 1),
        })
    }

    fn cast(&mut self, op: CastKind, operand: &Operand, to: TyId) -> Result<Value> {
        let value = self
            .operand(operand)?
            .ok_or_else(|| InternalError::new("a cast operand produced no value"))?;
        let from_ty = self.operand_type(operand)?;
        let Repr::Register(target) = self.layouts.repr(to)? else {
            internal_error!("casting to a non-register type");
        };
        let source = self.builder.func.dfg.value_type(value);

        Ok(match op {
            CastKind::IntToInt => {
                if target.bits() == source.bits() {
                    value
                } else if target.bits() < source.bits() {
                    self.builder.ins().ireduce(target, value)
                } else if signedness(self.layouts, from_ty).unwrap_or(false) {
                    self.builder.ins().sextend(target, value)
                } else {
                    self.builder.ins().uextend(target, value)
                }
            }
            CastKind::BoolToInt => {
                if target.bits() > 8 {
                    self.builder.ins().uextend(target, value)
                } else {
                    value
                }
            }
            CastKind::IntToFloat => {
                if signedness(self.layouts, from_ty).unwrap_or(false) {
                    self.builder.ins().fcvt_from_sint(target, value)
                } else {
                    self.builder.ins().fcvt_from_uint(target, value)
                }
            }
            // Saturating, so that an out-of-range float becomes the nearest
            // representable integer rather than a trap or a poison value.
            CastKind::FloatToInt => {
                if signedness(self.layouts, to).unwrap_or(false) {
                    self.builder.ins().fcvt_to_sint_sat(target, value)
                } else {
                    self.builder.ins().fcvt_to_uint_sat(target, value)
                }
            }
            CastKind::FloatToFloat => {
                if target.bits() > source.bits() {
                    self.builder.ins().fpromote(target, value)
                } else if target.bits() < source.bits() {
                    self.builder.ins().fdemote(target, value)
                } else {
                    value
                }
            }
            CastKind::PtrToPtr => value,
            CastKind::PtrToInt | CastKind::IntToPtr => {
                if target.bits() == source.bits() {
                    value
                } else if target.bits() < source.bits() {
                    self.builder.ins().ireduce(target, value)
                } else {
                    self.builder.ins().uextend(target, value)
                }
            }
        })
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
                | Const::Str { ty, .. } => Ok(*ty),
                // `Unit` is the only constant with no type, because there is no
                // type for it to have.
                Const::Unit | Const::Func(_) => {
                    internal_error!("this constant has no recorded type")
                }
            },
        }
    }

    fn numeric_kind(&self, ty: TyId) -> Result<Numeric> {
        match self.module.ty(ty).map(|def| &def.kind) {
            Some(TyKind::Int(int)) => Ok(if int.is_signed() {
                Numeric::Signed
            } else {
                Numeric::Unsigned
            }),
            Some(TyKind::Float(_)) => Ok(Numeric::Float),
            Some(TyKind::Bool) => Ok(Numeric::Unsigned),
            Some(TyKind::Pointer(_) | TyKind::Reference(_)) => Ok(Numeric::Unsigned),
            _ => internal_error!("a non-numeric type reached an arithmetic operator"),
        }
    }

    // -- terminators --------------------------------------------------------

    fn terminator(&mut self, terminator: &Terminator, func: &Function) -> Result<()> {
        match terminator {
            Terminator::Goto(target) => {
                let block = self.block(*target)?;
                self.builder.ins().jump(block, &[]);
            }
            Terminator::Branch {
                cond,
                then_block,
                else_block,
            } => {
                let value = self
                    .operand(cond)?
                    .ok_or_else(|| InternalError::new("a branch condition produced no value"))?;
                let then_b = self.block(*then_block)?;
                let else_b = self.block(*else_block)?;
                self.builder.ins().brif(value, then_b, &[], else_b, &[]);
            }
            Terminator::Switch {
                discr,
                targets,
                default,
            } => {
                let value = self
                    .operand(discr)?
                    .ok_or_else(|| InternalError::new("a switch discriminant produced no value"))?;
                let mut switch = Switch::new();
                for target in targets {
                    switch.set_entry(u128::from(target.value), self.block(target.block)?);
                }
                let default_block = self.block(*default)?;
                switch.emit(&mut self.builder, value, default_block);
            }
            Terminator::Call {
                callee,
                args,
                destination,
                unwind,
            } => {
                self.call(callee, args, destination.as_ref(), *unwind)?;
            }
            Terminator::Return => {
                // At the boundary a small struct goes back in registers, so it
                // is taken apart rather than copied through a pointer nobody
                // passed.
                if let Some(AbiSlot::Registers {
                    carriers,
                    size,
                    align,
                }) = self.shape_of(func.sig)?.map(|shape| shape.returns)
                    && !carriers.is_empty()
                    && self.returns_aggregate(func)?
                {
                    let source = self.read_raw(&Place::local(LocalId::RETURN))?;
                    let values = self.gather_carriers(source, &carriers, size, align)?;
                    self.builder.ins().return_(&values);
                    return Ok(());
                }

                let sig = self.module.sig(func.sig).ok_or_else(|| {
                    InternalError::new(format!("signature {} is missing", func.sig.0))
                })?;
                match self.layouts.repr(sig.ret)? {
                    Repr::Void => {
                        self.builder.ins().return_(&[]);
                    }
                    Repr::Register(_) => {
                        // Returning hands the value to the caller. That is a
                        // move, not a copy — cloning here would leak the
                        // original at every single return.
                        let value = self.read_raw(&Place::local(LocalId::RETURN))?;
                        self.builder.ins().return_(&[value]);
                    }
                    Repr::Aggregate => {
                        // The callee constructs into storage the caller
                        // designated — the same mechanism as the C ABI's hidden
                        // return pointer, because it must be one mechanism and
                        // not two (REWRITE-PLAN §4.5).
                        let layout = self.layouts.layout(sig.ret)?;
                        let source = self.read_raw(&Place::local(LocalId::RETURN))?;
                        let dest = self
                            .sret
                            .ok_or_else(|| InternalError::new("no struct-return pointer"))?;
                        self.copy_bytes(dest, source, layout.size, layout.align);
                        self.builder.ins().return_(&[]);
                    }
                }
            }
            Terminator::Unreachable => {
                self.builder.ins().trap(TrapCode::unwrap_user(2));
            }
            Terminator::Resume => {
                internal_error!("unwinding has no lowering until there is a `throw`");
            }
            Terminator::Abort(reason) => {
                let code = match reason {
                    AbortReason::BoundsCheck => 10,
                    AbortReason::DivideByZero => 11,
                    AbortReason::NullDeref => 12,
                    AbortReason::UnwindAcrossBoundary => 13,
                };
                self.builder.ins().trap(TrapCode::unwrap_user(code));
            }
        }
        Ok(())
    }

    /// Where a call goes: a symbol the linker resolves, or an address computed
    /// at run time.
    fn call(
        &mut self,
        callee: &Callee,
        args: &[Operand],
        destination: Option<&goblin_mir::CallDest>,
        unwind: UnwindAction,
    ) -> Result<()> {
        if let UnwindAction::Cleanup(_) = unwind {
            internal_error!("a call with a cleanup edge needs an unwinding runtime");
        }

        let callee_sig = match callee {
            Callee::Direct(FuncRef::Local(id)) => self.module.func(*id).map(|f| f.sig),
            Callee::Direct(FuncRef::Extern(id)) => self.module.extern_func(*id).map(|f| f.sig),
            Callee::Indirect { sig, .. }
            | Callee::Virtual { sig, .. }
            | Callee::Interface { sig, .. } => Some(*sig),
        }
        .ok_or_else(|| InternalError::new("a call to a function that is not declared"))?;
        let shape = self.shape_of(callee_sig)?;

        let mut values = Vec::with_capacity(args.len());
        for (index, arg) in args.iter().enumerate() {
            let value = self
                .operand(arg)?
                .ok_or_else(|| InternalError::new("a call argument produced no value"))?;

            // At the boundary the argument is marshalled into whatever the
            // platform says: registers, a stack copy, or the address of one.
            match shape.as_ref().and_then(|shape| shape.params.get(index)) {
                Some(AbiSlot::Registers {
                    carriers,
                    size,
                    align,
                }) => {
                    let carried = self.gather_carriers(value, carriers, *size, *align)?;
                    values.extend(carried);
                }
                // "Pointing at a copy the caller made" — the caller is us, and
                // the copy is what stops the callee writing through to our value.
                Some(AbiSlot::ByAddress { size, align }) => {
                    values.push(self.copy_to_stack(value, *size, *align)?);
                }
                // Cranelift performs the copy for a `StructArgument`.
                Some(AbiSlot::OnStack { .. }) => values.push(value),
                _ => values.push(value),
            }
        }

        let target =
            match callee {
                Callee::Direct(FuncRef::Local(id)) => {
                    CallTarget::Direct(*self.context.func_refs.defined.get(id.index()).ok_or_else(
                        || InternalError::new(format!("function {} is missing", id.0)),
                    )?)
                }
                Callee::Direct(FuncRef::Extern(id)) => CallTarget::Direct(
                    *self
                        .context
                        .func_refs
                        .imported
                        .get(id.index())
                        .ok_or_else(|| InternalError::new(format!("extern {} is missing", id.0)))?,
                ),
                Callee::Indirect { .. } => {
                    internal_error!("calling through a `FnPtr` value is not implemented yet")
                }
                // Two loads and an indirect call. The receiver is `args[0]` — read
                // once, used both as the `this` argument and as the source of the
                // vtable pointer, so the two cannot disagree.
                Callee::Virtual { slot, .. } => {
                    let receiver = *values.first().ok_or_else(|| {
                        InternalError::new("a virtual call with no receiver in `args[0]`")
                    })?;
                    let pointer = self.layouts.target().pointer_type();
                    let flags = MemFlagsData::trusted();
                    let vtable = self.builder.ins().load(pointer, flags, receiver, 0);
                    let offset = i32::try_from(slot * self.layouts.target().pointer_bytes)
                        .map_err(|_| InternalError::new("a vtable slot past the end of memory"))?;
                    CallTarget::Indirect(self.builder.ins().load(pointer, flags, vtable, offset))
                }
                // `args[0]` is the address of the `(itab, data)` pair. Both halves
                // come out of that one operand, and `data` **replaces** it as the
                // receiver — the callee is an ordinary method expecting an object
                // address, and knows nothing about interfaces.
                Callee::Interface { slot, .. } => {
                    let pair = *values.first().ok_or_else(|| {
                        InternalError::new("an interface call with no receiver in `args[0]`")
                    })?;
                    let pointer = self.layouts.target().pointer_type();
                    let pointer_bytes = self.layouts.target().pointer_bytes;
                    let flags = MemFlagsData::trusted();
                    let itab = self.builder.ins().load(pointer, flags, pair, 0);
                    let data = self
                        .builder
                        .ins()
                        .load(pointer, flags, pair, pointer_bytes as i32);
                    values[0] = data;
                    let offset = i32::try_from(slot * pointer_bytes)
                        .map_err(|_| InternalError::new("an itab slot past the end of memory"))?;
                    CallTarget::Indirect(self.builder.ins().load(pointer, flags, itab, offset))
                }
            };

        // An aggregate result is written straight into the destination place,
        // so the caller hands over its address rather than receiving a copy.
        let returns_in_registers = matches!(
            shape.as_ref().map(|shape| &shape.returns),
            Some(AbiSlot::Registers { .. })
        );
        if let Some(dest) = destination {
            let ty = self.place_type(&dest.place)?;
            if matches!(self.layouts.repr(ty)?, Repr::Aggregate) && !returns_in_registers {
                let address = self.read_raw(&dest.place)?;
                values.insert(0, address);
            }
        }

        let call = match target {
            CallTarget::Direct(id) => {
                let func_ref = self.clif_module.declare_func_in_func(id, self.builder.func);
                self.builder.ins().call(func_ref, &values)
            }
            CallTarget::Indirect(address) => {
                let signature =
                    self.module.sig(callee_sig).cloned().ok_or_else(|| {
                        InternalError::new("a call to a signature that is missing")
                    })?;
                let clif_sig = translate_signature(self.layouts, &signature, self.call_conv)?;
                let sig_ref = self.builder.import_signature(clif_sig);
                self.builder.ins().call_indirect(sig_ref, address, &values)
            }
        };
        let results = self.builder.inst_results(call).to_vec();

        match destination {
            Some(dest) => {
                // A small struct comes back *in registers* under both
                // conventions, so it has to be reassembled rather than stored.
                if let (true, Some(AbiSlot::Registers { size, align, .. })) = (
                    returns_in_registers,
                    shape.as_ref().map(|shape| &shape.returns),
                ) {
                    let address = self.read_raw(&dest.place)?;
                    self.scatter_carriers(address, &results, *size, *align)?;
                } else if let Some(value) = results.first().copied() {
                    // Nothing to store when the callee already wrote into the
                    // destination through the pointer it was handed.
                    self.write_place(&dest.place, Some(value))?;
                }
                let target = self.block(dest.target)?;
                self.builder.ins().jump(target, &[]);
            }
            None => {
                self.builder.ins().trap(TrapCode::unwrap_user(3));
            }
        }
        Ok(())
    }

    fn block(&self, id: BlockId) -> Result<ClifBlock> {
        self.blocks
            .get(id.index())
            .copied()
            .ok_or_else(|| InternalError::new(format!("block bb{} is missing", id.0)))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Numeric {
    Signed,
    Unsigned,
    Float,
}

/// Locals that need an address rather than a register.
/// Places an rvalue holds **directly**, rather than inside an operand.
///
/// Easy to forget, and forgetting it is a compiler crash rather than a wrong
/// answer: `addressed_locals` decides which locals get a stack slot, and a
/// local that is projected into but was never noted lives in a register with no
/// address for the projection to start from.
///
/// Kept beside [`rvalue_operands`] so that adding an rvalue with a `Place` in
/// it means looking at two lists in the same place.
fn rvalue_places(rvalue: &Rvalue) -> Vec<&Place> {
    match rvalue {
        Rvalue::Len(place)
        | Rvalue::MakeInterface { source: place, .. }
        | Rvalue::TryInterface { source: place, .. }
        | Rvalue::TryClass { source: place, .. }
        | Rvalue::InterfaceIsNull(place) => vec![place],
        // `Ref` and `AddrOf` are handled by the caller, which inserts them
        // unconditionally — taking the address of a bare local needs a slot
        // even though there is no projection to notice.
        _ => Vec::new(),
    }
}

fn addressed_locals(func: &Function) -> std::collections::HashSet<LocalId> {
    let mut set = std::collections::HashSet::new();
    fn note(set: &mut std::collections::HashSet<LocalId>, place: &Place) {
        if !place.projection.is_empty() {
            set.insert(place.local);
        }
    }

    for block in &func.blocks {
        for statement in &block.statements {
            match statement {
                Statement::Init { place, rvalue } | Statement::Assign { place, rvalue } => {
                    note(&mut set, place);
                    match rvalue {
                        Rvalue::Ref(inner) | Rvalue::AddrOf(inner) => {
                            set.insert(inner.local);
                        }
                        _ => {}
                    }
                    for operand in rvalue_operands(rvalue) {
                        if let Operand::Copy(p) | Operand::Move(p) | Operand::Borrow(p) = operand {
                            note(&mut set, p);
                        }
                    }
                    for inner in rvalue_places(rvalue) {
                        note(&mut set, inner);
                    }
                }
                Statement::Drop { place, .. } => note(&mut set, place),
                _ => {}
            }
        }
        if let Terminator::Call {
            destination: Some(dest),
            ..
        } = &block.terminator
        {
            note(&mut set, &dest.place);
        }
    }
    set
}

fn rvalue_operands(rvalue: &Rvalue) -> Vec<&Operand> {
    match rvalue {
        Rvalue::Use(operand) | Rvalue::Unary { operand, .. } => vec![operand],
        Rvalue::Cast { operand, .. } => vec![operand],
        Rvalue::Binary { lhs, rhs, .. } => vec![lhs, rhs],
        Rvalue::Aggregate { fields, .. } => fields.iter().collect(),
        Rvalue::Default
        | Rvalue::Ref(_)
        | Rvalue::AddrOf(_)
        | Rvalue::Len(_)
        // `source` is a place, not an operand: building a `Reference<I>` takes
        // the object's *address* and never reads it.
        | Rvalue::MakeInterface { .. }
        | Rvalue::TryInterface { .. }
        | Rvalue::InterfaceIsNull(_)
        | Rvalue::TryClass { .. } => Vec::new(),
    }
}

/// A stable hash, for naming a literal's data symbol.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Whether an rvalue transfers ownership rather than duplicating it.
fn is_move(rvalue: &Rvalue) -> bool {
    matches!(rvalue, Rvalue::Use(Operand::Move(_)))
}
