//! Turning a decoded module into the flat report that crosses back to JS.

use goblin_mir::{Callee, FuncRef, Linkage, Module, Terminator};

use crate::{BackendDiagnostic, ModuleSummary};

/// The one check every entry point runs before trusting a decoded module.
///
/// postcard is positional, so a frontend built against a different MIR does not
/// fail to decode — it produces a different, entirely plausible module. Without
/// this the symptom would be miscompiled code with no explanation.
pub fn fingerprint_mismatch(module: &Module) -> Vec<BackendDiagnostic> {
    let expected = goblin_mir::schema::fingerprint();
    if module.schema_fingerprint == expected {
        return Vec::new();
    }
    vec![BackendDiagnostic {
        severity: "error".into(),
        code: "GF9002".into(),
        message: format!(
            "the native backend and the JavaScript frontend were built from \
             different MIR definitions (addon {expected:016x}, frontend {:016x}). \
             Rebuild both with `bun run build:backend`.",
            module.schema_fingerprint
        ),
    }]
}

pub fn summarise(module: &Module) -> ModuleSummary {
    let diagnostics = fingerprint_mismatch(module);

    let block_count: usize = module.funcs.iter().map(|f| f.blocks.len()).sum();
    let statement_count: usize = module
        .funcs
        .iter()
        .flat_map(|f| f.blocks.iter())
        .map(|b| b.statements.len())
        .sum();

    let mut defines: Vec<String> = module
        .funcs
        .iter()
        .filter(|f| matches!(f.linkage, Linkage::Export))
        .filter_map(|f| module.sym(f.name).map(str::to_owned))
        .collect();
    defines.extend(
        module
            .globals
            .iter()
            .filter(|g| matches!(g.linkage, Linkage::Export))
            .filter_map(|g| module.sym(g.name).map(str::to_owned)),
    );
    defines.sort_unstable();
    defines.dedup();

    // An extern is only actually *required* if something calls it. Reading the
    // real call sites rather than the declaration list keeps this honest when
    // the frontend declares more than it uses.
    let mut requires: Vec<String> = Vec::new();
    for func in &module.funcs {
        for block in &func.blocks {
            if let Terminator::Call {
                callee: Callee::Direct(FuncRef::Extern(id)),
                ..
            } = &block.terminator
                && let Some(name) = module.extern_func(*id).and_then(|e| module.sym(e.name))
            {
                requires.push(name.to_owned());
            }
        }
    }
    requires.sort_unstable();
    requires.dedup();

    ModuleSummary {
        ok: diagnostics.is_empty(),
        name: module.sym(module.name).unwrap_or_default().to_owned(),
        func_count: module.funcs.len() as u32,
        block_count: block_count as u32,
        statement_count: statement_count as u32,
        type_count: module.types.len() as u32,
        string_count: module.strings.len() as u32,
        defines,
        requires,
        diagnostics,
    }
}

/// Every type's layout, as the backend computes it.
pub fn layouts(
    module: &Module,
    options: &goblin_codegen::CodegenOptions,
) -> goblin_codegen::Result<Vec<crate::LayoutReport>> {
    let target = goblin_codegen::target_info(options)?;
    let mut layouts = goblin_codegen::Layouts::new(module, target);

    let mut out = Vec::with_capacity(module.types.len());
    for index in 0..module.types.len() {
        let ty = goblin_mir::TyId(index as u32);
        let layout = layouts.layout(ty)?;
        out.push(crate::LayoutReport {
            ty: index as u32,
            name: goblin_codegen::render_type(module, ty),
            size: layout.size,
            align: layout.align,
            stride: layout.stride(),
            field_offsets: layout.fields.clone(),
        });
    }
    Ok(out)
}
