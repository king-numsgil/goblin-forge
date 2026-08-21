//! Getting IR text to an object file, by way of clang.
//!
//! DECISIONS §17 chose a subprocess over `llvm-sys`, and the reason it is cheap
//! here is that this compiler already shells out — to `cargo rustc` for the
//! runtime, to the system linker, to `cc`. "Requires an external toolchain at
//! compile time" is the status quo, not a new class of dependency.
//!
//! Measured on the development machine, 2026-08-21: about 55 ms per
//! invocation. `llvm-sys` stays available as a later optimisation if that ever
//! shows up in a profile; a stock Windows LLVM has no `llvm-config` and six
//! `.lib` files, so taking that route means building LLVM from source rather
//! than changing a dependency.
//!
//! **The `.ll` is kept, always.** It costs nothing, and being able to read and
//! diff the IR — and paste it into Godbolt — is half of what this design was
//! chosen for.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{InternalError, Result};
use crate::object::{CodegenOptions, OptLevel, target_triple};

/// The microarchitecture level this compiler targets, as clang spells it.
///
/// DECISIONS §17's amendment. The same value reaches each tool under a
/// different flag — rustc takes `-C target-cpu`, clang takes `-march`, `llc`
/// takes `-mcpu` — and passing `-mcpu` to clang on x86 is rejected outright,
/// because clang follows GCC in reserving it for other architectures. So the
/// spelling is per-tool and getting it wrong is an error rather than a silent
/// fallback, which is the one merciful thing about it.
pub const MARCH: &str = "-march=x86-64-v3";

/// Which clang to run.
///
/// `GOBLIN_CLANG` overrides, for a machine with several or with none on `PATH`.
fn clang() -> String {
    std::env::var("GOBLIN_CLANG").unwrap_or_else(|_| "clang".to_owned())
}

fn opt_flag(level: OptLevel) -> &'static str {
    match level {
        OptLevel::None => "-O0",
        OptLevel::Speed => "-O2",
        OptLevel::Size => "-Oz",
    }
}

/// The `.ll` that sits beside an object file.
pub fn ir_path(object_path: &Path) -> PathBuf {
    object_path.with_extension("ll")
}

/// Write IR text beside `object_path` and compile it to an object.
pub fn compile(text: &str, options: &CodegenOptions, object_path: &Path) -> Result<PathBuf> {
    if let Some(parent) = object_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            InternalError::new(format!("creating {}: {error}", parent.display()))
        })?;
    }

    let ir = ir_path(object_path);
    std::fs::write(&ir, text)
        .map_err(|error| InternalError::new(format!("writing {}: {error}", ir.display())))?;

    let triple = target_triple(options)?.to_string();
    let mut command = Command::new(clang());
    command
        .arg("-c")
        .arg(&ir)
        .arg("-o")
        .arg(object_path)
        .arg(format!("--target={triple}"))
        .arg(opt_flag(options.opt_level))
        .arg(MARCH)
        // The module carries no `target triple` line, because the only spelling
        // clang accepts without complaint is the MSVC-versioned one
        // (`x86_64-pc-windows-msvc19.43.34810`) and that version is not
        // something this compiler can know. Measured 2026-08-21: both an absent
        // triple and a plain `x86_64-pc-windows-msvc` draw the warning.
        .arg("-Wno-override-module");

    // Position-independent code where the platform wants it. Windows has no
    // equivalent and clang warns if it is asked, so it is not asked.
    if !triple.contains("windows") {
        command.arg("-fPIC");
    }

    let rendered = render(&command);
    let output = command.output().map_err(|error| {
        InternalError::new(format!(
            "running clang:\n  {rendered}\n\n{error}\n\nThe LLVM backend needs \
             clang on PATH, or `GOBLIN_CLANG` pointing at one."
        ))
    })?;

    if !output.status.success() {
        // clang rejecting our own IR is a compiler bug by definition — the
        // program was accepted by tsc and by every frontend check, so anything
        // it says here is about this compiler (REWRITE-PLAN §8). The `.ll` is
        // still on disk and named, because reading it is how this gets fixed.
        return Err(InternalError::new(format!(
            "clang rejected the IR in {}:\n  {rendered}\n\n{}\n{}",
            ir.display(),
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }

    Ok(object_path.to_path_buf())
}

/// The command as a line someone can paste into a shell.
fn render(command: &Command) -> String {
    let mut out = command.get_program().to_string_lossy().into_owned();
    for arg in command.get_args() {
        let arg = arg.to_string_lossy();
        out.push(' ');
        if arg.contains(' ') {
            out.push('"');
            out.push_str(&arg);
            out.push('"');
        } else {
            out.push_str(&arg);
        }
    }
    out
}
