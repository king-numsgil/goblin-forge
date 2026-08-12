//! The unit that crosses the napi boundary.

use postcard_schema::Schema;
use serde::{Deserialize, Serialize};

use crate::body::{Function, Linkage};
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
    /// Initial bytes, already laid out. `None` means zero-initialised.
    pub init: Option<Vec<u8>>,
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
