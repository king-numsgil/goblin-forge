//! Linking the compiled object against native static libraries.
//!
//! Lifted from v1 essentially unchanged — REWRITE-PLAN §13 lists it as code with
//! no design problems, and it is.
//!
//! The system linker does this job; there is no bundled linker and no attempt to
//! write one. What this module contributes is *finding* the linker and
//! assembling an argument list that is right on the first try — in particular
//! the system libraries a Rust staticlib needs, which come from
//! `rustc --print native-static-libs` rather than from a hardcoded list that
//! rots at the next toolchain bump.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

/// What kind of thing is being produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputKind {
    Bin,
    StaticLib,
    SharedLib,
}

#[derive(Debug, Clone)]
pub struct LinkRequest<'a> {
    pub kind: OutputKind,
    pub objects: &'a [PathBuf],
    pub archives: &'a [PathBuf],
    /// System libraries, in the spelling the platform linker expects.
    pub system_libs: &'a [String],
    pub output: &'a Path,
}

#[derive(Debug, Clone)]
pub struct LinkReport {
    pub output: PathBuf,
    /// The exact command run, so a link failure can be reproduced by hand.
    pub command: String,
}

pub fn link(request: &LinkRequest<'_>) -> Result<LinkReport> {
    if let Some(parent) = request.output.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }

    if request.kind != OutputKind::Bin {
        bail!("library targets arrive with milestone 9");
    }

    let mut command = if cfg!(target_env = "msvc") {
        msvc_command(request)?
    } else {
        unix_command(request)
    };

    let rendered = render(&command);
    let output = command
        .output()
        .with_context(|| format!("running the linker:\n  {rendered}"))?;

    if !output.status.success() {
        bail!(
            "linking failed:\n  {rendered}\n\n{}\n{}",
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    Ok(LinkReport {
        output: request.output.to_path_buf(),
        command: rendered,
    })
}

/// MSVC: `link.exe`, found through the same registry probing `cc` uses for
/// build scripts, so it works without a Developer Command Prompt.
fn msvc_command(request: &LinkRequest<'_>) -> Result<Command> {
    let target = std::env::var("TARGET").unwrap_or_else(|_| "x86_64-pc-windows-msvc".to_owned());
    let tool = cc::windows_registry::find_tool(&target, "link.exe").ok_or_else(|| {
        anyhow::anyhow!(
            "could not find link.exe for {target}. Install the Visual Studio Build Tools \
             with the \"Desktop development with C++\" workload."
        )
    })?;

    let mut command = Command::new(tool.path());
    // find_tool reports the LIB/PATH the toolchain needs; without them link.exe
    // cannot see the CRT or the Windows SDK.
    for (key, value) in tool.env() {
        command.env(key, value);
    }

    command.arg("/NOLOGO");
    command.arg("/SUBSYSTEM:CONSOLE");
    command.arg(format!("/OUT:{}", request.output.display()));
    for object in request.objects {
        command.arg(object);
    }
    for archive in request.archives {
        command.arg(archive);
    }
    for lib in request.system_libs {
        command.arg(lib);
    }
    // Compiled code needs a C runtime whether or not it calls into one: the
    // entry point is `mainCRTStartup`, which lives there. When a linked Rust
    // staticlib already names a CRT we defer to its choice, because mixing
    // msvcrt with libcmt is its own special kind of afternoon.
    if !mentions_crt(request.system_libs) {
        command.arg("/DEFAULTLIB:msvcrt");
        command.arg("kernel32.lib");
    }
    Ok(command)
}

fn mentions_crt(system_libs: &[String]) -> bool {
    system_libs.iter().any(|lib| {
        let lib = lib.to_ascii_lowercase();
        lib.contains("msvcrt") || lib.contains("libcmt") || lib.contains("ucrt")
    })
}

/// ELF and Mach-O: drive the platform C compiler, which knows where the CRT
/// startup files live.
fn unix_command(request: &LinkRequest<'_>) -> Command {
    let cc = std::env::var("CC").unwrap_or_else(|_| "cc".to_owned());
    let mut command = Command::new(cc);
    for object in request.objects {
        command.arg(object);
    }
    for archive in request.archives {
        command.arg(archive);
    }
    for lib in request.system_libs {
        // rustc reports these bare (`m`, `pthread`); the linker wants `-l`.
        if lib.starts_with('-') {
            command.arg(lib);
        } else {
            command.arg(format!("-l{lib}"));
        }
    }
    command.arg("-o").arg(request.output);
    command
}

fn render(command: &Command) -> String {
    let mut out = command.get_program().to_string_lossy().into_owned();
    for arg in command.get_args() {
        out.push(' ');
        let arg = arg.to_string_lossy();
        if arg.contains(' ') {
            out.push_str(&format!("\"{arg}\""));
        } else {
            out.push_str(&arg);
        }
    }
    out
}

/// The file extension a target of this kind gets on this platform.
pub fn extension_for(kind: OutputKind, target_is_windows: bool) -> &'static str {
    match (kind, target_is_windows) {
        (OutputKind::Bin, true) => "exe",
        (OutputKind::Bin, false) => "",
        (OutputKind::StaticLib, true) => "lib",
        (OutputKind::StaticLib, false) => "a",
        (OutputKind::SharedLib, true) => "dll",
        (OutputKind::SharedLib, false) => "so",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rust_staticlibs_crt_choice_wins_over_our_default() {
        assert!(mentions_crt(&["/defaultlib:msvcrt".to_owned()]));
        assert!(mentions_crt(&["libcmt.lib".to_owned()]));
        assert!(!mentions_crt(&["kernel32.lib".to_owned()]));
        assert!(!mentions_crt(&[]));
    }

    #[test]
    fn unix_links_pass_system_libs_as_l_flags() {
        let objects = vec![PathBuf::from("main.o")];
        let request = LinkRequest {
            kind: OutputKind::Bin,
            objects: &objects,
            archives: &[],
            system_libs: &["m".to_owned(), "-pthread".to_owned()],
            output: Path::new("hello"),
        };
        let rendered = render(&unix_command(&request));
        assert!(rendered.contains("-lm"), "{rendered}");
        assert!(rendered.contains("-pthread"), "{rendered}");
        assert!(!rendered.contains("-l-pthread"), "{rendered}");
    }
}
