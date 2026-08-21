//! Does IR text become a program that runs?
//!
//! LLVM-PORT stage 1's other checkpoint, and the one that de-risks a thing no
//! amount of reading settles: an object clang produced has to link against a
//! static library rustc produced through MSVC, using the linker `link.rs`
//! already drives. If that interoperates, every later stage is about emitting
//! the right IR; if it does not, the whole plan needs a different shape.
//!
//! The IR here is **hand-written**, deliberately. Stage 1 emits types and
//! declarations and no bodies, so generating this would be testing nothing —
//! what is under test is the driver, the linker and the boundary between two
//! toolchains, not the emitter.
//!
//! The runtime call is the point. `gf_print` is Rust, compiled by rustc for
//! `*-msvc`, and it is reached across the same `extern "C"` boundary user code
//! uses. A program that prints and exits proves the whole chain.

use std::path::{Path, PathBuf};
use std::process::Command;

use goblin_codegen::abi::Conv;
use goblin_codegen::layout::TargetInfo;
use goblin_codegen::link::{LinkRequest, OutputKind, link};
use goblin_codegen::llvm::{self, driver};
use goblin_codegen::object::{CodegenOptions, OptLevel};
use goblin_mir::{
    Abi, Category, ExternFunc, FieldDef, FloatTy, IntTy, Module, Param, Signature, Span, StructDef,
    StructId, SymId, TyDef, TyId, TyKind,
};

/// A string literal in the runtime's shape: `len`, `owned`, then the bytes.
///
/// `owned = 0` marks it static, so the runtime's free is a no-op it decides
/// rather than something the compiler remembers at each site. The value the
/// program passes is the symbol's address plus sixteen.
const SOURCE: &str = r#"
@.hello = private unnamed_addr constant <{ i64, i64, [14 x i8] }>
    <{ i64 13, i64 0, [14 x i8] c"llvm speaking\00" }>, align 8

declare void @gf_print(ptr)
declare void @gf_runtime_init()

define i32 @main() {
entry:
  call void @gf_runtime_init()
  %text = getelementptr inbounds i8, ptr @.hello, i64 16
  call void @gf_print(ptr %text)
  ret i32 0
}
"#;

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("goblin-llvm-smoke-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

fn options() -> CodegenOptions {
    CodegenOptions {
        target: None,
        opt_level: OptLevel::None,
        debug_info: false,
        checked: false,
    }
}

/// Build the runtime staticlib and report it plus the system libraries it needs.
///
/// The same two facts `packages/runtime/src/build.ts` gathers, by the same
/// means: `--print native-static-libs` reports on stderr as part of an ordinary
/// build, so this is one compilation and not two. A hardcoded library list is
/// what rots at the next toolchain bump.
fn runtime() -> Option<(PathBuf, Vec<String>)> {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .join("packages/runtime/native");
    if !crate_dir.join("Cargo.toml").exists() {
        return None;
    }

    let output = Command::new("cargo")
        .current_dir(&crate_dir)
        .args([
            "rustc",
            "--release",
            "--quiet",
            "--",
            "-C",
            "target-cpu=x86-64-v3",
            "--print",
            "native-static-libs",
        ])
        .output()
        .ok()?;
    assert!(
        output.status.success(),
        "building the runtime failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_libs = stderr
        .lines()
        .find_map(|line| line.split("native-static-libs:").nth(1))
        .map(|list| {
            list.split_whitespace()
                .map(|lib| lib.to_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let release = crate_dir.join("target/release");
    for name in ["goblin_runtime.lib", "libgoblin_runtime.a"] {
        let candidate = release.join(name);
        if candidate.exists() {
            return Some((candidate, system_libs));
        }
    }
    None
}

/// A module exercising every type shape the emitter can render today.
///
/// Not a program — the C ABI signatures are what pull each shape through
/// `Types` and the signature writer, and clang parsing the result is the
/// assertion. Classes and interfaces arrive with their vtables at stage 2.
fn shapes() -> Module {
    let mut module = Module {
        schema_fingerprint: 0,
        name: SymId(0),
        strings: vec!["shapes".into()],
        files: Vec::new(),
        types: Vec::new(),
        structs: Vec::new(),
        classes: Vec::new(),
        interfaces: Vec::new(),
        sigs: Vec::new(),
        externs: Vec::new(),
        globals: Vec::new(),
        funcs: Vec::new(),
    };
    for kind in [
        TyKind::Void,
        TyKind::Bool,
        TyKind::Int(IntTy::I8),
        TyKind::Int(IntTy::I32),
        TyKind::Int(IntTy::I64),
        TyKind::Int(IntTy::Usize),
        TyKind::Float(FloatTy::F32),
        TyKind::Float(FloatTy::F64),
    ] {
        module.types.push(TyDef {
            kind,
            category: Category::Trivial,
        });
    }
    let (void, i8_, i32_, i64_, f32_, f64_) =
        (TyId(0), TyId(2), TyId(3), TyId(4), TyId(6), TyId(7));
    // A pointer, so `Scalar::Ptr` reaches the emitter as `ptr` and not `i64`.
    module.types.push(TyDef {
        kind: TyKind::Pointer(i32_),
        category: Category::Trivial,
    });
    let pointer = TyId(module.types.len() as u32 - 1);

    let strukt = |module: &mut Module, name: &str, fields: &[TyId], union: bool| -> TyId {
        let id = StructId(module.structs.len() as u32);
        let sym = SymId(module.strings.len() as u32);
        module.strings.push(name.into());
        module.structs.push(StructDef {
            name: sym,
            fields: fields
                .iter()
                .map(|ty| FieldDef {
                    name: sym,
                    ty: *ty,
                    span: Span::SYNTHETIC,
                })
                .collect(),
            c_compatible: true,
            union,
            span: Span::SYNTHETIC,
        });
        module.types.push(TyDef {
            kind: TyKind::Struct(id),
            category: Category::Trivial,
        });
        TyId(module.types.len() as u32 - 1)
    };

    // Interior padding: `{ i8, i64 }` is 1 byte then seven of padding.
    let padded = strukt(&mut module, "Padded", &[i8_, i64_], false);
    // Tail padding: `{ i32, i8 }` is five bytes rounded to eight.
    let tail = strukt(&mut module, "Tail", &[i32_, i8_], false);
    let nested = strukt(&mut module, "Nested", &[tail, i32_], false);
    let mixed = strukt(&mut module, "Mixed", &[f32_, f64_, pointer], false);
    let union = strukt(&mut module, "Union", &[i8_, f64_], true);

    // A fixed array of a tail-padded struct: the stride is wider than the
    // element, so the array has to carry the padding or every index is wrong.
    module.types.push(TyDef {
        kind: TyKind::FixedArray {
            element: tail,
            length: 4,
        },
        category: Category::Trivial,
    });
    let array = TyId(module.types.len() as u32 - 1);
    let holder = strukt(&mut module, "Holder", &[array, i8_], false);

    let declare = |module: &mut Module, name: &str, params: &[TyId], ret: TyId| {
        let sig = goblin_mir::SigId(module.sigs.len() as u32);
        module.sigs.push(Signature {
            params: params
                .iter()
                .map(|ty| Param {
                    ty: *ty,
                    name: None,
                })
                .collect(),
            ret,
            abi: Abi::C,
            variadic: false,
        });
        let sym = SymId(module.strings.len() as u32);
        module.strings.push(name.into());
        module.externs.push(ExternFunc {
            name: sym,
            sig,
            span: Span::SYNTHETIC,
        });
    };

    declare(&mut module, "take_padded", &[padded], void);
    declare(&mut module, "give_padded", &[], padded);
    declare(&mut module, "take_nested", &[nested], void);
    declare(&mut module, "give_nested", &[], nested);
    declare(&mut module, "take_mixed", &[mixed], void);
    declare(&mut module, "take_union", &[union], void);
    declare(&mut module, "take_holder", &[holder], void);
    declare(&mut module, "give_holder", &[], holder);
    declare(&mut module, "roundtrip", &[i8_, f32_, pointer], i8_);

    module
}

/// Every type shape the emitter renders, put through clang's parser.
///
/// The oracle next door compares *classifications*; nothing there would notice
/// a malformed `<{ … }>` or a misspelled attribute. This would, and it is the
/// check that stages 2 and 3 build on top of.
#[test]
fn every_type_shape_parses() {
    let module = shapes();
    let target = TargetInfo::from_pointer_bits(64);

    for (conv, windows, triple) in [
        (Conv::Win64, true, "x86_64-pc-windows-msvc"),
        (Conv::SysV, false, "x86_64-unknown-linux-gnu"),
    ] {
        // `windows` only decides the debug format and debug is off here, so it
        // is inert — and passed honestly anyway, because the one time it was
        // hardcoded it hid the fact that DWARF had never been exercised.
        let emitted =
            llvm::emit_module(&module, target, conv, false, windows).expect("the shapes render");
        let mut options = options();
        options.target = Some(triple.to_owned());

        let dir = scratch();
        let object = dir.join(format!("shapes-{}.obj", triple));
        driver::compile(&emitted.text, &options, &object).unwrap_or_else(|error| {
            panic!(
                "clang rejected our own IR for {triple}:\n{error}\n\n{}",
                emitted.text
            )
        });
    }
}

#[test]
fn ir_text_becomes_a_program_that_runs() {
    let dir = scratch();
    let object = dir.join("smoke.obj");

    // 1. IR text to an object, through the driver under test.
    driver::compile(SOURCE, &options(), &object).expect("clang compiles the IR");
    assert!(
        object.exists(),
        "the driver reported success but wrote nothing"
    );

    // The `.ll` is kept beside the object, always — half of why a subprocess
    // and text IR were chosen over `llvm-sys` (DECISIONS §17).
    let ir = driver::ir_path(&object);
    assert!(ir.exists(), "the IR was not kept at {}", ir.display());

    let Some((library, system_libs)) = runtime() else {
        panic!("the runtime crate did not build; the smoke test cannot check interop without it");
    };

    // 2. A clang-produced COFF object, a rustc/MSVC-produced staticlib, and the
    //    linker `link.rs` already drives — unchanged by the port.
    let exe = dir.join(format!(
        "smoke{}",
        goblin_codegen::extension_for(OutputKind::Bin, cfg!(windows))
    ));
    let report = link(&LinkRequest {
        kind: OutputKind::Bin,
        objects: std::slice::from_ref(&object),
        archives: &[library],
        system_libs: &system_libs,
        output: &exe,
        exports: &[],
        rpath_origin: false,
    })
    .expect("linking a clang object against the Rust runtime");

    // 3. It runs, and the runtime call reached the runtime.
    let run = Command::new(&exe)
        .output()
        .unwrap_or_else(|error| panic!("running {}: {error}", exe.display()));
    let stdout = String::from_utf8_lossy(&run.stdout);
    assert!(
        run.status.success(),
        "the program failed:\n  linked with: {}\n{}{}",
        report.command,
        stdout,
        String::from_utf8_lossy(&run.stderr)
    );
    assert_eq!(
        stdout.trim(),
        "llvm speaking",
        "the runtime call did not produce what it should have"
    );
}

/// The `x86-64-v3` baseline reaches the compiler that acts on it.
///
/// DECISIONS §17's amendment fixes AVX2 as a requirement, and the guarantee is
/// only worth what the object file says. Cranelift's half of this was enabling
/// six feature flags and reading them back off the ISA; clang's half is one
/// `-march`, and the way to check it is the same — look at what came out.
///
/// A 256-bit `fadd` is the probe because it cannot be encoded without AVX: at
/// the baseline LLVM splits it into two SSE `addpd`s, and with AVX2 it is one
/// VEX-encoded `vaddpd` on a YMM register.
#[test]
fn the_avx2_baseline_reaches_the_object() {
    const WIDE: &str = r#"
define <4 x double> @vadd(<4 x double> %a, <4 x double> %b) {
  %r = fadd <4 x double> %a, %b
  ret <4 x double> %r
}
"#;
    let dir = scratch();
    let object = dir.join("wide.obj");
    let mut options = options();
    options.opt_level = OptLevel::Speed;
    driver::compile(WIDE, &options, &object).expect("clang compiles the probe");

    let objdump = which_objdump().expect(
        "the baseline check needs `llvm-objdump`, which ships beside the clang \
         the LLVM backend already requires",
    );
    let output = Command::new(objdump)
        .arg("-d")
        .arg(&object)
        .output()
        .expect("running llvm-objdump");
    let text = String::from_utf8_lossy(&output.stdout);

    assert!(
        text.contains("vaddpd") && text.contains("ymm"),
        "no VEX-encoded 256-bit add in the object — `{}` did not take effect:\n{text}",
        driver::MARCH
    );
}

/// An object dumper: `llvm-objdump` for preference, GNU `objdump` otherwise.
///
/// Beside `GOBLIN_CLANG` first, because that is the toolchain the driver is
/// actually using. Then by name — and a distribution that packages LLVM by
/// version leaves `llvm-objdump-20` on `PATH` and no unsuffixed alias, which is
/// exactly the shape of thing that turns a portable test into a Windows-only
/// one. GNU `objdump` is the last resort and is enough for both callers: its
/// `-h` names the same sections and its `-d` prints the same mnemonics.
fn which_objdump() -> Option<std::ffi::OsString> {
    let exe = |name: &str| {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_owned()
        }
    };

    if let Ok(clang) = std::env::var("GOBLIN_CLANG") {
        let beside = Path::new(&clang).with_file_name(exe("llvm-objdump"));
        if beside.exists() {
            return Some(beside.into_os_string());
        }
    }

    for name in ["llvm-objdump", "objdump"] {
        if Command::new(name)
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
        {
            return Some(std::ffi::OsString::from(name));
        }
    }
    None
}

/// `debug_info` stops being a lie.
///
/// DECISIONS §17 lists it among the arguments for the port: Cranelift declared
/// the flag, `packages/backend` threaded it, and nothing read it. There was no
/// DWARF, no PDB and no line table, so no source-level debugger, no symbolized
/// profile and no symbolicated crash dump from a player.
///
/// The check is the object file rather than the IR, because metadata that does
/// not survive to a debug section is the same lie in a longer form.
/// **Both formats, from whichever host is running**, like the ABI oracle next
/// door and for the same reason.
///
/// One module flag decides CodeView or DWARF, and a check that only exercised
/// the host's format leaves the other unverified. This test did exactly that
/// once: it hardcoded CodeView while compiling for the *host*, so it passed on
/// Windows, never exercised DWARF anywhere, and on Linux asked for CodeView on
/// an ELF target — which produces no debug sections at all, and is how it was
/// found.
#[test]
fn debug_info_reaches_the_object_when_asked_for_and_not_otherwise() {
    let module = shapes_with_a_body();
    let target = TargetInfo::from_pointer_bits(64);
    let dir = scratch();

    for (windows, conv, triple, section) in [
        (true, Conv::Win64, "x86_64-pc-windows-msvc", ".debug$S"),
        (false, Conv::SysV, "x86_64-unknown-linux-gnu", ".debug_info"),
    ] {
        for wanted in [true, false] {
            let emitted = llvm::emit_module(&module, target, conv, wanted, windows)
                .expect("the module renders");
            let mut options = options();
            options.debug_info = wanted;
            options.target = Some(triple.to_owned());
            let object = dir.join(format!("debug-{triple}-{wanted}.o"));
            driver::compile(&emitted.text, &options, &object).unwrap_or_else(|error| {
                panic!(
                    "clang rejected the module for {triple} with debug {wanted}:\n{error}\n\n{}",
                    emitted.text
                )
            });

            let objdump = which_objdump().expect("llvm-objdump");
            let output = Command::new(objdump)
                .arg("-h")
                .arg(&object)
                .output()
                .expect("running llvm-objdump");
            let sections = String::from_utf8_lossy(&output.stdout);
            let present = sections.contains(section);
            assert_eq!(
                present, wanted,
                "{triple} with debug {wanted}: expected `{section}` {wanted}, got {present}\n{sections}"
            );
        }
    }
}

/// One exported function with a real span, so there is something to describe.
fn shapes_with_a_body() -> Module {
    let mut module = Module {
        schema_fingerprint: 0,
        name: SymId(0),
        strings: vec!["dbg".into(), "answer".into()],
        files: vec!["F:/src/main.ts".into()],
        types: vec![goblin_mir::TyDef {
            kind: TyKind::Int(IntTy::I32),
            category: Category::Trivial,
        }],
        structs: Vec::new(),
        classes: Vec::new(),
        interfaces: Vec::new(),
        sigs: vec![Signature {
            params: Vec::new(),
            ret: TyId(0),
            abi: Abi::C,
            variadic: false,
        }],
        externs: Vec::new(),
        globals: Vec::new(),
        funcs: Vec::new(),
    };
    let span = Span {
        file: goblin_mir::FileId(0),
        line: 12,
        col: 3,
    };
    module.funcs.push(goblin_mir::Function {
        name: SymId(1),
        sig: goblin_mir::SigId(0),
        linkage: goblin_mir::Linkage::Export,
        locals: vec![goblin_mir::LocalDecl {
            ty: TyId(0),
            storage: goblin_mir::StorageClass::Owned,
            name: None,
            span,
        }],
        blocks: vec![goblin_mir::Block {
            kind: goblin_mir::BlockKind::Normal,
            statements: vec![goblin_mir::Statement::Init {
                place: goblin_mir::Place::local(goblin_mir::LocalId::RETURN),
                rvalue: goblin_mir::Rvalue::Use(goblin_mir::Operand::Const(
                    goblin_mir::Const::Int {
                        bits: 42,
                        ty: TyId(0),
                    },
                )),
            }],
            terminator: goblin_mir::Terminator::Return,
        }],
        span,
    });
    module
}
