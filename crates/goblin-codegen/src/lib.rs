//! Layout, code generation and linking.
//!
//! Everything downstream of the MIR. This crate is deliberately unaware of
//! TypeScript, of tsc, and of the napi boundary — it takes a decoded
//! [`goblin_mir::Module`] and produces object files and executables.
//!
//! The rule that shapes it is REWRITE-PLAN §8's first: **the backend never
//! reports a user error.** Anything here that cannot proceed is a compiler bug,
//! and [`error::InternalError`] says so — loudly, by panicking in debug builds,
//! so that a test cannot mistake a backend failure for a clean rejection.

pub mod abi;
pub mod clif;
pub mod error;
pub mod layout;
pub mod link;
pub mod object;
pub mod runtime;
pub mod translate;
pub mod vtable;

pub use error::{InternalError, Result};
pub use layout::{Layout, Layouts, Repr, Scalar, TargetInfo, render_type};
pub use link::{LinkReport, LinkRequest, OutputKind, extension_for, link, prefix_for};
pub use object::{CodegenOptions, ModuleArtifact, OptLevel, compile_module, target_info};
