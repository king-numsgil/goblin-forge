//! The napi addon: one process, one function call, one buffer.
//!
//! REWRITE-PLAN §2. v1 ran the frontend under Bun and the backend as a separate
//! Rust binary, talking line-delimited JSON over stdio. The reason for keeping
//! `tsc` as the type checker was right; the process boundary bought nothing that
//! the boundary between a JS module and a native addon does not.
//!
//! The surface here is deliberately tiny. Only the MIR crosses as an opaque
//! buffer — everything else is a flat `#[napi(object)]`. Modelling a deeply
//! nested tagged-union IR as napi objects is exactly what napi-rs handles
//! badly, and it would put us back to hand-written conversions in a new costume.

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use goblin_codegen::{CodegenOptions, OptLevel, OutputKind};

mod summary;

use summary::summarise;

/// How the backend was configured for this build.
#[napi(object)]
pub struct BackendOptions {
    /// Target triple. `None` means the host.
    pub target: Option<String>,
    /// `"none" | "speed" | "size"`.
    pub opt_level: String,
    pub debug_info: bool,
    /// Runtime liveness checks.
    pub checked: bool,
    /// Panic on an internal backend error rather than returning a diagnostic.
    ///
    /// REWRITE-PLAN §8: a backend error that comes back politely is
    /// indistinguishable from a clean rejection, and a compiler crash then
    /// reads as a passing test. The test harness sets this; a release build of
    /// a shipped compiler leaves it off.
    pub strict_internal_errors: Option<bool>,
}

/// A structured diagnostic.
///
/// REWRITE-PLAN §2: a napi `Result::Err` becomes a thrown JS exception, which is
/// the wrong shape for a compiler. Diagnostics come back *in the result value*;
/// throwing is reserved for "the addon itself broke".
///
/// The backend does not produce diagnostics *about user programs* at all. Every
/// `GF9###` here means the compiler is broken, not the program.
#[napi(object)]
pub struct BackendDiagnostic {
    /// `"error" | "warning" | "note"`.
    pub severity: String,
    /// A `GF####` code.
    pub code: String,
    pub message: String,
}

impl BackendDiagnostic {
    fn error(code: &str, message: impl Into<String>) -> BackendDiagnostic {
        BackendDiagnostic {
            severity: "error".into(),
            code: code.into(),
            message: message.into(),
        }
    }
}

/// What a decoded module contains, without compiling it.
#[napi(object)]
pub struct ModuleSummary {
    pub ok: bool,
    pub name: String,
    pub func_count: u32,
    pub block_count: u32,
    pub statement_count: u32,
    pub type_count: u32,
    pub string_count: u32,
    /// Symbols this module defines, for the linker and for archive validation.
    pub defines: Vec<String>,
    /// Symbols it needs from somewhere else.
    pub requires: Vec<String>,
    pub diagnostics: Vec<BackendDiagnostic>,
}

/// What one type occupies, and where its parts are.
///
/// Exposed so the differential layout suite can ask this compiler the same
/// questions it asks a C compiler. REWRITE-PLAN §6: differential-test the
/// layout, do not assert it.
#[napi(object)]
pub struct LayoutReport {
    /// Index into the module's type table.
    pub ty: u32,
    /// How the type is spelled, for a readable failure.
    pub name: String,
    /// Bytes occupied. This is the *storage* size — never "what a register
    /// holds", which is a different question with a different answer (§5.2).
    pub size: u32,
    pub align: u32,
    /// Distance between consecutive elements of an array of this type.
    pub stride: u32,
    /// Byte offset of each field, in declaration order. Empty for scalars.
    pub field_offsets: Vec<u32>,
}

/// What compiling one module produced.
#[napi(object)]
pub struct ModuleArtifact {
    pub ok: bool,
    /// Absolute path of the object file, when one was written.
    pub object_path: Option<String>,
    pub defines: Vec<String>,
    pub requires: Vec<String>,
    pub diagnostics: Vec<BackendDiagnostic>,
}

#[napi(object)]
pub struct LinkRequest {
    /// `"bin" | "static-lib" | "shared-lib"`.
    pub kind: String,
    pub objects: Vec<String>,
    pub archives: Vec<String>,
    /// System libraries, in the spelling the platform linker expects.
    pub system_libs: Vec<String>,
    pub output: String,
}

#[napi(object)]
pub struct LinkReport {
    pub ok: bool,
    pub output: Option<String>,
    /// The exact command run, so a link failure can be reproduced by hand.
    pub command: Option<String>,
    pub diagnostics: Vec<BackendDiagnostic>,
}

#[napi]
pub struct Backend {
    codegen: CodegenOptions,
}

#[napi]
impl Backend {
    #[napi(constructor)]
    pub fn new(options: BackendOptions) -> Result<Self> {
        let opt_level = OptLevel::parse(&options.opt_level).ok_or_else(|| {
            Error::from_reason(format!(
                "`{}` is not an optimisation level; expected \"none\", \"speed\" or \"size\"",
                options.opt_level
            ))
        })?;

        if let Some(strict) = options.strict_internal_errors {
            goblin_codegen::error::set_panic_on_internal_errors(strict);
        }

        Ok(Backend {
            codegen: CodegenOptions {
                target: options.target,
                opt_level,
                debug_info: options.debug_info,
                checked: options.checked,
            },
        })
    }

    /// Decode MIR, emit an object file, and report what it defines and needs.
    #[napi]
    pub fn compile_module(&mut self, mir: Uint8Array, object_path: String) -> ModuleArtifact {
        let module = match goblin_mir::decode(&mir) {
            Ok(module) => module,
            Err(error) => {
                return ModuleArtifact {
                    ok: false,
                    object_path: None,
                    defines: Vec::new(),
                    requires: Vec::new(),
                    diagnostics: vec![BackendDiagnostic::error(
                        "GF9001",
                        format!("could not decode MIR: {error}"),
                    )],
                };
            }
        };

        let stale = summary::fingerprint_mismatch(&module);
        if !stale.is_empty() {
            return ModuleArtifact {
                ok: false,
                object_path: None,
                defines: Vec::new(),
                requires: Vec::new(),
                diagnostics: stale,
            };
        }

        let path = PathBuf::from(&object_path);
        match goblin_codegen::compile_module(&module, &self.codegen, &path) {
            Ok(artifact) => ModuleArtifact {
                ok: true,
                object_path: Some(artifact.object_path.to_string_lossy().into_owned()),
                defines: artifact.defines,
                requires: artifact.requires,
                diagnostics: Vec::new(),
            },
            Err(error) => ModuleArtifact {
                ok: false,
                object_path: None,
                defines: Vec::new(),
                requires: Vec::new(),
                diagnostics: vec![BackendDiagnostic::error("GF9003", error.to_string())],
            },
        }
    }

    /// Object files and archives to a binary or a library.
    #[napi]
    pub fn link(&self, request: LinkRequest) -> LinkReport {
        let kind = match request.kind.as_str() {
            "bin" => OutputKind::Bin,
            "static-lib" => OutputKind::StaticLib,
            "shared-lib" => OutputKind::SharedLib,
            other => {
                return LinkReport {
                    ok: false,
                    output: None,
                    command: None,
                    diagnostics: vec![BackendDiagnostic::error(
                        "GF9004",
                        format!("`{other}` is not an output kind"),
                    )],
                };
            }
        };

        let objects: Vec<PathBuf> = request.objects.iter().map(PathBuf::from).collect();
        let archives: Vec<PathBuf> = request.archives.iter().map(PathBuf::from).collect();
        let output = PathBuf::from(&request.output);

        let link_request = goblin_codegen::LinkRequest {
            kind,
            objects: &objects,
            archives: &archives,
            system_libs: &request.system_libs,
            output: &output,
        };

        match goblin_codegen::link(&link_request) {
            Ok(report) => LinkReport {
                ok: true,
                output: Some(report.output.to_string_lossy().into_owned()),
                command: Some(report.command),
                diagnostics: Vec::new(),
            },
            // A link failure is genuinely outside the program's control — a
            // missing toolchain, an unreadable archive — so unlike a codegen
            // error it is not automatically a compiler bug.
            Err(error) => LinkReport {
                ok: false,
                output: None,
                command: None,
                diagnostics: vec![BackendDiagnostic::error("GF9005", format!("{error:#}"))],
            },
        }
    }

    /// Report the layout of every type in a module.
    ///
    /// The same computation code generation uses, asked directly, so the
    /// differential suite is testing the layout engine rather than a
    /// reimplementation of it.
    #[napi]
    pub fn describe_layouts(&self, mir: Uint8Array) -> Result<Vec<LayoutReport>> {
        let module = goblin_mir::decode(&mir)
            .map_err(|error| Error::from_reason(format!("could not decode MIR: {error}")))?;
        summary::layouts(&module, &self.codegen)
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Decode a MIR buffer and report what is in it, without compiling.
    #[napi]
    pub fn describe_module(&self, mir: Uint8Array) -> ModuleSummary {
        match goblin_mir::decode(&mir) {
            Ok(module) => summarise(&module),
            Err(error) => ModuleSummary {
                ok: false,
                name: String::new(),
                func_count: 0,
                block_count: 0,
                statement_count: 0,
                type_count: 0,
                string_count: 0,
                defines: Vec::new(),
                requires: Vec::new(),
                diagnostics: vec![BackendDiagnostic::error(
                    "GF9001",
                    format!("could not decode MIR: {error}"),
                )],
            },
        }
    }

    /// Decode a MIR buffer and encode it again.
    ///
    /// This exists so the test suite can prove the *generated* TypeScript
    /// encoder agrees with Rust byte for byte. postcard is not
    /// self-describing — field order is the wire format — so "it decoded
    /// without error" is not evidence of anything. "It decoded and re-encoded
    /// to the identical bytes" is.
    #[napi]
    pub fn round_trip(&self, mir: Uint8Array) -> Result<Uint8Array> {
        let module = goblin_mir::decode(&mir)
            .map_err(|error| Error::from_reason(format!("could not decode MIR: {error}")))?;
        let bytes = goblin_mir::encode(&module)
            .map_err(|error| Error::from_reason(format!("could not encode MIR: {error}")))?;
        Ok(bytes.into())
    }
}

/// The wire-format fingerprint this addon was built with, as hex.
///
/// Hex rather than a number because the value does not fit in an f64 and
/// `BigInt` across napi buys nothing here — it is only ever compared.
#[napi]
pub fn schema_fingerprint() -> String {
    format!("{:016x}", goblin_mir::schema::fingerprint())
}

/// The file extension a target of this kind gets on this platform.
#[napi]
pub fn output_extension(kind: String) -> String {
    let kind = match kind.as_str() {
        "static-lib" => OutputKind::StaticLib,
        "shared-lib" => OutputKind::SharedLib,
        _ => OutputKind::Bin,
    };
    goblin_codegen::extension_for(kind, cfg!(windows)).to_owned()
}
