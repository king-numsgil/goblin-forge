//! The erased type table.
//!
//! Rust never sees a `ts.Type`. By the time a module reaches the backend every
//! type is a concrete, sized [`TyDef`] in [`crate::Module::types`], and the
//! frontend has already decided what category it belongs to.
//!
//! Note what is *not* here: there is no `size` field. Per REWRITE-PLAN §5.2,
//! "how many bytes does this occupy" (`Layout`) and "what does a register hold"
//! (`Repr`) are two different questions with two different answers, and both are
//! computed by the backend from these definitions. One function must never
//! answer both.

use postcard_schema::Schema;
use serde::{Deserialize, Serialize};

use crate::ids::{ClassId, FieldId, FuncId, InterfaceId, SigId, StructId, SymId, TyId};
use crate::span::Span;

/// A signed or unsigned integer width.
///
/// Ten of the twelve widths the language has; [`FloatTy`] is the other two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum IntTy {
    I8,
    I16,
    I32,
    I64,
    U8,
    U16,
    U32,
    U64,
    /// Pointer-sized signed. Its width belongs to the target, which is why it
    /// promotes only to itself (REWRITE-PLAN §7).
    Isize,
    /// Pointer-sized unsigned. Same rule as [`IntTy::Isize`].
    Usize,
}

impl IntTy {
    /// Whether values of this width are sign-extended rather than zero-extended.
    #[inline]
    pub const fn is_signed(self) -> bool {
        matches!(
            self,
            IntTy::I8 | IntTy::I16 | IntTy::I32 | IntTy::I64 | IntTy::Isize
        )
    }

    /// Width in bits, or `None` for the target-dependent widths.
    #[inline]
    pub const fn bits(self) -> Option<u32> {
        match self {
            IntTy::I8 | IntTy::U8 => Some(8),
            IntTy::I16 | IntTy::U16 => Some(16),
            IntTy::I32 | IntTy::U32 => Some(32),
            IntTy::I64 | IntTy::U64 => Some(64),
            IntTy::Isize | IntTy::Usize => None,
        }
    }
}

/// A floating-point width.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum FloatTy {
    F32,
    F64,
}

/// What a type *is*.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum TyKind {
    /// The absence of a value. Only ever the type of a return place that is
    /// never stored into.
    Void,
    Bool,
    Int(IntTy),
    Float(FloatTy),
    /// `Pointer<T>`: an address the program may reseat and dereference.
    /// A borrow; destroying one does nothing.
    Pointer(TyId),
    /// `Reference<T>`: an address bound once, written by the programmer rather
    /// than inferred. A borrow. `this` is one of these (REWRITE-PLAN §4.6).
    Reference(TyId),
    /// A function pointer with a declared signature.
    FnPtr(SigId),
    /// `string`: a one-word owning handle to a heap buffer.
    Str,
    /// `CString`: a raw `const char *`, and nothing else.
    ///
    /// The borrowed half of the pair, and the type the compiler deliberately
    /// does **not** track. No header, no length, no owner — so `length` is a
    /// `strlen` scan rather than a load, and that cost is visible in the type
    /// instead of hidden under `.length` on every string in the language.
    ///
    /// It exists so that a C boundary can say which of the two it means. A
    /// returned [`TyKind::Str`] is always the caller's to release, because
    /// returning an owning value is a move; a returned `CStr` is the case where
    /// the signature has stopped talking and a doc comment has to start.
    CStr,
    /// `T[]`: a one-word owning handle to a heap buffer of *inline* elements.
    /// The element occupies its stride, not a pointer (REWRITE-PLAN §5.2).
    Array(TyId),
    /// `FixedArray<T, N>`: `N` elements, inline, with no allocation at all.
    ///
    /// This is C's `T name[N]`, and the thing worth being precise about is that
    /// it **is** the bytes rather than a pointer to them. A C array decays to a
    /// pointer in most expression contexts, which is where the intuition that
    /// it *is* one comes from — but `sizeof` says otherwise, and as a struct
    /// field it occupies its whole layout inline.
    ///
    /// So its storage class is [`StorageClass::Inline`] wherever it appears:
    /// a local puts it in the frame, a field puts it in the parent, and in
    /// neither case is anything handed to an allocator.
    FixedArray {
        element: TyId,
        length: u64,
    },
    /// A named aggregate. Fields are laid out in declaration order, naturally
    /// aligned, never reordered, and nested aggregates are inline.
    Struct(StructId),
    /// A class instance, by value.
    ///
    /// Laid out as a vtable pointer at offset 0 followed by the fields, base
    /// classes' first, so that an upcast is a no-op and a `Base` prefix is
    /// always a valid `Base` (REWRITE-PLAN §5). Copying one **slices**: it takes
    /// the static type's fields and the static type's vtable, which is why the
    /// category is [`Category::Polymorphic`] and not [`Category::Owning`].
    Class(ClassId),
    /// A reference to a *contract*: the two-word `(itab, data)` pair.
    ///
    /// This is what `Reference<I>` erases to, for an interface carrying at
    /// least one method signature. A contract itself has no value form — it is
    /// C++'s abstract base, which cannot be held by value either — so there is
    /// no separate `TyKind` for one, and the frontend rejects a bare `I` used
    /// as a type. An interface of pure data members is not this at all: it is a
    /// [`TyKind::Struct`], as it has been since milestone 6 (DECISIONS §11.2).
    ///
    /// **It is an aggregate of two handles, not a fat handle**, and the
    /// distinction is what kept this from being invasive. `layout.rs` states
    /// that every *handle* in this language is one machine word, and `Repr` has
    /// no two-register form; adding one would have touched layout, the ABI
    /// classifier and the translator together. Two words at fixed offsets is
    /// something the compiler has handled since milestone 6 — it travels by
    /// address internally, exactly like a struct — so the invariant survives
    /// intact and this type needed no new machinery to move around.
    ///
    /// The cost is that passing one internally copies sixteen bytes rather than
    /// filling two registers. That is a *later* optimisation, and an isolated
    /// one: it changes how the pair travels, not what it is.
    Interface(InterfaceId),
    /// A type declared elsewhere, whose layout this build does not know.
    ///
    /// `declare class FILE { private _opaque: never }` — C's incomplete type,
    /// and the shape every library that hands out a handle uses. It carries a
    /// name and nothing else, because there is nothing else to carry.
    ///
    /// **It has no layout, and asking for one is an [`InternalError`].** That
    /// is the whole reason it is its own variant rather than a zero-field
    /// struct or a `Void` pointee: those have a size of zero and an alignment
    /// of one, so `p[i]` would stride by nothing and `free` would hand the
    /// allocator a size of zero — a corrupt heap rather than a diagnostic.
    /// POINTER-ERASURE.md is the long version of why that matters.
    ///
    /// So it may only ever appear as the pointee of a [`TyKind::Pointer`],
    /// which is one machine word whatever it points at. The frontend refuses
    /// every operation that would need the layout; this variant is what makes
    /// a missed refusal a loud panic instead of a silent wrong answer.
    Opaque(SymId),
}

/// REWRITE-PLAN §4.1: every type has a category, and the category decides copy
/// and destroy for every value of that type.
///
/// The frontend computes this once, from the type, and puts it here. The
/// backend reads it rather than re-deriving anything from expression shape —
/// there is no `ownsAllocation` heuristic anywhere in this design. In debug
/// builds the backend re-derives it structurally and asserts agreement, so the
/// two halves cannot drift apart silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Category {
    /// `memcpy` to copy, nothing to destroy.
    Trivial,
    /// A user-visible copy operation and a user-visible destroy operation.
    Owning,
    /// A class instance: copying slices, destroying is virtual through slot 0.
    Polymorphic,
    /// An address into somebody else's storage. Trivially copied, never
    /// destroyed. That last clause is the entire content of `Reference<T>`.
    Borrow,
}

impl Category {
    /// Whether a value of this category needs a destroy operation at all.
    #[inline]
    pub const fn needs_drop(self) -> bool {
        matches!(self, Category::Owning | Category::Polymorphic)
    }
}

/// REWRITE-PLAN §4.2: every value has a storage class, and the storage class
/// decides *who* destroys it.
///
/// This is the `"owned" | "inline"` string that v1 retrofitted into
/// `releaseValue` and threaded through six call sites by hand. Here it is a
/// static property of a place: declared on a [`crate::LocalDecl`] and derived
/// along the projection path by [`crate::Place::storage_class`]. It is never an
/// argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum StorageClass {
    /// An allocation of its own, destroyed by the binding at scope exit.
    Owned,
    /// Bytes inside a parent object or array. The parent destroys it as part of
    /// destroying itself, through a **direct** call to its drop chain rather
    /// than a virtual one — a slot sized for a `Base` cannot be holding a
    /// `Derived`, because putting one there would have sliced it. Its storage
    /// is never handed back to the allocator on its own; the parent's is.
    Inline,
    /// An address into somebody else's storage. Nobody destroys it.
    Borrowed,
    /// Unnamed, produced by an expression, destroyed at the end of the
    /// enclosing full-expression in reverse order of creation.
    Temporary,
}

impl StorageClass {
    /// Whether a value in this storage class is ever destroyed by the code that
    /// names it.
    #[inline]
    pub const fn is_destroyed_here(self) -> bool {
        matches!(self, StorageClass::Owned | StorageClass::Temporary)
    }
}

/// An entry in [`crate::Module::types`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct TyDef {
    pub kind: TyKind,
    pub category: Category,
}

/// An entry in [`crate::Module::structs`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct StructDef {
    pub name: SymId,
    pub fields: Vec<FieldDef>,
    /// Whether this struct may cross the C boundary. A struct that does must be
    /// plain data all the way down: a byte copy has to be the *whole* copy, or
    /// the two sides disagree about who frees what (REWRITE-PLAN §6).
    pub c_compatible: bool,
    /// A C `union`: every field starts at offset 0.
    ///
    /// Not a separate [`TyKind`], because a union *is* a struct everywhere but
    /// the offset computation — the same fields, the same projections, the same
    /// ABI classification, the same copy. Only [`crate::Layout`] reads this, and
    /// splitting the variant would have meant nine `Struct | Union` arms saying
    /// the same thing and one saying something different.
    ///
    /// The frontend guarantees the members are plain data. A union whose members
    /// own anything has no definable destructor: nothing in the bytes says which
    /// member is live, so nothing can say which one to release.
    pub union: bool,
    pub span: Span,
}

impl StructDef {
    #[inline]
    pub fn field(&self, id: FieldId) -> Option<&FieldDef> {
        self.fields.get(id.index())
    }
}

/// A field of a [`StructDef`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct FieldDef {
    pub name: SymId,
    pub ty: TyId,
    pub span: Span,
}

/// An entry in [`crate::Module::classes`].
///
/// Both tables here are **flattened**: `fields` and `vtable` already contain
/// everything inherited, base first, so a [`crate::ids::FieldId`] and a vtable
/// slot mean the same thing whatever the static type is. That is what makes an
/// upcast free — a `Base` is a prefix of a `Derived`, in the layout and in the
/// dispatch table both — and it keeps the backend from walking a base chain at
/// every field access.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct ClassDef {
    pub name: SymId,
    pub base: Option<ClassId>,
    /// Every field, base classes' first, in layout order. Offsets are computed
    /// by the backend after the vtable pointer at offset 0.
    pub fields: Vec<FieldDef>,
    /// Where this class's own fields begin in [`ClassDef::fields`]. Everything
    /// before it came from a base.
    pub own_fields: u32,
    /// Every virtual slot, base slots first, each holding *this* class's final
    /// overrider. Slot 0 is the destructor (REWRITE-PLAN §4.1).
    ///
    /// Emitted as static data preceded by a pointer to the type descriptor, so
    /// the object's vtable pointer aims at slot 0 and the descriptor sits at
    /// `-1`. Every class has one, including a class that overrides nothing —
    /// see the note in [`crate::Module::classes`].
    pub vtable: Vec<FuncId>,
    /// Interfaces this class declared `implements`, each with the itab that
    /// answers them. Sorted by [`InterfaceId`] so a dynamic cast binary-searches
    /// rather than scanning (DECISIONS §11.2).
    pub implements: Vec<Impl>,
    pub span: Span,
}

impl ClassDef {
    #[inline]
    pub fn field(&self, id: FieldId) -> Option<&FieldDef> {
        self.fields.get(id.index())
    }

    /// The fields this class declared itself, as opposed to inherited.
    #[inline]
    pub fn own_fields(&self) -> &[FieldDef] {
        &self.fields[self.own_fields as usize..]
    }
}

/// One `implements` clause, resolved.
///
/// The method list is the *interface's* method set resolved against the class,
/// so it is a permutation-and-subset gather of [`ClassDef::vtable`] and needs no
/// separate lookup at runtime.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct Impl {
    pub interface: InterfaceId,
    /// The class's final overrider for each of the interface's methods, in the
    /// interface's own method order.
    pub methods: Vec<FuncId>,
}

/// An entry in [`crate::Module::interfaces`]: a *contract*.
///
/// Method order is the interface's declaration order after sorting by name, so
/// that a slot is a function of the method *set* rather than of the source
/// text — reordering a declaration is then not a silent ABI change
/// (DECISIONS §11.2).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct InterfaceDef {
    pub name: SymId,
    pub methods: Vec<InterfaceMethod>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct InterfaceMethod {
    pub name: SymId,
    pub sig: SigId,
}

/// Which calling convention a function uses.
///
/// Both halves of a call read the same recorded signature, so an internal call
/// to an exported function agrees with itself (REWRITE-PLAN §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Abi {
    /// Whatever is fastest. Aggregates travel by address.
    Internal,
    /// Classified per platform: Win64 or System V, as the target demands.
    /// Every `import` and every exported function is this.
    C,
}

/// A parameter of a [`Signature`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct Param {
    pub ty: TyId,
    /// Debug-info only. Lowering addresses parameters by index.
    pub name: Option<SymId>,
}

/// An entry in [`crate::Module::sigs`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct Signature {
    pub params: Vec<Param>,
    pub ret: TyId,
    pub abi: Abi,
    /// C variadics, for `printf`-shaped imports. Never true for
    /// [`Abi::Internal`].
    pub variadic: bool,
}
