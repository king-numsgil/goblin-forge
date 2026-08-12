//! Indices into the tables that make up a [`crate::Module`].
//!
//! Every id is a newtype over `u32` so that postcard encodes it as a varint —
//! most modules use small indices, so most ids cost one byte on the wire.
//!
//! Ids are *not* interchangeable. The TypeScript bindings generated from these
//! definitions give each one a distinct brand, so handing a `BlockId` to
//! something expecting a `LocalId` is a type error on the frontend side too.

use postcard_schema::Schema;
use serde::{Deserialize, Serialize};

macro_rules! ids {
    ($($(#[$meta:meta])* $name:ident,)*) => {
        $(
            $(#[$meta])*
            #[derive(
                Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash,
                Serialize, Deserialize, Schema,
            )]
            pub struct $name(pub u32);

            impl $name {
                /// The id as a `usize`, for indexing the table it refers to.
                #[inline]
                pub const fn index(self) -> usize {
                    self.0 as usize
                }
            }

            impl From<u32> for $name {
                #[inline]
                fn from(raw: u32) -> Self {
                    Self(raw)
                }
            }
        )*
    };
}

ids! {
    /// Index into [`crate::Module::strings`].
    SymId,
    /// Index into [`crate::Module::files`].
    FileId,
    /// Index into [`crate::Module::types`].
    TyId,
    /// Index into [`crate::Module::sigs`].
    SigId,
    /// Index into [`crate::Module::structs`].
    StructId,
    /// Index into [`crate::Module::classes`].
    ClassId,
    /// Index into [`crate::Module::interfaces`].
    InterfaceId,
    /// Index into [`crate::Module::funcs`].
    FuncId,
    /// Index into [`crate::Module::externs`].
    ExternId,
    /// Index into [`crate::Function::blocks`]. Block 0 is always the entry.
    BlockId,
    /// Index into [`crate::Function::locals`]. Local 0 is always the return
    /// place; locals `1..=sig.params.len()` are the parameters, in order.
    LocalId,
    /// Index into a struct's field list.
    FieldId,
}

impl LocalId {
    /// The return place. Every function has one, even a `void` function, where
    /// its type is [`crate::TyKind::Void`] and nothing is ever stored into it.
    pub const RETURN: LocalId = LocalId(0);

    /// The local holding parameter `index` (0-based).
    #[inline]
    pub const fn param(index: u32) -> LocalId {
        LocalId(index + 1)
    }
}

impl BlockId {
    /// The entry block of a function body.
    pub const ENTRY: BlockId = BlockId(0);
}
