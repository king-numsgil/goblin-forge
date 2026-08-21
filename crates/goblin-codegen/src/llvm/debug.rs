//! Debug information, as LLVM metadata.
//!
//! LLVM-PORT stage 7, and the reason DECISIONS §17 lists debug info among the
//! arguments for the port at all: Cranelift emitted none, `debug_info: bool`
//! was declared and threaded and read by nothing, and teaching Cranelift DWARF
//! would have been work done from scratch against LLVM's `DIBuilder` being a
//! worn path to both DWARF and CodeView.
//!
//! It is a worn path here too. The same metadata produces `.debug$S`/`.debug$T`
//! on Windows and DWARF on ELF, decided by one module flag, and clang needs no
//! `-g` on the command line — the metadata in the module *is* the request.
//!
//! ## What this can and cannot say
//!
//! **Function granularity, because that is what the MIR carries.** `Function`
//! has a span and so do `LocalDecl` and every type definition, but `Statement`
//! and `Terminator` do not. So a backtrace names the right function and points
//! at the line it was declared on, a profiler attributes samples to it, and a
//! crash dump from a player symbolicates. What does not work is stepping line
//! by line, because there are no per-statement lines to step through.
//!
//! Closing that gap is a MIR change — a span on `Statement` — and therefore a
//! wire-format change and frontend work, not something this file can do alone.
//! It is the natural next increment and is deliberately not smuggled in here.

use goblin_mir::{Linkage, Module, Span};

use crate::llvm::ty::ident;

/// Where one function's metadata lives.
#[derive(Debug, Clone, Copy)]
pub struct Subprogram {
    /// The `DISubprogram`, for the `define`.
    pub scope: usize,
    /// The `DILocation` every instruction in the body carries.
    pub location: usize,
}

/// The module's debug metadata, assembled as functions are emitted.
pub struct Debug {
    enabled: bool,
    nodes: Vec<String>,
    /// One metadata id per entry in `Module::files`.
    files: Vec<usize>,
    cu: usize,
    subroutine: usize,
    windows: bool,
}

impl Debug {
    /// Off. Emits nothing and hands back no scopes, so every call site stays
    /// the same shape whether debug info was asked for or not.
    pub fn disabled() -> Debug {
        Debug {
            enabled: false,
            nodes: Vec::new(),
            files: Vec::new(),
            cu: 0,
            subroutine: 0,
            windows: false,
        }
    }

    pub fn new(module: &Module, windows: bool, enabled: bool) -> Debug {
        if !enabled {
            return Debug::disabled();
        }
        let mut debug = Debug {
            enabled: true,
            nodes: Vec::new(),
            files: Vec::new(),
            cu: 0,
            subroutine: 0,
            windows,
        };

        // A module with no recorded files still needs one, because the compile
        // unit has to name a file and a debugger has to have somewhere to say
        // the code came from.
        if module.files.is_empty() {
            let file = debug.file_node("<unknown>", "");
            debug.files.push(file);
        } else {
            for path in &module.files {
                let (directory, name) = split(path);
                let file = debug.file_node(name, directory);
                debug.files.push(file);
            }
        }

        let primary = debug.files[0];
        // `DW_LANG_C99` is a stand-in: there is no DWARF language code for
        // Goblin, and claiming C99 makes a debugger's expression evaluator
        // behave sensibly on the scalar types rather than refusing to guess.
        debug.cu = debug.node(&format!(
            "distinct !DICompileUnit(language: DW_LANG_C99, file: !{primary}, \
             producer: \"goblin-forge\", isOptimized: false, runtimeVersion: 0, \
             emissionKind: FullDebug)"
        ));
        let empty = debug.node("!{null}");
        debug.subroutine = debug.node(&format!("!DISubroutineType(types: !{empty})"));
        debug
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    fn node(&mut self, text: &str) -> usize {
        self.nodes.push(text.to_owned());
        self.nodes.len() - 1
    }

    fn file_node(&mut self, name: &str, directory: &str) -> usize {
        self.node(&format!(
            "!DIFile(filename: \"{}\", directory: \"{}\")",
            super::escape(name),
            super::escape(directory)
        ))
    }

    fn file_of(&self, span: Span) -> usize {
        self.files
            .get(span.file.0 as usize)
            .copied()
            .unwrap_or_else(|| self.files[0])
    }

    /// The metadata for one function.
    pub fn subprogram(&mut self, name: &str, span: Span, linkage: Linkage) -> Option<Subprogram> {
        if !self.enabled {
            return None;
        }
        let file = self.file_of(span);
        let subroutine = self.subroutine;
        let cu = self.cu;
        // An internal function is local to the unit, and saying so is what keeps
        // a debugger from offering it as a global symbol in every other module.
        let flags = match linkage {
            Linkage::Export => "DISPFlagDefinition",
            Linkage::Internal => "DISPFlagLocalToUnit | DISPFlagDefinition",
        };
        let scope = self.node(&format!(
            "distinct !DISubprogram(name: \"{}\", scope: !{file}, file: !{file}, \
             line: {}, type: !{subroutine}, scopeLine: {}, spFlags: {flags}, unit: !{cu})",
            super::escape(name),
            span.line,
            span.line
        ));
        let location = self.node(&format!(
            "!DILocation(line: {}, column: {}, scope: !{scope})",
            span.line, span.col
        ));
        Some(Subprogram { scope, location })
    }

    /// The metadata block, plus the named metadata that anchors it.
    pub fn render(&self) -> String {
        if !self.enabled {
            return String::new();
        }
        let mut out = String::new();
        out.push_str(&format!("\n!llvm.dbg.cu = !{{!{}}}\n", self.cu));

        // Two flags, and the second is what decides the *format*. Same
        // metadata, CodeView on Windows and DWARF elsewhere.
        let version = self.nodes.len();
        let format = version + 1;
        let ident_node = version + 2;
        out.push_str(&format!(
            "!llvm.module.flags = !{{!{version}, !{format}}}\n"
        ));
        out.push_str(&format!("!llvm.ident = !{{!{ident_node}}}\n"));

        for (index, node) in self.nodes.iter().enumerate() {
            out.push_str(&format!("!{index} = {node}\n"));
        }
        out.push_str(&format!(
            "!{version} = !{{i32 2, !\"Debug Info Version\", i32 3}}\n"
        ));
        if self.windows {
            out.push_str(&format!("!{format} = !{{i32 2, !\"CodeView\", i32 1}}\n"));
        } else {
            out.push_str(&format!(
                "!{format} = !{{i32 2, !\"Dwarf Version\", i32 4}}\n"
            ));
        }
        out.push_str(&format!("!{ident_node} = !{{!\"goblin-forge\"}}\n"));
        out
    }
}

/// A path as `DIFile` wants it: the directory, and the name within it.
fn split(path: &str) -> (&str, &str) {
    match path.rfind(['/', '\\']) {
        Some(at) => (&path[..at], &path[at + 1..]),
        None => ("", path),
    }
}

/// `!dbg !N`, or nothing when debug info is off.
pub fn attach(location: Option<usize>) -> String {
    match location {
        Some(id) => format!(", !dbg !{id}"),
        None => String::new(),
    }
}

/// The `!dbg` a `define` carries, naming its subprogram.
pub fn on_define(subprogram: Option<Subprogram>) -> String {
    match subprogram {
        Some(program) => format!(" !dbg !{}", program.scope),
        None => String::new(),
    }
}

/// A symbol as it appears after `@`, for a `define` line.
pub fn symbol(name: &str) -> String {
    ident(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_splits_on_either_separator() {
        assert_eq!(split("F:/src/main.ts"), ("F:/src", "main.ts"));
        assert_eq!(split(r"F:\src\main.ts"), (r"F:\src", "main.ts"));
        assert_eq!(split("main.ts"), ("", "main.ts"));
    }

    #[test]
    fn disabled_emits_nothing_at_all() {
        let debug = Debug::disabled();
        assert!(debug.render().is_empty());
        assert!(!debug.enabled());
    }
}
