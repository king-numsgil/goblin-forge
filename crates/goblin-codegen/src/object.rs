//! Compiling a whole module to an object file.
//!
//! Everything downstream of the MIR converges here: the module is rendered as
//! LLVM IR text, the text is written next to the object, and clang turns it
//! into the object. DECISIONS §17 chose that arrangement over `llvm-sys`, and
//! LLVM-PORT is the record of getting here.

use std::path::{Path, PathBuf};

use goblin_mir::{Abi, Linkage, Module};

use crate::abi::Conv;
use crate::error::{InternalError, Result};
use crate::internal_error;
use crate::layout::TargetInfo;

/// How the backend was asked to compile.
#[derive(Debug, Clone)]
pub struct CodegenOptions {
    /// Target triple. `None` means the host.
    pub target: Option<String>,
    pub opt_level: OptLevel,
    pub debug_info: bool,
    /// Runtime liveness checks.
    pub checked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptLevel {
    None,
    Speed,
    Size,
}

impl OptLevel {
    pub fn parse(text: &str) -> Option<OptLevel> {
        match text {
            "none" => Some(OptLevel::None),
            "speed" => Some(OptLevel::Speed),
            "size" => Some(OptLevel::Size),
            _ => None,
        }
    }
}

/// What compiling one module produced.
#[derive(Debug, Clone)]
pub struct ModuleArtifact {
    pub object_path: PathBuf,
    /// Symbols this object defines, for archive validation and linking.
    pub defines: Vec<String>,
    /// Symbols it needs from somewhere else.
    pub requires: Vec<String>,
}

/// Compile a decoded module to an object file on disk.
///
/// The `.ll` is written before clang runs and kept afterwards, so a rejection
/// names a file that is still there — half of why text IR and a subprocess were
/// chosen over an in-process API.
pub fn compile_module(
    module: &Module,
    options: &CodegenOptions,
    object_path: &Path,
) -> Result<ModuleArtifact> {
    let target = target_info(options)?;
    let conv = conv_of(options)?;
    let emitted = crate::llvm::emit_module(module, target, conv)?;
    crate::llvm::driver::compile(&emitted.text, options, object_path)?;

    let mut defines = emitted.defines;
    let mut requires = emitted.requires;
    defines.sort_unstable();
    defines.dedup();
    requires.sort_unstable();
    requires.dedup();

    Ok(ModuleArtifact {
        object_path: object_path.to_path_buf(),
        defines,
        requires,
    })
}

/// The triple being compiled for, named explicitly or the host's.
pub fn target_triple(options: &CodegenOptions) -> Result<target_lexicon::Triple> {
    match &options.target {
        Some(triple) => triple.parse().map_err(|error| {
            InternalError::new(format!("`{triple}` is not a target triple: {error}"))
        }),
        None => Ok(target_lexicon::Triple::host()),
    }
}

/// The target's machine facts, without building a whole compilation.
///
/// The layout suite needs these to ask the layout engine a question; it should
/// not have to render a module to get them.
pub fn target_info(options: &CodegenOptions) -> Result<TargetInfo> {
    let triple = target_triple(options)?;
    let bits = triple
        .pointer_width()
        .map_err(|()| InternalError::new(format!("`{triple}` has no known pointer width")))?
        .bits();
    Ok(TargetInfo::from_pointer_bits(u32::from(bits)))
}

/// The C convention for a target, or a loud failure.
///
/// `None` means this compiler has no rules written down for the platform, and
/// there is no safe default to fall back on — guessing System V on an
/// unsupported architecture produces a program that links and is wrong, which
/// is the failure mode REWRITE-PLAN §8 exists to make impossible.
pub fn conv_of(options: &CodegenOptions) -> Result<Conv> {
    let triple = target_triple(options)?;
    match Conv::of(&triple) {
        Some(conv) => Ok(conv),
        None => internal_error!("no C calling convention is written down for `{triple}`"),
    }
}

/// Whether a signature can cross the C boundary as written.
///
/// Used by the frontend's boundary checks, and kept here so that the rule and
/// the classification that depends on it live together.
pub fn is_c_abi(abi: Abi) -> bool {
    abi == Abi::C
}

/// Whether a function's symbol is published by the object it lands in.
pub fn is_exported(linkage: Linkage) -> bool {
    linkage == Linkage::Export
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(target: Option<&str>) -> CodegenOptions {
        CodegenOptions {
            target: target.map(str::to_owned),
            opt_level: OptLevel::Speed,
            debug_info: false,
            checked: false,
        }
    }

    /// A platform with no convention written down fails loudly.
    #[test]
    fn an_unsupported_target_has_no_convention() {
        crate::error::set_panic_on_internal_errors(false);
        let error = conv_of(&options(Some("aarch64-unknown-linux-gnu")))
            .expect_err("aarch64 has no convention here");
        assert!(
            error.to_string().contains("no C calling convention"),
            "{error}"
        );
    }

    #[test]
    fn the_pointer_width_comes_from_the_triple() {
        assert_eq!(
            target_info(&options(Some("x86_64-pc-windows-msvc")))
                .unwrap()
                .pointer_bytes,
            8
        );
        assert_eq!(
            target_info(&options(Some("i686-unknown-linux-gnu")))
                .unwrap()
                .pointer_bytes,
            4
        );
    }
}
