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
    /// Symbols a `shared-lib` publishes.
    ///
    /// Needed only on Windows, and needed absolutely: an ELF shared object
    /// exports every symbol with default visibility, but a DLL exports
    /// **nothing** unless it is told to. Without this a `.dll` links, loads,
    /// and has no entry points — a failure that looks like a mystery at the
    /// call site rather than an error at the link.
    pub exports: &'a [String],
    /// Look for shared libraries beside the artefact itself, at load time.
    ///
    /// Set when the runtime is linked as a shared library, so that
    /// `goblin_runtime.so` shipped next to the binary is the one found — rather
    /// than nothing being found, which on ELF is a loader error naming a file
    /// the user can see is right there.
    ///
    /// Nothing to do on Windows, which searches the executable's own directory
    /// first and has no equivalent to bake in. The spelling differs on the two
    /// platforms that do need it: ELF says `$ORIGIN` and Mach-O says
    /// `@loader_path`.
    pub rpath_origin: bool,
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

    // An archive is not a link. Nothing is resolved, nothing is discarded, and
    // no runtime is pulled in — which is the point: two Goblin static libraries
    // in one program must not each carry a copy of `gf_string_free`. The final
    // executable link is what supplies the runtime, once.
    if request.kind == OutputKind::StaticLib {
        return archive(request);
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

/// Bundle objects into a static library.
///
/// `lib.exe` on MSVC, `ar` everywhere else. Archives from `request.archives`
/// are **not** merged in: an archive is a bag of objects, and a Goblin static
/// library carries only its own. Its consumer links the runtime, and anything
/// else it needs, exactly once at the executable.
fn archive(request: &LinkRequest<'_>) -> Result<LinkReport> {
    // `ar` and `lib.exe` both *append* to an existing archive, so a rebuild
    // after deleting a function would keep the stale object. Removing first
    // makes the output a function of the input.
    if request.output.exists() {
        std::fs::remove_file(request.output)
            .with_context(|| format!("replacing {}", request.output.display()))?;
    }

    let mut command = if cfg!(target_env = "msvc") {
        let target =
            std::env::var("TARGET").unwrap_or_else(|_| "x86_64-pc-windows-msvc".to_owned());
        let tool = cc::windows_registry::find_tool(&target, "lib.exe").ok_or_else(|| {
            anyhow::anyhow!(
                "could not find lib.exe for {target}. Install the Visual Studio Build Tools \
                 with the \"Desktop development with C++\" workload."
            )
        })?;
        let mut command = Command::new(tool.path());
        for (key, value) in tool.env() {
            command.env(key, value);
        }
        command.arg("/NOLOGO");
        command.arg(format!("/OUT:{}", request.output.display()));
        command
    } else {
        let ar = std::env::var("AR").unwrap_or_else(|_| "ar".to_owned());
        let mut command = Command::new(ar);
        // `c` create, `r` replace, `s` write an index — without the index some
        // linkers will not look inside the archive at all.
        command.arg("crs");
        command.arg(request.output);
        command
    };

    for object in request.objects {
        command.arg(object);
    }

    let rendered = render(&command);
    let output = command
        .output()
        .with_context(|| format!("running the archiver:\n  {rendered}"))?;
    if !output.status.success() {
        bail!(
            "archiving failed:\n  {rendered}\n\n{}\n{}",
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
    if request.kind == OutputKind::SharedLib {
        command.arg("/DLL");
        // The import library, beside the DLL. Windows has no equivalent of
        // linking straight against a `.so`: a consumer links this stub, which
        // is what turns a call into a jump through the import address table.
        command.arg(format!(
            "/IMPLIB:{}",
            request.output.with_extension("lib").display()
        ));
        // A DLL exports **nothing** by default. Every symbol has to be named,
        // either by `__declspec(dllexport)` at the definition — which this
        // compiler does not emit — or here.
        let def = write_def_file(request)?;
        command.arg(format!("/DEF:{}", def.display()));
    } else {
        command.arg("/SUBSYSTEM:CONSOLE");
    }
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

/// Write the `.def` file naming a DLL's exports, beside the output.
///
/// Kept on disk rather than piped, because a link failure is meant to be
/// reproducible by hand from the command in the report — and the command names
/// this file.
fn write_def_file(request: &LinkRequest<'_>) -> Result<PathBuf> {
    let path = request.output.with_extension("def");
    let mut text = String::from("EXPORTS\n");
    for symbol in request.exports {
        text.push_str("    ");
        text.push_str(symbol);
        text.push('\n');
    }
    std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
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
    if request.kind == OutputKind::SharedLib {
        command.arg("-shared");
        // Position-independent code is already on by default in `make_isa`,
        // but the *link* needs telling too, and a shared object that was not
        // linked -fPIC fails at load with a relocation error rather than here.
        command.arg("-fPIC");
        // No export list: an ELF shared object publishes every symbol with
        // default visibility, and an exported function gets exactly
        // that. Windows is the platform that needs to be told (see the `.def`
        // file in `msvc_command`), and the asymmetry is the platforms', not
        // this compiler's.

        // What a consumer records in `DT_NEEDED`. Without this the linker
        // records the path it was *given*, so a consumer that links the library
        // by absolute path bakes this build directory into its executable and
        // the copy shipped beside it is never the one loaded. Naming the file
        // instead leaves the search to the loader, which is what an rpath and a
        // "put it next to the binary" instruction are both talking to.
        if let Some(name) = request.output.file_name() {
            let name = name.to_string_lossy();
            // ld64 does not take `-soname`; `-install_name` is the same idea,
            // and `@rpath` there means "wherever the consumer says to look"
            // rather than a fixed directory.
            let flag = if cfg!(target_os = "macos") {
                format!("-Wl,-install_name,@rpath/{name}")
            } else {
                format!("-Wl,-soname,{name}")
            };
            command.arg(flag);
        }
    }
    if request.rpath_origin {
        // Mach-O has no `$ORIGIN`; `@loader_path` is the same idea under a
        // different name, and passing the wrong one is silently ignored rather
        // than reported, so the two are spelled out separately.
        let origin = if cfg!(target_os = "macos") {
            "@loader_path"
        } else {
            "$ORIGIN"
        };
        command.arg(format!("-Wl,-rpath,{origin}"));
    }
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

/// The file name prefix a target of this kind gets on this platform.
///
/// Empty everywhere except a Unix library, where it is `lib` and where leaving
/// it off is not cosmetic: `-lapp` searches for `libapp.so`, so a shared object
/// called `app.so` is one no consumer can name. CMake reaches this the long way
/// round — it decomposes a full path to a shared library into `-L` and `-l` —
/// and the failure it produces is `cannot find -lapp` about a file the user is
/// looking straight at.
pub fn prefix_for(kind: OutputKind, target_is_windows: bool) -> &'static str {
    match (kind, target_is_windows) {
        (OutputKind::Bin, _) | (_, true) => "",
        (OutputKind::StaticLib | OutputKind::SharedLib, false) => "lib",
    }
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

    /// A shared object needs `-shared` at the *link*, not only PIC codegen.
    #[test]
    fn unix_shared_libs_are_linked_shared() {
        let objects = vec![PathBuf::from("lib.o")];
        let request = LinkRequest {
            kind: OutputKind::SharedLib,
            objects: &objects,
            archives: &[],
            system_libs: &[],
            output: Path::new("libdemo.so"),
            exports: &["greet".to_owned()],
            rpath_origin: false,
        };
        let rendered = render(&unix_command(&request));
        assert!(rendered.contains("-shared"), "{rendered}");
        assert!(rendered.contains("-fPIC"), "{rendered}");
        // No export list on ELF: default visibility already publishes them, and
        // naming them here would be a second, divergent source of truth.
        assert!(!rendered.contains("greet"), "{rendered}");
    }

    /// The extension table is what decides whether an import library sits
    /// beside a DLL, so a wrong answer here is a missing file much later.
    #[test]
    fn extensions_match_the_platform() {
        assert_eq!(extension_for(OutputKind::StaticLib, true), "lib");
        assert_eq!(extension_for(OutputKind::StaticLib, false), "a");
        assert_eq!(extension_for(OutputKind::SharedLib, true), "dll");
        assert_eq!(extension_for(OutputKind::SharedLib, false), "so");
        assert_eq!(extension_for(OutputKind::Bin, true), "exe");
        assert_eq!(extension_for(OutputKind::Bin, false), "");
    }

    /// Half of a Unix library's name is the `lib` in front of it, and the half
    /// that a linker asked for `-lapp` actually searches on.
    #[test]
    fn unix_libraries_are_named_lib_something() {
        assert_eq!(prefix_for(OutputKind::StaticLib, false), "lib");
        assert_eq!(prefix_for(OutputKind::SharedLib, false), "lib");
        assert_eq!(prefix_for(OutputKind::Bin, false), "");
        // MSVC names an import library `app.lib` and a DLL `app.dll`; a `lib`
        // in front would be a file nothing looks for.
        assert_eq!(prefix_for(OutputKind::StaticLib, true), "");
        assert_eq!(prefix_for(OutputKind::SharedLib, true), "");
        assert_eq!(prefix_for(OutputKind::Bin, true), "");
    }

    /// A shared object carries the name consumers should record, so that the
    /// copy shipped beside a consumer is the copy it loads.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn unix_shared_libs_carry_a_soname() {
        let objects = vec![PathBuf::from("lib.o")];
        let request = LinkRequest {
            kind: OutputKind::SharedLib,
            objects: &objects,
            archives: &[],
            system_libs: &[],
            output: Path::new("/build/out/libdemo.so"),
            exports: &[],
            rpath_origin: false,
        };
        let rendered = render(&unix_command(&request));
        assert!(rendered.contains("-Wl,-soname,libdemo.so"), "{rendered}");
        // The *name*, not the path it happened to be built at.
        assert!(!rendered.contains("-Wl,-soname,/build"), "{rendered}");
    }

    /// An executable has no soname, and passing one is not harmless — it sets
    /// `DT_SONAME` on a thing nothing links against.
    #[test]
    fn a_binary_gets_no_soname() {
        let objects = vec![PathBuf::from("main.o")];
        let request = LinkRequest {
            kind: OutputKind::Bin,
            objects: &objects,
            archives: &[],
            system_libs: &[],
            output: Path::new("hello"),
            exports: &[],
            rpath_origin: false,
        };
        let rendered = render(&unix_command(&request));
        assert!(!rendered.contains("soname"), "{rendered}");
        assert!(!rendered.contains("install_name"), "{rendered}");
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
            exports: &[],
            rpath_origin: false,
        };
        let rendered = render(&unix_command(&request));
        assert!(rendered.contains("-lm"), "{rendered}");
        assert!(rendered.contains("-pthread"), "{rendered}");
        assert!(!rendered.contains("-l-pthread"), "{rendered}");
    }
}
