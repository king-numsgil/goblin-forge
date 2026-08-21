//! The LLVM backend: MIR to IR text to an object file.
//!
//! DECISIONS §17 is the decision and [`LLVM-PORT.md`] is the plan. Built so
//! far: the type mapping, the signature writer and the clang driver (stage 1),
//! and the static data — class descriptors, vtables, itabs and string literals
//! (stage 2).
//!
//! **Function bodies arrive at stage 3**, so what a module renders to today is
//! its types, its data and its declarations. That is enough for clang to check
//! all three, and not enough to link, which is the honest state of a backend
//! that cannot yet emit code.
//!
//! The one rule this backend adds to the house rules: **no `nsw`, no `nuw`, no
//! `noalias`, no TBAA, no fast-math flags, ever, until something deliberately
//! decides otherwise.** LLVM has a undefined-behaviour surface Cranelift does
//! not, and §17 names the hazard precisely — asserting one of these
//! *accidentally* and having it be true for two years. There is one place in
//! this backend where such a flag could be attached, and it is empty.
//!
//! [`LLVM-PORT.md`]: ../../../../LLVM-PORT.md

pub mod data;
pub mod driver;
pub mod func;
pub mod sig;
pub mod ty;
pub mod vtable;

use std::collections::{BTreeSet, HashMap};

use goblin_mir::{Linkage, Module};

use crate::abi::Conv;
use crate::error::{InternalError, Result};
use crate::layout::{Layouts, TargetInfo};
use crate::llvm::data::Globals;
use crate::llvm::sig::Rendered;
use crate::llvm::ty::{Types, ident};
use crate::llvm::vtable::ClassSymbols;

/// String literals already emitted, so identical text is emitted once.
///
/// The symbol is content-addressed — `gf_str_` plus the FNV-1a of the bytes —
/// which is the same spelling the Cranelift path uses, so a module compiled
/// either way names its literals identically.
#[derive(Default)]
pub struct Literals {
    seen: HashMap<String, String>,
}

impl Literals {
    pub fn new() -> Literals {
        Literals::default()
    }

    /// The symbol for `text`, emitting the data the first time it is asked for.
    ///
    /// What a program *carries* is this symbol's address plus
    /// [`crate::runtime::STRING_HEADER_BYTES`]; the symbol itself addresses the
    /// header. Stage 3 is what adds the `getelementptr` at each use site.
    pub fn symbol(&mut self, globals: &mut Globals, text: &str) -> String {
        if let Some(symbol) = self.seen.get(text) {
            return symbol.clone();
        }
        let symbol = format!("gf_str_{:016x}", crate::vtable::interface_key(text));
        globals.literal(&symbol, text);
        self.seen.insert(text.to_owned(), symbol.clone());
        symbol
    }
}

/// Every function's linker-visible name, by id.
///
/// Resolved once so a call site is an index rather than a search, and so the
/// name a vtable slot holds and the name a direct call emits cannot disagree.
#[derive(Default)]
pub struct Symbols {
    pub defined: Vec<String>,
    pub imported: Vec<String>,
}

/// What one module's IR text declares.
pub struct Emitted {
    pub text: String,
    /// Symbols this module defines, for archive validation and linking.
    pub defines: Vec<String>,
    /// Symbols it needs from somewhere else.
    pub requires: Vec<String>,
    /// Where each class's static data ended up, by `ClassId`. Stage 3 needs it
    /// — a constructor installs a vtable pointer.
    pub classes: Vec<ClassSymbols>,
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
    let mut symbols = Symbols::default();
    let mut signatures = Vec::with_capacity(module.funcs.len());

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
        symbols.imported.push(symbol.to_owned());
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
        // A function with no blocks is a declaration; one with blocks gets a
        // body below, once every symbol is known — a call may name a function
        // that has not been emitted yet.
        if func.blocks.is_empty() {
            declarations.push(declare(&rendered, symbol));
        }
        signatures.push(rendered);
        symbols.defined.push(symbol.to_owned());
        if func.linkage == Linkage::Export {
            defines.push(symbol.to_owned());
        }
    }

    // After the functions are named, because a vtable slot holds a function
    // address — and before the text is assembled, because emitting the tables
    // is what discovers the names they refer to.
    let mut globals = Globals::new();
    let classes = crate::llvm::vtable::emit(module, &mut globals, target)?;

    // Bodies last: emitting one can discover a string literal, a named type or
    // an intrinsic, and all three are written above it in the file.
    let mut literals = Literals::new();
    let mut intrinsics = BTreeSet::new();
    let mut bodies = Vec::new();
    for (index, function) in module.funcs.iter().enumerate() {
        if function.blocks.is_empty() {
            continue;
        }
        let symbol = symbols.defined[index].clone();
        let emitter = func::Emitter::new(
            module,
            &mut layouts,
            &mut types,
            &mut globals,
            &mut literals,
            &symbols,
            &mut intrinsics,
            conv,
        );
        bodies.push(
            emitter
                .function(function, &signatures[index], &symbol)
                .map_err(|error| error.in_function(symbol))?,
        );
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

    if !globals.lines().is_empty() {
        for line in globals.lines() {
            text.push_str(line);
            text.push('\n');
        }
        text.push('\n');
    }

    for declaration in &declarations {
        text.push_str(declaration);
        text.push('\n');
    }
    for declaration in &intrinsics {
        text.push_str(declaration);
        text.push('\n');
    }

    for body in &bodies {
        text.push('\n');
        text.push_str(body);
    }

    defines.sort_unstable();
    defines.dedup();
    requires.sort_unstable();
    requires.dedup();

    Ok(Emitted {
        text,
        defines,
        requires,
        classes,
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
