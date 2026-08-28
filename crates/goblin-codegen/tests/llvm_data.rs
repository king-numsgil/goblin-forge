//! Class descriptors, vtables, itabs and string literals, as LLVM constants.
//!
//! LLVM-PORT stage 2. Two kinds of check, because the failure modes are
//! different:
//!
//! * The **text** is asserted for a class with a base, an interface and
//!   methods. A descriptor is a sequence of machine words whose *order* is the
//!   contract, and the itab address in it is biased by one pointer. Both of
//!   those are off-by-one shaped, and an off-by-one here is a wrong answer from
//!   `instanceof` rather than a crash.
//! * The **bias is checked at run time**, by building a program that does what
//!   a compiled object does — hold a vtable pointer aimed at slot 0, reach the
//!   descriptor at `[-1]`, and read its first word. If the bias is wrong that
//!   program exits non-zero, and no amount of reading the constant would have
//!   said so.

use std::path::PathBuf;
use std::process::Command;

use goblin_codegen::abi::Conv;
use goblin_codegen::layout::TargetInfo;
use goblin_codegen::link::{LinkRequest, OutputKind, link};
use goblin_codegen::llvm::data::Globals;
use goblin_codegen::llvm::vtable::interface_key;
use goblin_codegen::llvm::{self, Literals, driver};
use goblin_codegen::object::{CodegenOptions, OptLevel};
use goblin_mir::{
    Abi, Category, ClassDef, ClassId, FuncId, Function, Impl, InterfaceDef, InterfaceId,
    InterfaceMethod, Linkage, Module, SigId, Signature, Span, SymId, TyDef, TyId, TyKind,
};

const TARGET: TargetInfo = TargetInfo { pointer_bytes: 8 };

fn options() -> CodegenOptions {
    CodegenOptions {
        target: None,
        opt_level: OptLevel::O0,
        debug_info: false,
        checked: false,
    }
}

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("goblin-llvm-data-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

/// A module with `Animal` (an interface), `Base`, and `Dog : Base`.
///
/// `Dog` implements `Animal`, so it has all three objects — a descriptor
/// pointing at `Base`'s, a vtable, and an itab — which is the shape where every
/// cross-reference in this file appears at once.
fn zoo() -> Module {
    let mut module = Module {
        schema_fingerprint: 0,
        name: SymId(0),
        strings: vec!["zoo".into()],
        files: Vec::new(),
        types: vec![TyDef {
            kind: TyKind::Void,
            category: Category::Trivial,
        }],
        structs: Vec::new(),
        classes: Vec::new(),
        interfaces: Vec::new(),
        sigs: vec![Signature {
            params: Vec::new(),
            ret: TyId(0),
            abi: Abi::Internal,
            variadic: false,
        }],
        externs: Vec::new(),
        globals: Vec::new(),
        funcs: Vec::new(),
    };

    let sym = |module: &mut Module, text: &str| -> SymId {
        let id = SymId(module.strings.len() as u32);
        module.strings.push(text.into());
        id
    };

    // Two methods, so a vtable slot and an itab slot are distinguishable.
    for name in ["Dog_drop", "Dog_speak"] {
        let name = sym(&mut module, name);
        module.funcs.push(Function {
            name,
            sig: SigId(0),
            linkage: Linkage::Internal,
            locals: Vec::new(),
            blocks: Vec::new(),
            span: Span::SYNTHETIC,
        });
    }

    let animal = sym(&mut module, "Animal");
    let speak = sym(&mut module, "speak");
    module.interfaces.push(InterfaceDef {
        name: animal,
        methods: vec![InterfaceMethod {
            name: speak,
            sig: SigId(0),
        }],
        span: Span::SYNTHETIC,
    });

    let base = sym(&mut module, "Base");
    module.classes.push(ClassDef {
        name: base,
        base: None,
        fields: Vec::new(),
        own_fields: 0,
        vtable: vec![FuncId(0)],
        implements: Vec::new(),
        span: Span::SYNTHETIC,
    });

    let dog = sym(&mut module, "Dog");
    module.classes.push(ClassDef {
        name: dog,
        base: Some(ClassId(0)),
        fields: Vec::new(),
        own_fields: 0,
        // Slot 0 is the destructor, slot 1 the override.
        vtable: vec![FuncId(0), FuncId(1)],
        implements: vec![Impl {
            interface: InterfaceId(0),
            methods: vec![FuncId(1)],
        }],
        span: Span::SYNTHETIC,
    });

    module
}

fn line_for<'a>(text: &'a str, symbol: &str) -> &'a str {
    let needle = format!("@{symbol} = ");
    text.lines()
        .find(|line| line.starts_with(&needle))
        .unwrap_or_else(|| panic!("`{symbol}` was not emitted:\n{text}"))
}

#[test]
fn a_descriptor_names_its_base_its_interfaces_and_their_itabs() {
    let module = zoo();
    let emitted =
        llvm::emit_module(&module, TARGET, Conv::Win64, false, true).expect("the zoo renders");

    // The name is a nul-terminated C string, so a descriptor's name can be
    // handed straight to C.
    assert_eq!(
        line_for(&emitted.text, "__gf_name$Dog"),
        "@__gf_name$Dog = internal constant [4 x i8] c\"Dog\\00\", align 1"
    );

    // +0 name, +1 base, +2 count, then { key, itab } pairs. The itab address
    // is biased past its own descriptor word — that `i64 8` is the whole
    // Itanium arrangement in one number.
    assert_eq!(
        line_for(&emitted.text, "__gf_desc$Dog"),
        format!(
            "@__gf_desc$Dog = internal constant <{{ ptr, ptr, i64, i64, ptr }}> \
             <{{ ptr @__gf_name$Dog, ptr @__gf_desc$Base, i64 1, i64 {}, \
             ptr getelementptr (i8, ptr @__gf_itab$Animal.0$Dog, i64 8) }}>, align 8",
            interface_key("Animal")
        )
    );

    // A base with no base of its own gets a null, not a missing word.
    assert!(
        line_for(&emitted.text, "__gf_desc$Base").contains("ptr @__gf_name$Base, ptr null, i64 0"),
        "{}",
        line_for(&emitted.text, "__gf_desc$Base")
    );

    // The vtable's first word is the descriptor; the object's pointer aims one
    // past it, at slot 0, which is the destructor.
    assert_eq!(
        line_for(&emitted.text, "__gf_vt$Dog"),
        "@__gf_vt$Dog = internal constant <{ ptr, ptr, ptr }> \
         <{ ptr @__gf_desc$Dog, ptr @Dog_drop, ptr @Dog_speak }>, align 8"
    );

    // An itab has a vtable's shape — descriptor first — so a dynamic cast can
    // hand one back and everything downstream works unchanged. It holds the
    // class's final overrider for the interface's methods, gathered at compile
    // time: `speak` and not `drop`.
    assert_eq!(
        line_for(&emitted.text, "__gf_itab$Animal.0$Dog"),
        "@__gf_itab$Animal.0$Dog = internal constant <{ ptr, ptr }> \
         <{ ptr @__gf_desc$Dog, ptr @Dog_speak }>, align 8"
    );
}

#[test]
fn class_data_compiles() {
    let module = zoo();
    for (conv, windows, triple) in [
        (Conv::Win64, true, "x86_64-pc-windows-msvc"),
        (Conv::SysV, false, "x86_64-unknown-linux-gnu"),
    ] {
        let emitted =
            llvm::emit_module(&module, TARGET, conv, false, windows).expect("the zoo renders");
        let mut options = options();
        options.target = Some(triple.to_owned());
        let object = scratch().join(format!("zoo-{triple}.obj"));
        driver::compile(&emitted.text, &options, &object).unwrap_or_else(|error| {
            panic!(
                "clang rejected the class data for {triple}:\n{error}\n\n{}",
                emitted.text
            )
        });
    }
}

/// A literal is deduplicated by content and named by its hash.
#[test]
fn identical_text_is_emitted_once() {
    let mut globals = Globals::new();
    let mut literals = Literals::new();
    let first = literals.symbol(&mut globals, "hello");
    let again = literals.symbol(&mut globals, "hello");
    let other = literals.symbol(&mut globals, "goodbye");

    assert_eq!(first, again);
    assert_ne!(first, other);
    assert_eq!(globals.lines().len(), 2, "the repeat emitted a second copy");
    // The same spelling the Cranelift path uses, so a module compiled either
    // way names its literals identically.
    assert_eq!(first, format!("gf_str_{:016x}", interface_key("hello")));
}

/// The bias, checked by a program that depends on it.
///
/// This is the one that would catch being one pointer out. A compiled object
/// holds a vtable pointer aimed at **slot 0**, so the descriptor is at `[-1]`
/// — and if the emitted vtable put the descriptor anywhere else, the load
/// below reads a function address and the comparison fails.
///
/// The literal is here for the same reason: what a program carries is the
/// symbol's address *plus sixteen*, and printing it proves the header is in
/// front of the text rather than in it.
#[test]
fn the_vtable_bias_is_right_at_run_time() {
    let mut module = zoo();
    // An empty vtable, because stage 2 emits no function bodies: a table
    // naming `Dog_speak` would leave the link with an undefined symbol. The
    // descriptor word is what is under test and it is present either way.
    module.classes[1].vtable.clear();
    module.classes[0].vtable.clear();
    module.classes[1].implements.clear();

    // This one links and runs, so it is built for **the host** rather than for
    // a named triple — and therefore has to describe the host, not Windows.
    let (conv, windows) = if cfg!(windows) {
        (Conv::Win64, true)
    } else {
        (Conv::SysV, false)
    };
    let mut emitted =
        llvm::emit_module(&module, TARGET, conv, false, windows).expect("the zoo renders");

    let mut globals = Globals::new();
    let mut literals = Literals::new();
    let literal = literals.symbol(&mut globals, "data speaking");
    emitted.text.push('\n');
    for line in globals.lines() {
        emitted.text.push_str(line);
        emitted.text.push('\n');
    }

    emitted.text.push_str(&format!(
        r#"
declare void @gf_print(ptr)
declare void @gf_runtime_init()

define i32 @main() {{
entry:
  call void @gf_runtime_init()

  ; What a `string` value is: the symbol, past its sixteen-byte header.
  %text = getelementptr inbounds i8, ptr @{literal}, i64 16
  call void @gf_print(ptr %text)

  ; What an object holds: the vtable, biased to slot 0.
  %vptr = getelementptr inbounds i8, ptr @"__gf_vt$Dog", i64 8
  ; The descriptor sits one pointer behind it.
  %slot = getelementptr inbounds i8, ptr %vptr, i64 -8
  %desc = load ptr, ptr %slot, align 8
  ; A descriptor's first word is its name.
  %name = load ptr, ptr %desc, align 8

  %right = icmp eq ptr %name, @"__gf_name$Dog"
  %code = select i1 %right, i32 0, i32 3
  ret i32 %code
}}
"#
    ));

    let dir = scratch();
    let object = dir.join("bias.obj");
    driver::compile(&emitted.text, &options(), &object).unwrap_or_else(|error| {
        panic!(
            "clang rejected the bias probe:\n{error}\n\n{}",
            emitted.text
        )
    });

    let Some((library, system_libs)) = runtime() else {
        panic!("the runtime crate did not build; the bias cannot be checked without it");
    };
    let exe = dir.join(format!(
        "bias{}",
        goblin_codegen::extension_for(OutputKind::Bin, cfg!(windows))
    ));
    link(&LinkRequest {
        kind: OutputKind::Bin,
        objects: std::slice::from_ref(&object),
        archives: &[library],
        system_libs: &system_libs,
        output: &exe,
        exports: &[],
        rpath_origin: false,
    })
    .expect("linking the bias probe");

    let run = Command::new(&exe)
        .output()
        .unwrap_or_else(|error| panic!("running {}: {error}", exe.display()));
    assert_eq!(
        String::from_utf8_lossy(&run.stdout).trim(),
        "data speaking",
        "the literal's header is not sixteen bytes in front of its text"
    );
    assert_eq!(
        run.status.code(),
        Some(0),
        "the descriptor was not one pointer behind the object's vtable pointer"
    );
}

/// The runtime staticlib and the system libraries it needs.
fn runtime() -> Option<(PathBuf, Vec<String>)> {
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .join("packages/runtime/native");
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
    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_libs = stderr
        .lines()
        .find_map(|line| line.split("native-static-libs:").nth(1))
        .map(|list| list.split_whitespace().map(str::to_owned).collect())
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
