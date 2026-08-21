//! Copying and destroying, and the arrays that need both.
//!
//! REWRITE-PLAN §4.3's four operations, as code. This is the file the whole
//! design is *for*: ownership is written down by the frontend and obeyed here,
//! and the one rule it enforces above every other is that **the operation comes
//! from the type**, never from how the value was built or from what would be
//! fastest.
//!
//! `memcpy` is the right copy for a struct of `i32` and a double free for one
//! holding a `string`. That is REWRITE-PLAN §10's example and it is why nothing
//! in here has a default case that guesses: [`Emitter::copy_of`] dispatches on
//! `TyKind`, [`Emitter::copy_aggregate`] recurses field by field, and a type
//! with no operation written for it reaches `internal_error!` rather than a
//! byte copy.
//!
//! Two rules that look like details and are not:
//!
//! * **Copying a class slices.** The destination takes the *static* type's
//!   vtable and the *static* type's fields, so assigning a `Derived` to a
//!   `Base` keeps a `Base`. Writing the vtable pointer explicitly, rather than
//!   letting a byte copy carry offset 0 across, is the whole of that rule.
//! * **Destruction is construction backwards.** Fields are destroyed in reverse
//!   declaration order and array elements from the end.

use goblin_mir::{ClassId, FuncId, Operand, TyId, TyKind};

use crate::error::{InternalError, Result};
use crate::internal_error;
use crate::llvm::func::{Emitter, Val};
use crate::llvm::sig;
use crate::llvm::ty::ident;
use crate::runtime::RuntimeFn;

impl Emitter<'_, '_> {
    // -- copy ----------------------------------------------------------------

    /// The copy operation for a value of `ty`.
    ///
    /// REWRITE-PLAN §4.3's `copy`. A trivial type is its bits; a `string` is
    /// cloned; a `T[]` is deep-copied. An aggregate hands back its address and
    /// lets [`Emitter::copy_aggregate`] do the field-wise work, because a
    /// `memcpy` there would shallow-copy every owning field and double free
    /// every one of them.
    pub(super) fn copy_of(&mut self, ty: TyId, value: Val) -> Result<Val> {
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
    pub(super) fn copy_aggregate(&mut self, dest: &str, source: &str, ty: TyId) -> Result<()> {
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
    pub(super) fn copy_element(&mut self, dest: &str, source: &str, ty: TyId) -> Result<()> {
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

    /// Construct an operand's value into storage that holds nothing yet.
    pub(super) fn write_operand_to(
        &mut self,
        dest: &str,
        operand: &Operand,
        ty: TyId,
    ) -> Result<()> {
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

    // -- destroy -------------------------------------------------------------

    /// Destroy the value at an address.
    pub(super) fn destroy_at(&mut self, ty: TyId, address: &str) -> Result<()> {
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

    pub(super) fn element_of(&self, ty: TyId) -> Result<TyId> {
        match self.module.ty(ty).map(|def| &def.kind) {
            Some(TyKind::Array(element)) => Ok(*element),
            _ => Err(InternalError::new(
                "an array operation on something that is not an array",
            )),
        }
    }

    /// `gf_array_len`, widened to the 64 bits the runtime's counts use.
    pub(super) fn array_len(&mut self, handle: &Val) -> Result<Val> {
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
    pub(super) fn build_array(&mut self, ty: TyId, elements: &[Operand]) -> Result<Val> {
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
}
