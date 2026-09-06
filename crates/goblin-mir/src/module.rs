//! The unit that crosses the napi boundary.

use postcard_schema::Schema;
use serde::{Deserialize, Serialize};

use crate::body::{Const, Function, Linkage};
use crate::ids::{ClassId, ExternId, FuncId, InterfaceId, SigId, StructId, SymId, TyId};
use crate::span::Span;
use crate::ty::{ClassDef, InterfaceDef, Signature, StructDef, TyDef};

/// A function this module calls but does not define: another Goblin module, or
/// a C library named in a manifest.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct ExternFunc {
    /// The symbol as the linker sees it, already mangled or deliberately not.
    pub name: SymId,
    pub sig: SigId,
    pub span: Span,
}

/// A module-level constant or mutable static.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct Global {
    pub name: SymId,
    pub ty: TyId,
    pub linkage: Linkage,
    pub mutable: bool,
    /// The value, as leaves the *backend* places.
    ///
    /// This used to be `Option<Vec<u8>>` — "initial bytes, already laid out" —
    /// and that is the wrong side of the boundary. Filling it needs field
    /// offsets, padding, `linalg`'s alignments and each enum's underlying width,
    /// none of which the frontend computes: `requireKnownLayout` only asks
    /// *whether* a layout is known. A second layout implementation in TypeScript
    /// would have had to agree with this one forever.
    ///
    /// So the frontend folds *values* and the backend places them — the split
    /// [`crate::Rvalue::SizeOf`] states, that only the backend lays types out.
    ///
    /// **The leaves are depth-first, and the type is the structure.** A struct of
    /// two fields is two entries; a struct holding a three-element array is
    /// three. Nothing here restates the shape, because the shape is already in
    /// [`Global::ty`] and two descriptions of one shape are two things that can
    /// disagree. It is also what this crate's header requires: a
    /// `Vec<GlobalInit>` inside `GlobalInit` is a cyclic schema, and the
    /// generated bindings have to be finite.
    ///
    /// A [`GlobalInit::Zero`] consumes the whole subtree at its position, so a
    /// zeroed 4096-element array is one entry rather than 4096.
    pub init: Vec<GlobalInit>,
    pub span: Span,
}

/// One leaf of a [`Global`]'s value, before layout.
///
/// Every variant is resolvable without running anything, which is the whole rule
/// for a global here: C++'s constant initialisation, and no startup code ever.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub enum GlobalInit {
    /// Every byte of the subtree at this position is zero, whatever its layout
    /// turns out to be. What the old `init: None` meant, as a value rather than
    /// as an absence — and the reason a big zeroed table is cheap on the wire.
    Zero,
    /// One scalar, boolean, enum member, pointer or function address.
    Scalar(Const),
    /// `sizeOf<T>()` in an initialiser, resolved at emission.
    ///
    /// A node rather than a number for the reason [`Global::init`] gives: the
    /// frontend does not have one. It is also why `sizeOf<T>() * 2` does not
    /// fold — there is deliberately no arithmetic here for the backend to do,
    /// until something wants it.
    SizeOf(TyId),
    /// `alignOf<T>()`, the same way.
    AlignOf(TyId),
}

/// A global this module reads but does not define: another Goblin module's
/// `export const`.
///
/// [`ExternFunc`] for data, and it exists for the same reason — the symbol and
/// its type are the only things the two sides share. There is no initialiser
/// here on purpose: the defining module holds the value, and a consumer that
/// could see it would be folding through a link boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct ExternGlobal {
    /// The symbol as the linker sees it, already qualified by its module.
    pub name: SymId,
    pub ty: TyId,
    pub span: Span,
}


/// One compilation unit's worth of MIR.
///
/// Everything is a flat table addressed by a `u32` id. Strings appear exactly
/// once, in [`Module::strings`], which is what keeps the encoded form small: a
/// module's symbol names dominate its byte count otherwise.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Schema)]
pub struct Module {
    /// The generated-bindings fingerprint the frontend was built against.
    ///
    /// The addon is a prebuilt binary and the JavaScript beside it is not, so
    /// "stale `.node` next to fresh JS" is a real and otherwise very confusing
    /// failure. Comparing this against [`crate::SCHEMA_FINGERPRINT`] turns it
    /// into one clear message.
    pub schema_fingerprint: u64,

    pub name: SymId,
    pub strings: Vec<String>,
    /// Absolute paths, indexed by [`crate::ids::FileId`], for debug info.
    pub files: Vec<String>,

    pub types: Vec<TyDef>,
    pub structs: Vec<StructDef>,
    /// Every class, with its fields and vtable already flattened.
    ///
    /// **Every class has a vtable pointer at offset 0**, including one that
    /// declares no virtual method of its own. C++ omits the pointer for a class
    /// with no virtual functions; REWRITE-PLAN §5 states the uniform rule
    /// instead, and taking it literally is what makes `Category::Polymorphic`
    /// mean exactly "is a class" — destruction, dynamic casts and descriptors
    /// then need no "is this one polymorphic?" analysis anywhere. A class is
    /// already not layout-compatible with a C struct, so nothing is lost that
    /// was not already gone.
    pub classes: Vec<ClassDef>,
    /// Every interface that is a *contract* — one carrying method signatures.
    /// A pure-data interface is a [`StructDef`] and is not here.
    pub interfaces: Vec<InterfaceDef>,
    pub sigs: Vec<Signature>,

    pub externs: Vec<ExternFunc>,
    pub globals: Vec<Global>,
    /// The globals this module reads and does not define, addressed by
    /// [`crate::ids::ExternGlobalId`].
    pub extern_globals: Vec<ExternGlobal>,
    pub funcs: Vec<Function>,
}

impl Module {
    #[inline]
    pub fn sym(&self, id: SymId) -> Option<&str> {
        self.strings.get(id.index()).map(String::as_str)
    }

    #[inline]
    pub fn ty(&self, id: TyId) -> Option<&TyDef> {
        self.types.get(id.index())
    }

    #[inline]
    pub fn strukt(&self, id: StructId) -> Option<&StructDef> {
        self.structs.get(id.index())
    }

    #[inline]
    pub fn class(&self, id: ClassId) -> Option<&ClassDef> {
        self.classes.get(id.index())
    }

    #[inline]
    pub fn interface(&self, id: InterfaceId) -> Option<&InterfaceDef> {
        self.interfaces.get(id.index())
    }

    /// Walk a class's base chain, most-derived first.
    pub fn base_chain(&self, id: ClassId) -> impl Iterator<Item = ClassId> + '_ {
        let mut next = Some(id);
        std::iter::from_fn(move || {
            let current = next?;
            next = self.class(current).and_then(|class| class.base);
            Some(current)
        })
    }

    #[inline]
    pub fn sig(&self, id: SigId) -> Option<&Signature> {
        self.sigs.get(id.index())
    }

    #[inline]
    pub fn func(&self, id: FuncId) -> Option<&Function> {
        self.funcs.get(id.index())
    }

    #[inline]
    pub fn extern_func(&self, id: ExternId) -> Option<&ExternFunc> {
        self.externs.get(id.index())
    }
}
