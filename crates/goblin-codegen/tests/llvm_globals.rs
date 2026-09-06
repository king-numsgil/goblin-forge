//! Module-level constants as data objects.
//!
//! GLOBALS-PLAN stage 1. The text is asserted rather than only "it compiled",
//! because the failure this emission can have is not a rejected module: the
//! frontend sends a flat list of leaves and the *type* says where each one lands,
//! so a walk that disagreed with `ty.rs` by one element would write a field's
//! bytes into the padding and clang would accept it.
//!
//! `PADDED` is the case that matters for that. Its struct has four bytes of
//! padding between the two fields, so the initialiser has to carry a padding
//! element the leaves do not correspond to — and if it did not, `b` would be
//! written where the padding is and read back as whatever the next four bytes
//! were.
//!
//! What is *not* here is a program that reads one of these and prints it. That
//! arrives in stage 2 as an ordinary harness test over real source, which is a
//! better version of the same check: real compiler, real binary, real output.

use std::path::PathBuf;

use goblin_codegen::abi::Conv;
use goblin_codegen::layout::TargetInfo;
use goblin_codegen::llvm::{self, driver};
use goblin_codegen::object::{CodegenOptions, OptLevel};
use goblin_mir::{
    Abi, Category, Const, ExternGlobal, FieldDef, Function, Global, GlobalId, GlobalInit, GlobalRef,
    Linkage, LocalDecl, LocalId, Module, Operand, Place, Projection, Rvalue, SigId, Signature, Span,
    Statement, StorageClass, StructDef, StructId, SymId, Terminator, TyDef, TyId, TyKind,
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
    let dir = std::env::temp_dir().join(format!("goblin-llvm-globals-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

/// A module of one global per initialiser shape, plus a function that reads one.
fn constants() -> Module {
    let mut module = Module {
        schema_fingerprint: 0,
        name: SymId(0),
        strings: vec!["constants".into()],
        files: Vec::new(),
        types: Vec::new(),
        structs: Vec::new(),
        classes: Vec::new(),
        interfaces: Vec::new(),
        sigs: Vec::new(),
        externs: Vec::new(),
        globals: Vec::new(),
        extern_globals: Vec::new(),
        funcs: Vec::new(),
    };

    let sym = |module: &mut Module, text: &str| -> SymId {
        let id = SymId(module.strings.len() as u32);
        module.strings.push(text.into());
        id
    };
    let ty = |module: &mut Module, kind: TyKind| -> TyId {
        let id = TyId(module.types.len() as u32);
        module.types.push(TyDef {
            kind,
            category: Category::Trivial,
        });
        id
    };

    let void = ty(&mut module, TyKind::Void);
    let i32_ = ty(&mut module, TyKind::Int(goblin_mir::IntTy::I32));
    let i64_ = ty(&mut module, TyKind::Int(goblin_mir::IntTy::I64));
    let f64_ = ty(&mut module, TyKind::Float(goblin_mir::FloatTy::F64));

    // `{ i32, f64 }`: the field offsets are 0 and 8, so there are four bytes of
    // padding in the middle that no leaf corresponds to.
    let point = sym(&mut module, "P");
    let a = sym(&mut module, "a");
    let b = sym(&mut module, "b");
    module.structs.push(StructDef {
        name: point,
        fields: vec![
            FieldDef {
                name: a,
                ty: i32_,
                span: Span::SYNTHETIC,
            },
            FieldDef {
                name: b,
                ty: f64_,
                span: Span::SYNTHETIC,
            },
        ],
        c_compatible: true,
        union: false,
        span: Span::SYNTHETIC,
    });
    let p = ty(&mut module, TyKind::Struct(StructId(0)));
    let table_ty = ty(
        &mut module,
        TyKind::FixedArray {
            element: i32_,
            length: 3,
        },
    );
    let table_ptr = ty(&mut module, TyKind::Pointer(table_ty));

    let int = |bits: u64, ty: TyId| GlobalInit::Scalar(Const::Int { bits, ty });

    push_global(
        &mut module,
        "LIMIT",
        i32_,
        vec![int(7, i32_)],
        Linkage::Internal,
        false,
    );
    push_global(
        &mut module,
        "SHARED",
        i32_,
        vec![int(1, i32_)],
        Linkage::Export,
        false,
    );
    // Nothing produces a mutable global from source — a top-level `let` is
    // refused — and the flag is honoured rather than asserted, so this is the
    // only place that says what it renders as.
    push_global(
        &mut module,
        "COUNTER",
        i32_,
        vec![int(9, i32_)],
        Linkage::Internal,
        true,
    );
    let table = push_global(
        &mut module,
        "TABLE",
        table_ty,
        vec![int(1, i32_), int(2, i32_), int(3, i32_)],
        Linkage::Internal,
        false,
    );
    push_global(
        &mut module,
        "PADDED",
        p,
        vec![
            int(5, i32_),
            GlobalInit::Scalar(Const::Float {
                bits: 1.5f64.to_bits(),
                ty: f64_,
            }),
        ],
        Linkage::Internal,
        false,
    );
    // One leaf for a whole struct: what keeps a zeroed table one entry on the
    // wire rather than one per element.
    push_global(
        &mut module,
        "BLANK",
        p,
        vec![GlobalInit::Zero],
        Linkage::Internal,
        false,
    );
    push_global(
        &mut module,
        "STRIDE",
        i64_,
        vec![GlobalInit::SizeOf(p)],
        Linkage::Internal,
        false,
    );
    push_global(
        &mut module,
        "ALIGNMENT",
        i64_,
        vec![GlobalInit::AlignOf(p)],
        Linkage::Internal,
        false,
    );

    let other = SymId(module.strings.len() as u32);
    module.strings.push("OTHER".into());
    module.extern_globals.push(ExternGlobal {
        name: other,
        ty: i32_,
        span: Span::SYNTHETIC,
    });

    // `read()` returns `TABLE[2]`: the address as a constant, then a `Deref` and
    // an index, which is the whole mechanism for reading a global.
    let read = SymId(module.strings.len() as u32);
    module.strings.push("read".into());
    module.sigs.push(Signature {
        params: Vec::new(),
        ret: i32_,
        abi: Abi::Internal,
        variadic: false,
    });
    module.funcs.push(Function {
        name: read,
        sig: SigId(0),
        linkage: Linkage::Export,
        locals: vec![
            LocalDecl {
                ty: i32_,
                storage: StorageClass::Owned,
                name: None,
                span: Span::SYNTHETIC,
            },
            LocalDecl {
                ty: table_ptr,
                storage: StorageClass::Temporary,
                name: None,
                span: Span::SYNTHETIC,
            },
        ],
        blocks: vec![goblin_mir::Block {
            kind: goblin_mir::BlockKind::Normal,
            statements: vec![
                Statement::Init {
                    place: Place::local(LocalId(1)),
                    rvalue: Rvalue::Use(Operand::Const(Const::Global {
                        global: GlobalRef::Local(table),
                        ty: table_ptr,
                    })),
                },
                Statement::Init {
                    place: Place::local(LocalId(0)),
                    rvalue: Rvalue::Use(Operand::Copy(Place {
                        local: LocalId(1),
                        projection: vec![Projection::Deref, Projection::ConstIndex(2)],
                    })),
                },
            ],
            terminator: Terminator::Return,
        }],
        span: Span::SYNTHETIC,
    });
    let _ = void;

    module
}

fn push_global(
    module: &mut Module,
    name: &str,
    ty: TyId,
    init: Vec<GlobalInit>,
    linkage: Linkage,
    mutable: bool,
) -> GlobalId {
    let name = {
        let id = SymId(module.strings.len() as u32);
        module.strings.push(name.into());
        id
    };
    let id = GlobalId(module.globals.len() as u32);
    module.globals.push(Global {
        name,
        ty,
        linkage,
        mutable,
        init,
        span: Span::SYNTHETIC,
    });
    id
}

fn line_for<'a>(text: &'a str, symbol: &str) -> &'a str {
    let needle = format!("@{symbol} = ");
    text.lines()
        .find(|line| line.starts_with(&needle))
        .unwrap_or_else(|| panic!("`{symbol}` was not emitted:\n{text}"))
}

#[test]
fn each_initialiser_shape_renders() {
    let module = constants();
    let emitted = llvm::emit_module(&module, TARGET, Conv::Win64, false, true)
        .expect("the constants render");

    assert_eq!(
        line_for(&emitted.text, "LIMIT"),
        "@LIMIT = internal constant i32 7, align 4"
    );
    // Exported, so no `internal`: the linker has to be able to see it.
    assert_eq!(
        line_for(&emitted.text, "SHARED"),
        "@SHARED = constant i32 1, align 4"
    );
    // `global` and not `constant`, which is what keeps it out of `.rodata`.
    assert_eq!(
        line_for(&emitted.text, "COUNTER"),
        "@COUNTER = internal global i32 9, align 4"
    );
    assert_eq!(
        line_for(&emitted.text, "TABLE"),
        "@TABLE = internal constant [3 x i32] [i32 1, i32 2, i32 3], align 4"
    );
    // The padding element carries no leaf, and the second field is *after* it.
    // Getting this wrong puts `b`'s bytes at offset 4 and compiles cleanly.
    assert_eq!(
        line_for(&emitted.text, "PADDED"),
        "@PADDED = internal constant %struct.P \
         <{ i32 5, [4 x i8] zeroinitializer, double 0x3FF8000000000000 }>, align 8"
    );
    assert_eq!(
        line_for(&emitted.text, "BLANK"),
        "@BLANK = internal constant %struct.P zeroinitializer, align 8"
    );
    // Resolved here rather than in the frontend, which has no layout at all.
    assert_eq!(
        line_for(&emitted.text, "STRIDE"),
        "@STRIDE = internal constant i64 16, align 8"
    );
    assert_eq!(
        line_for(&emitted.text, "ALIGNMENT"),
        "@ALIGNMENT = internal constant i64 8, align 8"
    );
    // An imported one is a declaration and nothing else. `global` rather than
    // `constant` deliberately: this side cannot check the promise.
    assert_eq!(
        line_for(&emitted.text, "OTHER"),
        "@OTHER = external global i32"
    );
}

#[test]
fn an_exported_global_is_defined_and_an_imported_one_is_required() {
    let module = constants();
    let emitted = llvm::emit_module(&module, TARGET, Conv::Win64, false, true)
        .expect("the constants render");

    assert!(
        emitted.defines.contains(&"SHARED".to_owned()),
        "{:?}",
        emitted.defines
    );
    // Internal ones are not the linker's business.
    assert!(
        !emitted.defines.contains(&"LIMIT".to_owned()),
        "{:?}",
        emitted.defines
    );
    assert!(
        emitted.requires.contains(&"OTHER".to_owned()),
        "{:?}",
        emitted.requires
    );
}

#[test]
fn reading_a_global_addresses_it_rather_than_copying_it() {
    let module = constants();
    let emitted = llvm::emit_module(&module, TARGET, Conv::Win64, false, true)
        .expect("the constants render");

    let body = emitted
        .text
        .split("define ")
        .nth(1)
        .expect("a function body");
    // The symbol is the address — opaque pointers mean there is no instruction
    // between naming a global and indexing it.
    assert!(body.contains("@TABLE"), "{body}");
    // And the table is not copied to the stack to be read.
    assert!(!body.contains("alloca [3 x i32]"), "{body}");
}

#[test]
fn clang_accepts_the_data_on_both_targets() {
    let module = constants();
    for (conv, windows, triple) in [
        (Conv::Win64, true, "x86_64-pc-windows-msvc"),
        (Conv::SysV, false, "x86_64-unknown-linux-gnu"),
    ] {
        let emitted = llvm::emit_module(&module, TARGET, conv, false, windows)
            .expect("the constants render");
        let mut options = options();
        options.target = Some(triple.to_owned());
        let object = scratch().join(format!("constants-{triple}.obj"));
        driver::compile(&emitted.text, &options, &object).unwrap_or_else(|error| {
            panic!(
                "clang rejected the constants for {triple}:\n{error}\n\n{}",
                emitted.text
            )
        });
    }
}

/// The check the flat leaf list makes necessary.
///
/// The frontend decides how many leaves a type takes and nothing in the encoding
/// says whether it got that right, so both directions are checked here. Each one
/// **panics** rather than returning a diagnostic, which is the house rule: a
/// backend that returned an error here would let a test mistake a compiler bug
/// for the compiler correctly rejecting a program.
#[test]
fn a_leaf_count_that_does_not_match_the_type_panics() {
    let too_many = {
        let mut module = constants();
        let ty = module.globals[0].ty;
        module.globals[0]
            .init
            .push(GlobalInit::Scalar(Const::Int { bits: 1, ty }));
        module
    };
    assert!(
        panic_message(&too_many).contains("leaves and its type takes"),
        "{}",
        panic_message(&too_many)
    );

    let too_few = {
        let mut module = constants();
        // `PADDED` takes two, one per field.
        let padded = module
            .globals
            .iter_mut()
            .find(|g| g.init.len() == 2)
            .expect("the padded struct");
        padded.init.pop();
        module
    };
    assert!(
        panic_message(&too_few).contains("ran out of leaves"),
        "{}",
        panic_message(&too_few)
    );
}

/// Emit a module that is expected to panic, and hand back what it said.
///
/// The hook is silenced around the call because the message is the assertion
/// rather than something to read in the log — a passing test that prints a
/// compiler-bug panic is a test nobody trusts.
fn panic_message(module: &Module) -> String {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let result = std::panic::catch_unwind(|| {
        let _ = llvm::emit_module(module, TARGET, Conv::Win64, false, true);
    });
    std::panic::set_hook(previous);

    let Err(payload) = result else {
        panic!("the module was accepted and should not have been");
    };
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|text| (*text).to_owned()))
        .unwrap_or_else(|| "a panic with no message".to_owned())
}
