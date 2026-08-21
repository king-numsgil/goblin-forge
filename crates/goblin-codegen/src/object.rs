//! Driving Cranelift over a whole module and writing an object file.

use std::path::{Path, PathBuf};

use cranelift_codegen::settings::{self, Configurable};
use cranelift_codegen::{Context, isa};
use cranelift_frontend::{FunctionBuilder, FunctionBuilderContext};
use cranelift_module::{Linkage as ClifLinkage, Module as ClifModule};
use cranelift_object::{ObjectBuilder, ObjectModule};

use goblin_mir::{Abi, Linkage, Module};

use crate::abi::Conv;
use crate::error::{InternalError, Result};
use crate::internal_error;
use crate::layout::{Layouts, TargetInfo};
use crate::runtime::RuntimeRefs;
use crate::translate::{FuncRefs, FunctionTranslator, Machine, ModuleContext, translate_signature};

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
    let conv = conv_of(options)?;
    let machine = Machine {
        call_conv,
        conv,
        frontend_config: isa.frontend_config(),
    };

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
        let clif_sig = translate_signature(&mut layouts, sig, call_conv, conv)?;
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
        let clif_sig = translate_signature(&mut layouts, sig, call_conv, conv)?;
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
        context.func.signature = translate_signature(&mut layouts, sig, call_conv, conv)?;

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
            machine,
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

/// The triple being compiled for, named explicitly or the host's.
///
/// Wanted for its own sake rather than as a detour through the ISA: the C
/// calling convention is a property of the *platform*, and asking Cranelift's
/// `CallConv` for it was asking the code generator a question about the target
/// (LLVM-PORT stage 0).
pub fn target_triple(options: &CodegenOptions) -> Result<target_lexicon::Triple> {
    match &options.target {
        Some(triple) => triple.parse().map_err(|error| {
            InternalError::new(format!("`{triple}` is not a target triple: {error}"))
        }),
        None => Ok(target_lexicon::Triple::host()),
    }
}

/// The C convention for a target, or a loud failure.
///
/// `None` means this compiler has no rules written down for the platform, and
/// there is no safe default to fall back on — guessing System V on an
/// unsupported architecture produces a program that links and is wrong, which
/// is the failure mode REWRITE-PLAN §8 exists to make impossible.
fn conv_of(options: &CodegenOptions) -> Result<Conv> {
    let triple = target_triple(options)?;
    match Conv::of(&triple) {
        Some(conv) => Ok(conv),
        None => internal_error!("no C calling convention is written down for `{triple}`"),
    }
}

/// Every feature `x86-64-v3` names, as Cranelift spells them.
///
/// DECISIONS §17's amendment: the compiler targets `x86-64-v3` and does not run
/// on anything older. Cranelift has no microarchitecture presets — its x64
/// settings expose the features one at a time — so the single `-march` flag
/// that arrives with LLVM is this list until then.
///
/// This also closes the fault §17 records: `cranelift_native::builder()`
/// detects host features, while `isa::lookup` on an explicit triple yields a
/// **baseline** ISA, so naming the host's own triple produced different code
/// from naming nothing. Both paths now enable the same set.
const X86_64_V3: [&str; 6] = [
    "has_avx",
    "has_avx2",
    "has_fma",
    "has_bmi1",
    "has_bmi2",
    "has_lzcnt",
];

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

    let mut builder = match &options.target {
        Some(triple) => {
            let parsed = target_triple(options)?;
            isa::lookup(parsed).map_err(|error| {
                InternalError::new(format!("no backend for `{triple}`: {error}"))
            })?
        }
        None => match cranelift_native::builder() {
            Ok(builder) => builder,
            Err(message) => internal_error!("no Cranelift backend for this host: {message}"),
        },
    };

    // The baseline, on both paths. A machine without AVX2 will fault on the
    // first VEX-encoded instruction rather than run slowly, which is the
    // trade §17's amendment accepts.
    //
    // The result is discarded because these settings exist only on x86, and
    // `target_info` is reachable with any triple. A *typo* would be discarded
    // just as quietly, so `the_baseline_is_actually_enabled` reads the flags
    // back off a finished ISA rather than trusting this loop.
    for feature in X86_64_V3 {
        let _ = builder.enable(feature);
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    fn options(target: Option<&str>) -> CodegenOptions {
        CodegenOptions {
            target: target.map(str::to_owned),
            opt_level: OptLevel::Speed,
            debug_info: false,
            checked: false,
            verify_ir: true,
        }
    }

    /// The features `x86-64-v3` names are really on, on both paths.
    ///
    /// DECISIONS §17 records the fault this closes: the host path detected
    /// features and the explicit-triple path did not, so naming your own
    /// machine's triple produced *different code* from naming nothing. It also
    /// catches a misspelled setting name, which `make_isa` discards in silence
    /// because these settings do not exist outside x86.
    #[test]
    fn the_baseline_is_actually_enabled() {
        for target in ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"] {
            let isa = make_isa(&options(Some(target))).expect(target);
            let flags = isa.isa_flags();
            for feature in X86_64_V3 {
                let value = flags
                    .iter()
                    .find(|flag| flag.name == feature)
                    .unwrap_or_else(|| panic!("`{feature}` is not a setting on {target}"));
                assert_eq!(
                    value.as_bool(),
                    Some(true),
                    "`{feature}` is off for {target}"
                );
            }
        }
    }

    /// A platform with no convention written down fails loudly.
    ///
    /// Guessing System V on an unsupported architecture produces a program that
    /// links and is wrong — the failure REWRITE-PLAN §8 exists to prevent.
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
    fn the_host_and_its_own_triple_agree() {
        // The two paths through `make_isa`, on the same machine.
        let host = make_isa(&options(None)).expect("host");
        let named = make_isa(&options(Some(&target_lexicon::Triple::host().to_string())))
            .expect("host triple");
        for feature in X86_64_V3 {
            let read = |isa: &std::sync::Arc<dyn isa::TargetIsa>| {
                isa.isa_flags()
                    .iter()
                    .find(|flag| flag.name == feature)
                    .and_then(|flag| flag.as_bool())
            };
            assert_eq!(read(&host), read(&named), "`{feature}` differs");
        }
    }
}
