//! Driving Cranelift over a whole module and writing an object file.

use std::path::{Path, PathBuf};

use cranelift_codegen::settings::{self, Configurable};
use cranelift_codegen::{Context, isa};
use cranelift_frontend::{FunctionBuilder, FunctionBuilderContext};
use cranelift_module::{Linkage as ClifLinkage, Module as ClifModule};
use cranelift_object::{ObjectBuilder, ObjectModule};

use goblin_mir::{Abi, Linkage, Module};

use crate::error::{InternalError, Result};
use crate::internal_error;
use crate::layout::{Layouts, TargetInfo};
use crate::runtime::RuntimeRefs;
use crate::translate::{FuncRefs, FunctionTranslator, ModuleContext, translate_signature};

/// How the backend was asked to compile.
#[derive(Debug, Clone)]
pub struct CodegenOptions {
    /// Target triple. `None` means the host.
    pub target: Option<String>,
    pub opt_level: OptLevel,
    pub debug_info: bool,
    /// Runtime liveness checks.
    pub checked: bool,
    /// Run Cranelift's IR verifier.
    ///
    /// Cranelift defaults this **on**, and it is a compile-time cost with no
    /// effect on the code produced: it checks that the CLIF handed to it is
    /// well formed, which is a statement about this compiler rather than about
    /// the program being compiled. So it belongs on exactly when a broken
    /// compiler is what you are looking for — the same builds that panic on an
    /// internal error rather than returning one (REWRITE-PLAN §8) — and off in
    /// a shipped compiler, which is why it is not simply left at its default.
    pub verify_ir: bool,
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

    fn cranelift_name(self) -> &'static str {
        match self {
            OptLevel::None => "none",
            OptLevel::Speed => "speed",
            OptLevel::Size => "speed_and_size",
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
pub fn compile_module(
    module: &Module,
    options: &CodegenOptions,
    object_path: &Path,
) -> Result<ModuleArtifact> {
    let isa = make_isa(options)?;
    let target = TargetInfo::from_pointer_bits(u32::from(isa.pointer_bits()));
    let call_conv = isa.default_call_conv();
    let frontend_config = isa.frontend_config();

    let name = module.sym(module.name).unwrap_or("module").to_owned();
    let builder = ObjectBuilder::new(isa, name.clone(), cranelift_module::default_libcall_names())
        .map_err(|error| InternalError::new(format!("creating the object module: {error}")))?;
    let mut clif_module = ObjectModule::new(builder);

    let mut layouts = Layouts::new(module, target);

    // Declare everything before defining anything, so a call can name a
    // function that has not been translated yet.
    let mut defines = Vec::new();
    let mut requires = Vec::new();
    let mut func_refs = FuncRefs {
        defined: Vec::new(),
        imported: Vec::new(),
    };

    for import in &module.externs {
        let sig = module
            .sig(import.sig)
            .ok_or_else(|| InternalError::new(format!("signature {} is missing", import.sig.0)))?;
        let symbol = module
            .sym(import.name)
            .ok_or_else(|| InternalError::new("an import has no name"))?;
        let clif_sig = translate_signature(&mut layouts, sig, call_conv)?;
        let id = clif_module
            .declare_function(symbol, ClifLinkage::Import, &clif_sig)
            .map_err(|error| InternalError::new(format!("declaring `{symbol}`: {error}")))?;
        func_refs.imported.push(id);
        requires.push(symbol.to_owned());
    }

    for func in &module.funcs {
        let sig = module
            .sig(func.sig)
            .ok_or_else(|| InternalError::new(format!("signature {} is missing", func.sig.0)))?;
        let symbol = module
            .sym(func.name)
            .ok_or_else(|| InternalError::new("a function has no name"))?;
        let clif_sig = translate_signature(&mut layouts, sig, call_conv)?;
        let linkage = match func.linkage {
            Linkage::Export => ClifLinkage::Export,
            Linkage::Internal => ClifLinkage::Local,
        };
        let id = clif_module
            .declare_function(symbol, linkage, &clif_sig)
            .map_err(|error| InternalError::new(format!("declaring `{symbol}`: {error}")))?;
        func_refs.defined.push(id);
        if func.linkage == Linkage::Export {
            defines.push(symbol.to_owned());
        }
    }

    // After the functions are declared, because a vtable slot holds a function
    // address; before any body is translated, because a constructor installs a
    // vtable pointer.
    let classes = crate::vtable::emit(module, &mut clif_module, &func_refs, target)?;

    let mut context = Context::new();
    let mut builder_context = FunctionBuilderContext::new();
    let mut runtime = RuntimeRefs::default();
    let mut literals = std::collections::HashMap::new();

    for (index, func) in module.funcs.iter().enumerate() {
        let sig = module
            .sig(func.sig)
            .ok_or_else(|| InternalError::new(format!("signature {} is missing", func.sig.0)))?;
        let symbol = module.sym(func.name).unwrap_or("<unnamed>").to_owned();

        context.clear();
        context.func.signature = translate_signature(&mut layouts, sig, call_conv)?;

        let function_builder = FunctionBuilder::new(&mut context.func, &mut builder_context);
        let translator = FunctionTranslator::new(
            function_builder,
            &mut layouts,
            module,
            &mut clif_module,
            ModuleContext {
                func_refs: &func_refs,
                classes: &classes,
                runtime: &mut runtime,
                literals: &mut literals,
            },
            call_conv,
            frontend_config,
        );
        translator
            .translate(func)
            .map_err(|error| error.in_function(symbol.clone()))?;

        clif_module
            .define_function(func_refs.defined[index], &mut context)
            .map_err(|error| {
                InternalError::new(format!("defining `{symbol}`: {error}")).in_function(symbol)
            })?;
    }

    let product = clif_module.finish();
    let bytes = product
        .emit()
        .map_err(|error| InternalError::new(format!("emitting the object file: {error}")))?;

    if let Some(parent) = object_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            InternalError::new(format!("creating {}: {error}", parent.display()))
        })?;
    }
    std::fs::write(object_path, bytes).map_err(|error| {
        InternalError::new(format!("writing {}: {error}", object_path.display()))
    })?;

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

/// The target's machine facts, without building a whole compilation.
///
/// The layout suite needs these to ask the layout engine a question; it should
/// not have to construct an `ObjectModule` to do it.
pub fn target_info(options: &CodegenOptions) -> Result<TargetInfo> {
    let isa = make_isa(options)?;
    Ok(TargetInfo::from_pointer_bits(u32::from(isa.pointer_bits())))
}

fn make_isa(options: &CodegenOptions) -> Result<std::sync::Arc<dyn isa::TargetIsa>> {
    let mut flags = settings::builder();
    flags
        .set("opt_level", options.opt_level.cranelift_name())
        .map_err(|error| InternalError::new(format!("setting opt_level: {error}")))?;
    // Position-independent code by default: it is what every modern platform
    // wants, and a `shared-lib` target will require it outright.
    let _ = flags.set("is_pic", "true");
    // Cranelift's own default is `true`, and it runs the verifier twice per
    // function — once in `Context::compile`, once inside `Context::optimize`.
    // Leaving it at the default made every shipped build pay for a check of
    // the compiler's own output.
    flags
        .set(
            "enable_verifier",
            if options.verify_ir { "true" } else { "false" },
        )
        .map_err(|error| InternalError::new(format!("setting enable_verifier: {error}")))?;

    let shared = settings::Flags::new(flags);

    let builder = match &options.target {
        Some(triple) => {
            let parsed: target_lexicon::Triple = triple.parse().map_err(|error| {
                InternalError::new(format!("`{triple}` is not a target triple: {error}"))
            })?;
            isa::lookup(parsed).map_err(|error| {
                InternalError::new(format!("no backend for `{triple}`: {error}"))
            })?
        }
        None => match cranelift_native::builder() {
            Ok(builder) => builder,
            Err(message) => internal_error!("no Cranelift backend for this host: {message}"),
        },
    };

    builder
        .finish(shared)
        .map_err(|error| InternalError::new(format!("configuring the target: {error}")))
}

/// Whether a signature can cross the C boundary as written.
///
/// Used by the frontend's boundary checks, and kept here so that the rule and
/// the classification that depends on it live together.
pub fn is_c_abi(abi: Abi) -> bool {
    abi == Abi::C
}
