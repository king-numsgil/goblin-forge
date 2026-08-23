//! Vector arithmetic, from MIR nodes to a program that prints a number.
//!
//! DECISIONS §22. Two things are under test and they fail differently:
//!
//! * **The text**, for the shapes where the interesting choice is visible: a
//!   packed `dvec3` is `<3 x double>` and a padded one is `<4 x double>`, and
//!   both carry the *struct's* alignment rather than the vector's. An assertion
//!   on the IR is the only thing that notices when a load starts claiming
//!   `align 32` on memory that is only 8-aligned, because the program keeps
//!   working right up until the allocation that is not lucky.
//! * **The arithmetic, at run time**, by building a program that does a dot
//!   product the long way — load, multiply, shuffle, add, extract — and exits
//!   with the answer. Reading the IR would not have said whether the shuffle
//!   mask indexes the concatenation the way this file believes it does.
//!
//! The MIR is hand-built. That is the point: the frontend is not involved, so a
//! failure here is the backend's and nothing else's.

use std::path::PathBuf;
use std::process::Command;

use goblin_codegen::abi::Conv;
use goblin_codegen::layout::TargetInfo;
use goblin_codegen::link::{LinkRequest, OutputKind, link};
use goblin_codegen::llvm::{self, driver};
use goblin_codegen::object::{CodegenOptions, OptLevel};
use goblin_mir::{
    Abi, Block, BlockKind, Category, FieldDef, FloatTy, Function, IntTy, Linkage, LocalDecl,
    LocalId, Module, Operand, Place, Rvalue, SigId, Signature, SimdBinOp, Span, StorageClass,
    StructDef, StructId, SymId, Terminator, TyDef, TyId, TyKind,
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
    let dir = std::env::temp_dir().join(format!("goblin-llvm-simd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

/// Type ids in the module every test here builds from.
mod ty {
    use goblin_mir::TyId;

    pub const I32: TyId = TyId(1);
    pub const F64: TyId = TyId(2);
    /// `dvec3` — three `f64`, 24 bytes, packed.
    pub const VEC3: TyId = TyId(3);
    /// `aligned_dvec3` — four `f64`, 32 bytes.
    pub const VEC3A: TyId = TyId(4);
    /// `<3 x double>`, the arithmetic form of a `dvec3`.
    pub const SIMD3: TyId = TyId(5);
    /// `<4 x double>`, the arithmetic form of an `aligned_dvec3`.
    pub const SIMD4: TyId = TyId(6);
}

/// A module holding both vector shapes and nothing else.
fn base() -> Module {
    let mut module = Module {
        schema_fingerprint: 0,
        name: SymId(0),
        strings: vec!["simd".into()],
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

    let trivial = |kind| TyDef {
        kind,
        category: Category::Trivial,
    };
    module.types.push(trivial(TyKind::Void));
    module.types.push(trivial(TyKind::Int(IntTy::I32)));
    module.types.push(trivial(TyKind::Float(FloatTy::F64)));
    module.types.push(trivial(TyKind::Struct(StructId(0))));
    module.types.push(trivial(TyKind::Struct(StructId(1))));
    module.types.push(trivial(TyKind::Simd {
        elem: FloatTy::F64,
        lanes: 3,
    }));
    module.types.push(trivial(TyKind::Simd {
        elem: FloatTy::F64,
        lanes: 4,
    }));

    let sym = |module: &mut Module, text: &str| -> SymId {
        let id = SymId(module.strings.len() as u32);
        module.strings.push(text.into());
        id
    };

    // The padded type's fourth lane is a real field with a name nobody writes,
    // because a struct is the only thing this compiler lays out and padding
    // that is not a field is padding the layout engine would drop.
    for (name, lanes) in [("dvec3", 3usize), ("aligned_dvec3", 4)] {
        let struct_name = sym(&mut module, name);
        let fields = ["x", "y", "z", "_w"][..lanes]
            .iter()
            .map(|field| FieldDef {
                name: sym(&mut module, field),
                ty: ty::F64,
                span: Span::SYNTHETIC,
            })
            .collect();
        module.structs.push(StructDef {
            name: struct_name,
            fields,
            c_compatible: true,
            union: false,
            span: Span::SYNTHETIC,
        });
    }

    module.sigs.push(Signature {
        params: Vec::new(),
        ret: ty::I32,
        abi: Abi::C,
        variadic: false,
    });
    module
}

fn float(value: f64) -> Operand {
    Operand::Const(goblin_mir::Const::Float {
        bits: value.to_bits(),
        ty: ty::F64,
    })
}

fn local(index: u32) -> Place {
    Place::local(LocalId(index))
}

/// `main`, built from a list of statements, returning local 0.
fn program(module: &mut Module, locals: Vec<LocalDecl>, statements: Vec<goblin_mir::Statement>) {
    let name = SymId(module.strings.len() as u32);
    module.strings.push("main".into());
    module.funcs.push(Function {
        name,
        sig: SigId(0),
        linkage: Linkage::Export,
        locals,
        blocks: vec![Block {
            kind: BlockKind::Normal,
            statements,
            terminator: Terminator::Return,
        }],
        span: Span::SYNTHETIC,
    });
}

fn slot(ty: TyId) -> LocalDecl {
    LocalDecl {
        ty,
        storage: StorageClass::Owned,
        name: None,
        span: Span::SYNTHETIC,
    }
}

/// Build both vectors, add them, and store the result back.
///
/// One function per shape, so the IR for the packed and the padded case can be
/// compared side by side — which is the whole of what `aligned_` buys.
fn add_module(struct_ty: TyId, simd_ty: TyId, lanes: usize) -> Module {
    let mut module = base();
    let locals = vec![
        slot(ty::I32),    // _0: the return place
        slot(struct_ty),  // _1: a
        slot(struct_ty),  // _2: b
        slot(struct_ty),  // _3: the result
        slot(simd_ty),    // _4: a, loaded
        slot(simd_ty),    // _5: b, loaded
        slot(simd_ty),    // _6: the sum
    ];

    use goblin_mir::Statement::Init;
    let mut statements = Vec::new();
    for (index, base_value) in [(1u32, 1.0f64), (2, 10.0)] {
        statements.push(Init {
            place: local(index),
            rvalue: Rvalue::Aggregate {
                ty: struct_ty,
                fields: (0..lanes)
                    .map(|lane| float(base_value + lane as f64))
                    .collect(),
            },
        });
    }
    statements.push(Init {
        place: local(4),
        rvalue: Rvalue::SimdLoad {
            source: local(1),
            ty: simd_ty,
        },
    });
    statements.push(Init {
        place: local(5),
        rvalue: Rvalue::SimdLoad {
            source: local(2),
            ty: simd_ty,
        },
    });
    statements.push(Init {
        place: local(6),
        rvalue: Rvalue::SimdBinary {
            op: SimdBinOp::Add,
            lhs: Operand::Copy(local(4)),
            rhs: Operand::Copy(local(5)),
        },
    });
    statements.push(Init {
        place: local(3),
        rvalue: Rvalue::SimdStore {
            vector: Operand::Copy(local(6)),
        },
    });
    statements.push(Init {
        place: local(0),
        rvalue: Rvalue::Use(Operand::Const(goblin_mir::Const::Int {
            bits: 0,
            ty: ty::I32,
        })),
    });

    program(&mut module, locals, statements);
    module
}

#[test]
fn a_packed_vec3_is_three_lanes_and_carries_the_struct_alignment() {
    let module = add_module(ty::VEC3, ty::SIMD3, 3);
    let emitted =
        llvm::emit_module(&module, TARGET, Conv::Win64, false, true).expect("the module renders");

    // Three lanes, not four with one ignored: the packed layout is what a
    // vertex buffer holds, and widening it here would write past 24 bytes.
    assert!(
        emitted.text.contains("load <3 x double>"),
        "a packed `dvec3` loads three lanes:\n{}",
        emitted.text
    );
    assert!(
        emitted.text.contains("store <3 x double>"),
        "and stores three:\n{}",
        emitted.text
    );
    assert!(
        emitted.text.contains("fadd <3 x double>"),
        "and adds three:\n{}",
        emitted.text
    );

    // The alignment depends on *what is being addressed*, and the two answers
    // are both right:
    //
    // * against a `dvec3` — locals `_1`, `_2`, `_3` — it is the struct's 8. A
    //   `dvec3` is a struct of `f64` and nothing promised more, so claiming the
    //   32 LLVM would pick for a `<3 x double>` of its own accord is a promise
    //   about memory nobody made. That one is a real heap corruption, and it is
    //   latent until an allocation happens not to be lucky.
    // * against a vector local — `_4` onwards — it is the vector's 32, because
    //   that local really is an `alloca <3 x double>`.
    //
    // Asserting one rule over every line would have to pick one of those and be
    // wrong about the other half, so both are named.
    for (local, align) in [("%p1", 8), ("%p2", 8), ("%p3", 8), ("%p4", 32)] {
        let access = emitted
            .text
            .lines()
            .find(|line| line.contains("<3 x double>") && line.contains(&format!("ptr {local},")))
            .unwrap_or_else(|| panic!("no vector access against {local}:\n{}", emitted.text));
        assert!(
            access.trim_end().ends_with(&format!("align {align}")),
            "the access against {local} should be `align {align}`: {access}"
        );
    }
}

#[test]
fn a_padded_vec3_is_four_lanes() {
    let module = add_module(ty::VEC3A, ty::SIMD4, 4);
    let emitted =
        llvm::emit_module(&module, TARGET, Conv::Win64, false, true).expect("the module renders");

    assert!(
        emitted.text.contains("fadd <4 x double>"),
        "a padded `aligned_dvec3` adds four lanes in one instruction:\n{}",
        emitted.text
    );
    assert!(
        !emitted.text.contains("<3 x double>"),
        "and never mentions the packed shape:\n{}",
        emitted.text
    );
}

/// The shuffle-and-add tree a `dot` is built from, run for its answer.
///
/// `dot([1,2,3], [10,20,30])` is 140. The program exits with it, so a wrong
/// shuffle mask is a wrong exit code rather than something to spot by reading.
#[test]
fn a_dot_product_composed_from_primitives_computes_the_right_number() {
    let Some((runtime_lib, system_libs)) = runtime() else {
        eprintln!("no runtime library built; skipping the run");
        return;
    };

    let mut module = base();
    let locals = vec![
        slot(ty::I32),   // _0: the return place
        slot(ty::VEC3),  // _1: a
        slot(ty::VEC3),  // _2: b
        slot(ty::SIMD3), // _3: a, loaded
        slot(ty::SIMD3), // _4: b, loaded
        slot(ty::SIMD3), // _5: the elementwise product
        slot(ty::SIMD3), // _6: the product, rotated by one lane
        slot(ty::F64),   // _7..: the lanes, summed by hand
        slot(ty::F64),
        slot(ty::F64),
        slot(ty::F64),
    ];

    use goblin_mir::Statement::Init;
    let mut statements = vec![
        Init {
            place: local(1),
            rvalue: Rvalue::Aggregate {
                ty: ty::VEC3,
                fields: vec![float(1.0), float(2.0), float(3.0)],
            },
        },
        Init {
            place: local(2),
            rvalue: Rvalue::Aggregate {
                ty: ty::VEC3,
                fields: vec![float(10.0), float(20.0), float(30.0)],
            },
        },
        Init {
            place: local(3),
            rvalue: Rvalue::SimdLoad {
                source: local(1),
                ty: ty::SIMD3,
            },
        },
        Init {
            place: local(4),
            rvalue: Rvalue::SimdLoad {
                source: local(2),
                ty: ty::SIMD3,
            },
        },
        Init {
            place: local(5),
            rvalue: Rvalue::SimdBinary {
                op: SimdBinOp::Mul,
                lhs: Operand::Copy(local(3)),
                rhs: Operand::Copy(local(4)),
            },
        },
    ];

    // A shuffle whose mask reaches into the second operand, so that the
    // convention — indices name the concatenation of the two vectors — is
    // exercised rather than assumed. Lane 0 of the result is lane 1 of the
    // product; the rest are filled from the other operand and never read.
    statements.push(Init {
        place: local(6),
        rvalue: Rvalue::SimdShuffle {
            lhs: Operand::Copy(local(5)),
            rhs: Operand::Copy(local(5)),
            mask: vec![1, 3, 4],
            ty: ty::SIMD3,
        },
    });

    for (index, (vector, lane)) in [(5u32, 0u8), (6, 0), (5, 2)].iter().enumerate() {
        statements.push(Init {
            place: local(7 + index as u32),
            rvalue: Rvalue::SimdExtract {
                vector: Operand::Copy(local(*vector)),
                lane: *lane,
            },
        });
    }

    // 10 + 40 + 90.
    statements.push(Init {
        place: local(10),
        rvalue: Rvalue::Binary {
            op: goblin_mir::BinOp::Add,
            lhs: Operand::Copy(local(7)),
            rhs: Operand::Copy(local(8)),
        },
    });
    statements.push(goblin_mir::Statement::Assign {
        place: local(10),
        rvalue: Rvalue::Binary {
            op: goblin_mir::BinOp::Add,
            lhs: Operand::Copy(local(10)),
            rhs: Operand::Copy(local(9)),
        },
    });
    statements.push(Init {
        place: local(0),
        rvalue: Rvalue::Cast {
            op: goblin_mir::CastKind::FloatToInt,
            operand: Operand::Copy(local(10)),
            to: ty::I32,
        },
    });

    program(&mut module, locals, statements);

    let windows = cfg!(windows);
    let conv = if windows { Conv::Win64 } else { Conv::SysV };
    let emitted = llvm::emit_module(&module, TARGET, conv, false, windows).expect("it renders");

    let dir = scratch();
    let object = dir.join("dot.o");
    driver::compile(&emitted.text, &options(), &object)
        .unwrap_or_else(|error| panic!("clang rejected the IR: {error}\n\n{}", emitted.text));

    let exe = dir.join(if windows { "dot.exe" } else { "dot" });
    link(&LinkRequest {
        kind: OutputKind::Bin,
        objects: &[object],
        archives: &[runtime_lib],
        system_libs: &system_libs,
        output: &exe,
        exports: &[],
        rpath_origin: false,
    })
    .expect("the program links");

    let status = Command::new(&exe).status().expect("the program runs");
    assert_eq!(
        status.code(),
        Some(140),
        "dot([1,2,3], [10,20,30]) is 140; the IR was:\n{}",
        emitted.text
    );
}

/// The runtime staticlib, if a build has produced one.
fn runtime() -> Option<(PathBuf, Vec<String>)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .to_path_buf();
    let names = if cfg!(windows) {
        ["goblin_runtime.lib"]
    } else {
        ["libgoblin_runtime.a"]
    };
    for level in ["opt-0", "opt-1", "opt-2", "opt-3", "opt-s", "opt-z"] {
        for name in names {
            let candidate = root.join("target").join(level).join("release").join(name);
            if candidate.exists() {
                return Some((candidate, Vec::new()));
            }
        }
    }
    None
}
