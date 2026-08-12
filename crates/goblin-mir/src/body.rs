//! Function bodies: a CFG of basic blocks over places and rvalues.
//!
//! REWRITE-PLAN §5. This is deliberately not a statement tree with expressions
//! hanging off it. A tree-shaped IR forces ownership decisions into expression
//! contexts that cannot express them, and every workaround for that — `Expr::Seq`,
//! hoisted temporaries carrying setup statements, `bindResult` — is the tree
//! failing to be a graph.
//!
//! Three properties this file is responsible for keeping true:
//!
//! * **A [`Place`] is always an address.** Loading is [`Operand::Copy`], and
//!   nothing else. There is no node that means "a value for scalars and an
//!   interior address for aggregates, decided by the backend".
//! * **Copy and move are written down, not inferred.** The frontend decides;
//!   the backend obeys.
//! * **The type graph in this crate is acyclic.** Places are flat — a root local
//!   plus a projection path — so `Place` never contains an `Operand` that
//!   contains a `Place`. That keeps the generated bindings finite, and it is
//!   also just the better shape.

use postcard_schema::Schema;
use serde::{Deserialize, Serialize};

use crate::ids::{
    BlockId, ClassId, ExternId, FieldId, FuncId, InterfaceId, LocalId, SigId, SymId, TyId,
};
use crate::span::Span;
use crate::ty::StorageClass;

/// One step of a [`Place`]'s projection path.
///
/// [`Projection::Index`] takes a [`LocalId`] rather than an operand: a computed
/// index has to be materialised into a local first. That is what keeps this
/// enum from referring back to [`Operand`], and it is also where a bounds check
/// naturally goes.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Projection {
    /// Through a `Pointer<T>` or a `Reference<T>`.
    ///
    /// This is explicit precisely so that nothing is ever *retyped*. v1
    /// relabelled a pointer as its pointee so field offsets would resolve, and
    /// the destructor pass then saw an owned object and freed storage the
    /// pointer was only borrowing (REWRITE-PLAN §10).
    Deref,
    Field(FieldId),
    /// `base[i]`, where `i` is the value of a local.
    Index(LocalId),
    /// `base[3]`, where the index is known at compile time.
    ConstIndex(u64),
}

/// An addressable location.
///
/// The storage class of a place (REWRITE-PLAN §4.2) is *derived* from the root
/// local's storage class and the projection path — see [`Place::storage_class`].
/// It is never passed as an argument. The `Storage` string that v1 threaded
/// through six call sites of `releaseValue` by hand does not exist here.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct Place {
    pub local: LocalId,
    pub projection: Vec<Projection>,
}

impl Place {
    /// The place denoting a whole local, with no projection.
    #[inline]
    pub fn local(local: LocalId) -> Place {
        Place {
            local,
            projection: Vec::new(),
        }
    }

    /// Whether this place is a bare local.
    #[inline]
    pub fn is_local(&self) -> bool {
        self.projection.is_empty()
    }

    /// REWRITE-PLAN §4.2, derived rather than stored.
    ///
    /// * A bare local has whatever storage class it was declared with.
    /// * Anything reached through a [`Projection::Deref`] is borrowed — the
    ///   thing on the other side of a pointer belongs to somebody else.
    /// * Anything reached through a field or an index is inline: it occupies
    ///   bytes inside a parent, and the parent destroys it as part of
    ///   destroying itself. It is never handed back to the allocator on its own.
    pub fn storage_class(&self, root: StorageClass) -> StorageClass {
        let mut class = root;
        for step in &self.projection {
            class = match step {
                Projection::Deref => StorageClass::Borrowed,
                Projection::Field(_) | Projection::Index(_) | Projection::ConstIndex(_) => {
                    match class {
                        // Reaching into a borrow yields another borrow.
                        StorageClass::Borrowed => StorageClass::Borrowed,
                        _ => StorageClass::Inline,
                    }
                }
            };
        }
        class
    }
}

/// A value fed to an rvalue or a call.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Operand {
    /// Read the place, applying the type's copy operation. Trivial types
    /// `memcpy`; owning types clone what they own; classes slice.
    Copy(Place),
    /// Read the place, transferring ownership. The source is left in a state
    /// that is safe to destroy but must not be read.
    Move(Place),
    /// Read the machine value, leaving ownership exactly where it is.
    ///
    /// This is REWRITE-PLAN §4.5's rule as an operand: "for a `string` or `T[]`
    /// that value is a one-word handle, so the callee shares the buffer and the
    /// caller keeps owning it".
    ///
    /// It is how a by-value argument of an owning type is passed. The caller
    /// has already made the copy that *is* the argument, into a temporary it
    /// will destroy at the end of the full-expression — Itanium-style, the
    /// convention §4.5 picks. Passing `Copy` there would clone a second time
    /// and leak; passing `Move` would make the temporary dead and leave nobody
    /// to destroy it.
    Borrow(Place),
    Const(Const),
}

/// A compile-time constant.
///
/// Integers arrive here as a *bit pattern* of the target width. The width pass
/// has already folded any unary minus into the literal and range-checked the
/// result, because `-128` is a valid `i8` and `128` is not, and checking before
/// folding makes the lower bound of every signed width unwritable
/// (REWRITE-PLAN §10).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Const {
    /// No value at all. The result of a `void` call, and the only constant that
    /// carries no type, because there is no type for it to carry.
    Unit,
    Bool {
        value: bool,
        ty: TyId,
    },
    Int {
        bits: u64,
        ty: TyId,
    },
    /// IEEE-754 bits, so that the encoding is exact and `NaN` payloads survive.
    Float {
        bits: u64,
        ty: TyId,
    },
    /// A null `Pointer<T>`.
    Null(TyId),
    /// A string literal, interned in [`crate::Module::strings`]. The backend
    /// emits it as read-only data.
    Str {
        text: SymId,
        ty: TyId,
    },
    /// The address of a function, for a `FnPtr` value.
    Func(FuncRef),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    BitAnd,
    BitOr,
    BitXor,
    /// The count is converted to the value's type, **not** promoted to a common
    /// type with it (REWRITE-PLAN §7).
    Shl,
    Shr,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

// `&&` and `||` are deliberately absent: they short-circuit, which makes them
// control flow, and control flow belongs in the CFG.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum UnOp {
    /// Arithmetic negation. Never reaches here for an unsigned operand — the
    /// width pass rejects that, or `-1` walks past the range check as a `u8`.
    Neg,
    /// Bitwise complement.
    BitNot,
    /// Logical negation of a `bool`. There is no truthiness, so the operand is
    /// always a `bool`.
    Not,
}

/// What a [`Rvalue::Cast`] actually does at the machine level.
///
/// Written down rather than re-derived from the operand's type, so the backend
/// selects an instruction by lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum CastKind {
    /// Widen, narrow, or reinterpret between integer widths. The `from` type's
    /// signedness decides between sign- and zero-extension.
    IntToInt,
    IntToFloat,
    /// Saturating, matching what the runtime's conversion helpers do.
    FloatToInt,
    FloatToFloat,
    BoolToInt,
    PtrToPtr,
    PtrToInt,
    IntToPtr,
}

/// A computed value, assigned into a place by a [`Statement`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Rvalue {
    Use(Operand),
    /// `default_init`, one of the four operations from REWRITE-PLAN §4.3. Zero
    /// or trivially construct, according to the destination place's type.
    Default,
    Binary {
        op: BinOp,
        lhs: Operand,
        rhs: Operand,
    },
    Unary {
        op: UnOp,
        operand: Operand,
    },
    Cast {
        op: CastKind,
        operand: Operand,
        to: TyId,
    },
    /// `&place`, producing a `Reference<T>`.
    Ref(Place),
    /// `&place`, producing a `Pointer<T>`.
    ///
    /// The same machine operation as [`Rvalue::Ref`] today, and a separate node
    /// anyway: the two produce different types, they read differently in a MIR
    /// dump, and a null check under `checked` belongs to one of them and not
    /// the other.
    AddrOf(Place),
    /// Build an aggregate from its fields, in declaration order.
    Aggregate {
        ty: TyId,
        fields: Vec<Operand>,
    },
    /// The element count of a `string` or a `T[]`.
    Len(Place),
    /// Build a `Reference<I>` from a class place: `(itab, &place)`.
    ///
    /// The itab is static data for this exact `(interface, class)` pair, so the
    /// conversion is two stores and no lookup. Both halves are compile-time
    /// facts: which interface, and which class is being converted *from* — the
    /// static type of `source`, never its dynamic one, because a conversion
    /// from a `Base` yields a `Base`'s itab even when the object is a `Derived`
    /// (DECISIONS §11.2).
    MakeInterface {
        interface: InterfaceId,
        class: ClassId,
        source: Place,
    },
    /// `tryCast<I>(place)`: the same pair, but looked up at **run time**.
    ///
    /// Unlike [`Rvalue::MakeInterface`] there is no class here, because the
    /// point is that the static type does not answer the question. The object's
    /// vtable pointer leads to its *dynamic* type descriptor, which carries a
    /// table of the itabs that type satisfies, and the runtime searches it.
    ///
    /// The itab word is zero when the answer is no — which is exactly the null
    /// the frontend's `Reference<I> | null` promises, so nullability never
    /// becomes a separate representation.
    TryInterface {
        interface: InterfaceId,
        source: Place,
    },
    /// `tryCast<C>(place)` for a **class**: walk the dynamic type's base chain
    /// looking for `class`'s descriptor.
    ///
    /// A different mechanism from [`Rvalue::TryInterface`] answering the same
    /// question, which is why they are two nodes rather than one with a flag —
    /// an interface is found in a table, a base class is found by walking. The
    /// result is one word: the object's address, or null.
    TryClass {
        class: ClassId,
        source: Place,
    },
    /// `place === null` for a `Reference<I>`: whether its itab word is zero.
    ///
    /// A node of its own rather than a `BinOp::Eq`, because the pair is an
    /// aggregate and the comparison is of one word inside it. Naming it also
    /// keeps `Reference<I> | null` from needing a null *constant* to compare
    /// against — there is no such value, only a zero itab.
    InterfaceIsNull(Place),
}

/// What happens if a call unwinds out of this point.
///
/// Goblin has no `throw` yet, so every unwind action the frontend currently
/// emits is [`UnwindAction::Unreachable`]. The edges are in the IR from the
/// start because drop elaboration has to compute cleanup paths *while* it is
/// placing drops; bolting them on afterwards is a rewrite of the pass
/// (REWRITE-PLAN §11.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum UnwindAction {
    /// Nothing to clean up here; keep unwinding into the caller.
    Continue,
    /// Enter this cleanup block, run its drops, then resume unwinding.
    Cleanup(BlockId),
    /// The callee cannot unwind, so this edge is dead.
    Unreachable,
    /// Unwinding past this point would cross a boundary that cannot carry it —
    /// a C-ABI function, today. Abort instead.
    Terminate,
}

/// REWRITE-PLAN §4.3's four operations, and the storage-liveness markers drop
/// elaboration runs on. Nothing here is implied by anything else.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Statement {
    /// The destination holds a live value, which is destroyed before the new
    /// one lands.
    Assign {
        place: Place,
        rvalue: Rvalue,
    },
    /// The destination holds nothing yet. This is construction: `copy_init`
    /// when the rvalue is a [`Operand::Copy`], `move_init` when it is a
    /// [`Operand::Move`], `default_init` when it is [`Rvalue::Default`].
    ///
    /// Copy elision is this node rather than a pattern the backend recognises.
    /// A `new C(...)` written straight into a field is an `Init` on that field.
    Init {
        place: Place,
        rvalue: Rvalue,
    },
    /// `destroy`, respecting storage class and polymorphism.
    ///
    /// Placed by the drop elaboration pass from CFG liveness, never spliced in
    /// by the lowerer and never derived from a scope-depth counter. `flag` is
    /// set when the local may or may not be initialised on the paths reaching
    /// here (REWRITE-PLAN §5.1).
    Drop {
        place: Place,
        flag: Option<LocalId>,
        unwind: UnwindAction,
    },
    StorageLive(LocalId),
    StorageDead(LocalId),
    /// Write a drop flag. Kept distinct from an ordinary bool assignment so
    /// that golden MIR reads clearly and a later pass can elide provably
    /// constant flags.
    SetDropFlag {
        flag: LocalId,
        value: bool,
    },
    Nop,
}

/// Where a call sends its result, and where control goes next.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct CallDest {
    /// The callee constructs into this place. For an owning or aggregate
    /// return this is the storage the caller designates — the same mechanism
    /// as the C ABI's hidden return pointer, because it must be one mechanism
    /// and not two (REWRITE-PLAN §4.5).
    pub place: Place,
    pub target: BlockId,
}

/// One arm of a [`Terminator::Switch`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct SwitchTarget {
    /// The discriminant value, as a bit pattern of the discriminant's width.
    pub value: u64,
    pub block: BlockId,
}

/// A function being called.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum FuncRef {
    /// Defined in this module.
    Local(FuncId),
    /// Imported: another module, or a C library.
    Extern(ExternId),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Callee {
    Direct(FuncRef),
    /// Through a `FnPtr` value. The signature is recorded because the call site
    /// and the definition must classify identically.
    Indirect {
        operand: Operand,
        sig: SigId,
    },
    /// Through the receiver's vtable.
    ///
    /// `args[0]` is the receiver and is also where the vtable pointer comes
    /// from: load it from offset 0 of the object, then load slot `slot`. The
    /// receiver is therefore never repeated here — one operand, read once, used
    /// for both, so the two can never disagree.
    ///
    /// Slot 0 is the destructor. Slots are assigned by the *class*, base slots
    /// first, so a `Derived` vtable is a prefix-compatible extension of its
    /// `Base` and a call through a `Base` reference finds the final overrider.
    Virtual {
        slot: u32,
        sig: SigId,
    },
    /// Through the itab of a `Reference<I>`.
    ///
    /// `args[0]` is the **address of the `(itab, data)` pair**, and the backend
    /// takes both halves out of it: the function comes from `itab[slot]`, and
    /// `data` replaces `args[0]` as the receiver before the call. One operand
    /// in, read once, so the itab and the receiver can never disagree — the
    /// same arrangement [`Callee::Virtual`] uses for a vtable.
    ///
    /// `slot` indexes the *interface's* method set, which is sorted by name, so
    /// it is a function of the method set rather than of the declaration's
    /// source order.
    Interface {
        slot: u32,
        sig: SigId,
    },
}

/// Why a [`Terminator::Abort`] fires. Carried so the runtime can print
/// something better than "aborted".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum AbortReason {
    /// An index was outside its bounds, under `checked`.
    BoundsCheck,
    /// Integer division or remainder by zero.
    DivideByZero,
    /// A null `Pointer<T>` was dereferenced, under `checked`.
    NullDeref,
    /// Unwinding reached a boundary that cannot carry it.
    UnwindAcrossBoundary,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Terminator {
    Goto(BlockId),
    /// A two-way branch on a `bool`.
    ///
    /// When the condition folds to a constant the *lowerer* emits a
    /// [`Terminator::Goto`] instead, so the untaken block is never referenced
    /// and simply disappears. Emitting a conditional branch to an exit block
    /// that is then never filled is a Cranelift verifier error, and
    /// `while (true) { return; }` is one keystroke away (REWRITE-PLAN §10).
    Branch {
        cond: Operand,
        then_block: BlockId,
        else_block: BlockId,
    },
    Switch {
        discr: Operand,
        targets: Vec<SwitchTarget>,
        default: BlockId,
    },
    Call {
        callee: Callee,
        args: Vec<Operand>,
        /// `None` for a call that cannot return.
        destination: Option<CallDest>,
        unwind: UnwindAction,
    },
    /// Return the value in [`crate::ids::LocalId::RETURN`].
    Return,
    Unreachable,
    /// Terminates a cleanup block: keep unwinding into the caller.
    Resume,
    Abort(AbortReason),
}

/// Whether a block runs on the normal path or on an unwind path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum BlockKind {
    Normal,
    /// Reached only while unwinding. Contains drops and ends in
    /// [`Terminator::Resume`] or [`Terminator::Abort`].
    Cleanup,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct Block {
    pub kind: BlockKind,
    pub statements: Vec<Statement>,
    pub terminator: Terminator,
}

/// A slot in a function's frame.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct LocalDecl {
    pub ty: TyId,
    /// REWRITE-PLAN §4.2. Known statically, and the root of the derivation in
    /// [`Place::storage_class`].
    pub storage: StorageClass,
    /// Debug-info only, and `None` for compiler-introduced temporaries and
    /// drop flags.
    pub name: Option<SymId>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum Linkage {
    /// Visible only within this module.
    Internal,
    /// Visible to the linker.
    Export,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct Function {
    pub name: SymId,
    pub sig: SigId,
    pub linkage: Linkage,
    /// Local 0 is the return place; locals `1..=params.len()` are the
    /// parameters, in order; everything after that is a body local, a
    /// temporary, or a drop flag.
    pub locals: Vec<LocalDecl>,
    /// Block 0 is the entry.
    pub blocks: Vec<Block>,
    pub span: Span,
}

impl Function {
    #[inline]
    pub fn block(&self, id: BlockId) -> Option<&Block> {
        self.blocks.get(id.index())
    }

    #[inline]
    pub fn local(&self, id: LocalId) -> Option<&LocalDecl> {
        self.locals.get(id.index())
    }

    /// The declared storage class of a place's root local, which is what
    /// [`Place::storage_class`] needs to start from.
    #[inline]
    pub fn storage_class_of(&self, place: &Place) -> Option<StorageClass> {
        Some(place.storage_class(self.local(place.local)?.storage))
    }
}
