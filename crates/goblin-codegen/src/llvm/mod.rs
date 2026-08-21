//! The LLVM backend: MIR to IR text to an object file.
//!
//! DECISIONS §17 is the decision and [`LLVM-PORT.md`] is the plan. This is
//! stage 1 — the type mapping, the signature writer, and the clang driver.
//! **Function bodies arrive at stage 3**, so what a module renders to today is
//! its types and its declarations, which is exactly enough for clang to check
//! that both of those are well formed.
//!
//! The one rule this backend adds to the house rules: **no `nsw`, no `nuw`, no
//! `noalias`, no TBAA, no fast-math flags, ever, until something deliberately
//! decides otherwise.** LLVM has a undefined-behaviour surface Cranelift does
//! not, and §17 names the hazard precisely — asserting one of these
//! *accidentally* and having it be true for two years. There is one place in
//! this backend where such a flag could be attached, and it is empty.
//!
//! [`LLVM-PORT.md`]: ../../../../LLVM-PORT.md

pub mod driver;
pub mod sig;
pub mod ty;

use goblin_mir::{Linkage, Module};

use crate::abi::Conv;
use crate::error::{InternalError, Result};
use crate::layout::{Layouts, TargetInfo};
use crate::llvm::sig::Rendered;
use crate::llvm::ty::{Types, ident};

/// What one module's IR text declares.
pub struct Emitted {
    pub text: String,
    /// Symbols this module defines, for archive validation and linking.
    pub defines: Vec<String>,
    /// Symbols it needs from somewhere else.
    pub requires: Vec<String>,
}

/// Render a whole module as LLVM IR text.
pub fn emit_module(module: &Module, target: TargetInfo, conv: Conv) -> Result<Emitted> {
    let mut layouts = Layouts::new(module, target);
    let mut types = Types::new();
    let name = module.sym(module.name).unwrap_or("module");

    let mut defines = Vec::new();
    let mut requires = Vec::new();
    // Declarations are rendered before the header is written, because rendering
    // is what discovers which named types the module needs.
    let mut declarations = Vec::new();

    for import in &module.externs {
        let Some(signature) = module.sig(import.sig) else {
            return Err(InternalError::new(format!(
                "signature {} is missing",
                import.sig.0
            )));
        };
        let Some(symbol) = module.sym(import.name) else {
            return Err(InternalError::new("an import has no name"));
        };
        let rendered = sig::render(&mut types, &mut layouts, signature, conv)
            .map_err(|error| error.in_function(symbol))?;
        declarations.push(declare(&rendered, symbol));
        requires.push(symbol.to_owned());
    }

    for func in &module.funcs {
        let Some(signature) = module.sig(func.sig) else {
            return Err(InternalError::new(format!(
                "signature {} is missing",
                func.sig.0
            )));
        };
        let Some(symbol) = module.sym(func.name) else {
            return Err(InternalError::new("a function has no name"));
        };
        let rendered = sig::render(&mut types, &mut layouts, signature, conv)
            .map_err(|error| error.in_function(symbol))?;
        // Stage 3 turns this into a `define` with a body. Until then a
        // defined function is declared like any other, which keeps the module
        // well formed and lets clang check the signature — and means nothing
        // links, which is the honest state of a backend with no bodies.
        declarations.push(declare(&rendered, symbol));
        if func.linkage == Linkage::Export {
            defines.push(symbol.to_owned());
        }
    }

    let mut text = String::with_capacity(4096);
    text.push_str(&format!("; goblin-forge module `{name}`\n"));
    text.push_str(
        "; Generated. No `target triple` or `target datalayout` line: clang is\n\
         ; given `--target=` on the command line, and the only module triple it\n\
         ; accepts without warning is the MSVC-versioned spelling, which this\n\
         ; compiler cannot know.\n",
    );
    text.push_str(&format!("source_filename = \"{}\"\n\n", escape(name)));

    if !types.definitions().is_empty() {
        for definition in types.definitions() {
            text.push_str(definition);
            text.push('\n');
        }
        text.push('\n');
    }

    for declaration in &declarations {
        text.push_str(declaration);
        text.push('\n');
    }

    defines.sort_unstable();
    defines.dedup();
    requires.sort_unstable();
    requires.dedup();

    Ok(Emitted {
        text,
        defines,
        requires,
    })
}

fn declare(rendered: &Rendered, symbol: &str) -> String {
    format!("declare {}", rendered.header(&ident(symbol)))
}

/// Escape a string for an LLVM metadata-style quoted string.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'"' => out.push_str("\\22"),
            b'\\' => out.push_str("\\5C"),
            0x20..=0x7e => out.push(byte as char),
            other => out.push_str(&format!("\\{other:02X}")),
        }
    }
    out
}
