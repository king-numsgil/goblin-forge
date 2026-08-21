//! The C ABI, checked against clang rather than against the psABI.
//!
//! REWRITE-PLAN §6: "the classification is the part of a compiler where 'looks
//! right' is worth nothing." The end-to-end suite already checks this against a
//! real C compiler, but only for the platform it happens to be running on.
//! This checks **both conventions from whichever machine is building**, by
//! asking clang what it would do and requiring `abi.rs` plus the LLVM signature
//! writer to agree.
//!
//! DECISIONS §17 is why it exists at all. Cranelift's failure mode for a bad
//! signature is a verifier error or a panic; LLVM's is a program that links,
//! runs, and is wrong. This is the cheapest available defence against that, and
//! it is deliberately built *before* the code it protects (LLVM-PORT stage 1,
//! guarding stage 4).
//!
//! ## What is compared, and what is not
//!
//! Not the text. Our carriers are deliberately coarser than clang's — see
//! `abi::Slot::Registers` — so requiring `(i64, i32)` where we say `[I64, I64]`
//! would fail on a difference that does not exist in the registers. What is
//! compared is the **class** of each argument: which register file it lands in,
//! or whether it travels as a pointer, a `byval` copy, or a hidden return
//! slot. That is exactly the set of decisions `abi.rs` makes, and exactly the
//! set whose failure mode is silent.

use std::process::Command;

use goblin_codegen::abi::Conv;
use goblin_codegen::layout::{Layouts, TargetInfo};
use goblin_codegen::llvm::sig;
use goblin_codegen::llvm::ty::Types;
use goblin_mir::{
    Abi, Category, FieldDef, FloatTy, IntTy, Module, Param, Signature, Span, StructDef, StructId,
    SymId, TyDef, TyId, TyKind,
};

const WINDOWS: &str = "x86_64-pc-windows-msvc";
const LINUX: &str = "x86_64-unknown-linux-gnu";

/// How one argument or result travels, coarsely enough to be comparable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    /// A general-purpose register.
    IntReg,
    /// An SSE register.
    SseReg,
    /// A pointer the caller supplies, having made the copy itself.
    Pointer,
    /// A pointer LLVM copies from, under System V's MEMORY rules.
    ByVal,
    /// The hidden return slot.
    Sret,
}

// -- the fixtures -----------------------------------------------------------

/// A shape, written twice: once in C for clang, once in MIR for us.
///
/// The same discipline as `tests/oracle/` — the point of a differential test is
/// that the two halves are written independently, so a misunderstanding has to
/// occur twice in the same direction to go unnoticed.
struct Case {
    name: &'static str,
    /// The C definition, including the trailing semicolon.
    c: &'static str,
    /// Field types, as indices into the fixture's scalar table.
    fields: &'static [Scalar],
    /// Every member at offset zero, sized to the largest.
    union: bool,
}

#[derive(Clone, Copy)]
enum Scalar {
    I8,
    I32,
    I64,
    F32,
    F64,
    /// A nested aggregate: the case with this name, inlined as one field.
    Nest(&'static str),
    /// `char[N]`, for padding a union out to a size.
    Bytes(u64),
}

const CASES: &[Case] = &[
    Case {
        name: "One",
        c: "struct One { char a; };",
        fields: &[Scalar::I8],
        union: false,
    },
    Case {
        name: "Pair",
        c: "struct Pair { int a; int b; };",
        fields: &[Scalar::I32, Scalar::I32],
        union: false,
    },
    Case {
        name: "TwoFloats",
        c: "struct TwoFloats { float a; float b; };",
        fields: &[Scalar::F32, Scalar::F32],
        union: false,
    },
    Case {
        name: "IntFloat",
        c: "struct IntFloat { int a; float b; };",
        fields: &[Scalar::I32, Scalar::F32],
        union: false,
    },
    Case {
        name: "Twelve",
        c: "struct Twelve { int a; int b; int c; };",
        fields: &[Scalar::I32, Scalar::I32, Scalar::I32],
        union: false,
    },
    Case {
        name: "TwoDoubles",
        c: "struct TwoDoubles { double a; double b; };",
        fields: &[Scalar::F64, Scalar::F64],
        union: false,
    },
    Case {
        name: "Mixed",
        c: "struct Mixed { long long a; double b; };",
        fields: &[Scalar::I64, Scalar::F64],
        union: false,
    },
    Case {
        name: "Big",
        c: "struct Big { long long a; long long b; long long c; };",
        fields: &[Scalar::I64, Scalar::I64, Scalar::I64],
        union: false,
    },
    Case {
        name: "Nine",
        c: "struct Nine { long long a; char b; };",
        fields: &[Scalar::I64, Scalar::I8],
        union: false,
    },
    Case {
        name: "ThreeFloats",
        c: "struct ThreeFloats { float a; float b; float c; };",
        fields: &[Scalar::F32, Scalar::F32, Scalar::F32],
        union: false,
    },
    Case {
        name: "DoubleFloat",
        c: "struct DoubleFloat { double a; float b; };",
        fields: &[Scalar::F64, Scalar::F32],
        union: false,
    },
    Case {
        name: "Nested",
        c: "struct Nested { struct TwoFloats inner; };",
        fields: &[Scalar::Nest("TwoFloats")],
        union: false,
    },
    // Unions are not a corner: `SDL_Event` is one, and a union's eightbyte is
    // classified by merging every member that overlaps it, so one integer
    // member anywhere makes the whole eightbyte INTEGER even when the largest
    // member is a double.
    Case {
        name: "SmallUnion",
        c: "union SmallUnion { char a; double b; };",
        fields: &[Scalar::I8, Scalar::F64],
        union: true,
    },
    Case {
        name: "FloatUnion",
        c: "union FloatUnion { float a; float b; };",
        fields: &[Scalar::F32, Scalar::F32],
        union: true,
    },
    Case {
        name: "BigUnion",
        c: "union BigUnion { double a; char b[24]; };",
        fields: &[Scalar::F64, Scalar::Bytes(24)],
        union: true,
    },
];

/// A MIR module holding every case's struct, so nesting can refer by name.
struct Fixture {
    module: Module,
    scalars: [TyId; 5],
    structs: Vec<(&'static str, TyId)>,
}

impl Fixture {
    fn build() -> Fixture {
        let mut module = Module {
            schema_fingerprint: 0,
            name: SymId(0),
            strings: vec!["oracle".into()],
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
            TyKind::Int(IntTy::I8),
            TyKind::Int(IntTy::I32),
            TyKind::Int(IntTy::I64),
            TyKind::Float(FloatTy::F32),
            TyKind::Float(FloatTy::F64),
            TyKind::Void,
        ] {
            module.types.push(TyDef {
                kind,
                category: Category::Trivial,
            });
        }
        let scalars = [TyId(0), TyId(1), TyId(2), TyId(3), TyId(4)];

        let mut fixture = Fixture {
            module,
            scalars,
            structs: Vec::new(),
        };
        for case in CASES {
            let ty = fixture.declare(case);
            fixture.structs.push((case.name, ty));
        }
        fixture
    }

    fn scalar(&mut self, scalar: Scalar) -> TyId {
        match scalar {
            Scalar::I8 => self.scalars[0],
            Scalar::I32 => self.scalars[1],
            Scalar::I64 => self.scalars[2],
            Scalar::F32 => self.scalars[3],
            Scalar::F64 => self.scalars[4],
            Scalar::Nest(name) => self.named(name),
            Scalar::Bytes(length) => {
                let element = self.scalars[0];
                self.module.types.push(TyDef {
                    kind: TyKind::FixedArray { element, length },
                    category: Category::Trivial,
                });
                TyId(self.module.types.len() as u32 - 1)
            }
        }
    }

    fn named(&self, name: &str) -> TyId {
        self.structs
            .iter()
            .find(|(candidate, _)| *candidate == name)
            .map(|(_, ty)| *ty)
            .unwrap_or_else(|| panic!("`{name}` must be declared before it is nested"))
    }

    fn declare(&mut self, case: &Case) -> TyId {
        let mut field_types = Vec::with_capacity(case.fields.len());
        for field in case.fields {
            field_types.push(self.scalar(*field));
        }
        let id = StructId(self.module.structs.len() as u32);
        let name = SymId(self.module.strings.len() as u32);
        self.module.strings.push(case.name.into());
        self.module.structs.push(StructDef {
            name,
            fields: field_types
                .iter()
                .map(|ty| FieldDef {
                    name,
                    ty: *ty,
                    span: Span::SYNTHETIC,
                })
                .collect(),
            c_compatible: true,
            union: case.union,
            span: Span::SYNTHETIC,
        });
        self.module.types.push(TyDef {
            kind: TyKind::Struct(id),
            category: Category::Trivial,
        });
        TyId(self.module.types.len() as u32 - 1)
    }

    /// What this compiler says, as classes.
    fn ours(&self, ty: TyId, conv: Conv, position: Position) -> Vec<Class> {
        let target = TargetInfo::from_pointer_bits(64);
        let mut layouts = Layouts::new(&self.module, target);
        let mut types = Types::new();

        let signature = match position {
            Position::Param => Signature {
                params: vec![Param { ty, name: None }],
                ret: void_ty(&self.module),
                abi: Abi::C,
                variadic: false,
            },
            Position::Return => Signature {
                params: Vec::new(),
                ret: ty,
                abi: Abi::C,
                variadic: false,
            },
        };

        let rendered = sig::render(&mut types, &mut layouts, &signature, conv)
            .expect("the fixture classifies");
        let mut out = Vec::new();
        for param in &rendered.params {
            out.push(classify_text(param));
        }
        out.extend(classify_return(&rendered.returns));
        out
    }
}

/// The `void` type, appended once and reused.
fn void_ty(module: &Module) -> TyId {
    module
        .types
        .iter()
        .position(|def| def.kind == TyKind::Void)
        .map(|index| TyId(index as u32))
        .expect("the fixture has a void type")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Position {
    Param,
    Return,
}

// -- reading LLVM type text -------------------------------------------------

/// Tokens that appear before a type and are not one.
const ATTRIBUTES: &[&str] = &[
    "dso_local",
    "local_unnamed_addr",
    "noundef",
    "signext",
    "zeroext",
    "nonnull",
    "writable",
    "dead_on_unwind",
    "dead_on_return",
    "immarg",
    "returned",
    "inreg",
    "align",
    "captures(none)",
    "readonly",
    "writeonly",
    "noalias",
    "nocapture",
];

/// Split on commas that are not inside brackets of any kind.
fn split_top_level(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for ch in text.chars() {
        match ch {
            '(' | '[' | '{' | '<' => {
                depth += 1;
                current.push(ch);
            }
            ')' | ']' | '}' | '>' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                out.push(current.trim().to_owned());
                current = String::new();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_owned());
    }
    out
}

/// The class of one parameter, from its LLVM text.
///
/// The same function reads clang's output and ours, which is deliberate: two
/// readers would be two places for a misreading to hide. It is pinned by
/// `the_reader_reads_what_it_claims` below.
fn classify_text(text: &str) -> Class {
    if text.contains("sret(") {
        return Class::Sret;
    }
    if text.contains("byval(") {
        return Class::ByVal;
    }
    let head = strip_attributes(text);
    if head.starts_with("ptr") {
        return Class::Pointer;
    }
    if head.starts_with("float") || head.starts_with("double") {
        return Class::SseReg;
    }
    // `<2 x float>`, `<4 x double>` — a vector of floats is still SSE.
    if head.starts_with('<') && (head.contains("float") || head.contains("double")) {
        return Class::SseReg;
    }
    Class::IntReg
}

/// The classes a return type accounts for. `void` accounts for none.
fn classify_return(text: &str) -> Vec<Class> {
    let head = strip_attributes(text);
    if head == "void" || head.is_empty() {
        return Vec::new();
    }
    // A multi-register return is an anonymous struct: `{ i64, i32 }`.
    if let Some(inner) = head.strip_prefix('{').and_then(|t| t.strip_suffix('}')) {
        return split_top_level(inner)
            .iter()
            .map(|part| classify_text(part))
            .collect();
    }
    vec![classify_text(&head)]
}

fn strip_attributes(text: &str) -> String {
    let mut rest = text.trim();
    loop {
        let mut advanced = false;
        for attribute in ATTRIBUTES {
            if let Some(tail) = rest.strip_prefix(attribute) {
                // `align 8` carries a number; every other attribute is a word.
                let tail = tail.trim_start();
                let tail = if *attribute == "align" {
                    tail.trim_start_matches(|c: char| c.is_ascii_digit())
                } else {
                    tail
                };
                if tail.len() != rest.len() {
                    rest = tail.trim_start();
                    advanced = true;
                    break;
                }
            }
        }
        if !advanced {
            return rest.to_owned();
        }
    }
}

// -- asking clang -----------------------------------------------------------

fn clang() -> String {
    std::env::var("GOBLIN_CLANG").unwrap_or_else(|_| "clang".to_owned())
}

/// Compile a C translation unit to LLVM IR and hand back the text.
fn emit_llvm(source: &str, triple: &str) -> String {
    let dir = std::env::temp_dir().join(format!(
        "goblin-abi-oracle-{}-{}",
        std::process::id(),
        triple
    ));
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let path = dir.join("case.c");
    std::fs::write(&path, source).expect("writing the case");

    let output = Command::new(clang())
        .arg("-S")
        .arg("-emit-llvm")
        .arg(&path)
        .arg("-o")
        .arg("-")
        .arg(format!("--target={triple}"))
        .arg("-O0")
        .arg("-march=x86-64-v3")
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "the ABI oracle needs clang on PATH, or `GOBLIN_CLANG` pointing at \
                 one — the LLVM backend cannot be checked without it: {error}"
            )
        });

    assert!(
        output.status.success(),
        "clang rejected the oracle's own C:\n{}\n{source}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// The parameter list and return type of one `declare` line.
fn declaration(ir: &str, symbol: &str) -> (String, Vec<String>) {
    let needle = format!("@{symbol}(");
    let line = ir
        .lines()
        .find(|line| line.starts_with("declare") && line.contains(&needle))
        .unwrap_or_else(|| panic!("clang did not declare `{symbol}`:\n{ir}"));

    let returns = line["declare".len()..]
        .split(&needle)
        .next()
        .unwrap_or("")
        .trim()
        .to_owned();

    let open = line.find(&needle).expect("the needle was found above") + needle.len();
    let mut depth = 1i32;
    let mut close = open;
    for (index, ch) in line[open..].char_indices() {
        match ch {
            '(' | '[' | '{' | '<' => depth += 1,
            ')' | ']' | '}' | '>' => {
                depth -= 1;
                if depth == 0 {
                    close = open + index;
                    break;
                }
            }
            _ => {}
        }
    }
    let _ = ir;
    (returns, split_top_level(&line[open..close]))
}

/// What clang says, as classes.
fn theirs(case: &Case, position: Position, triple: &str) -> Vec<Class> {
    // Every case's struct is defined, so a nested one resolves regardless of
    // which case is under test.
    let mut source = String::new();
    for other in CASES {
        source.push_str(other.c);
        source.push('\n');
    }
    let name = case.name;
    let keyword = if case.union { "union" } else { "struct" };
    match position {
        Position::Param => {
            source.push_str(&format!("void gf_probe({keyword} {name} p);\n"));
            source.push_str(&format!(
                "void call(void){{ {keyword} {name} v; gf_probe(v); }}\n"
            ));
        }
        Position::Return => {
            source.push_str(&format!("{keyword} {name} gf_probe(void);\n"));
            source.push_str("void call(void){ gf_probe(); }\n");
        }
    }

    let ir = emit_llvm(&source, triple);
    let (returns, params) = declaration(&ir, "gf_probe");
    let mut out: Vec<Class> = params.iter().map(|p| classify_text(p)).collect();
    out.extend(classify_return(&returns));
    out
}

// -- the tests --------------------------------------------------------------

#[test]
fn the_reader_reads_what_it_claims() {
    // The one function both halves go through, pinned against text taken from
    // real clang output. A bug here would hide a difference symmetrically,
    // which is the only way this suite can lie.
    assert_eq!(
        classify_text("ptr dead_on_unwind writable sret(%struct.Twelve) align 4"),
        Class::Sret
    );
    assert_eq!(
        classify_text("ptr noundef byval(%struct.Big) align 8"),
        Class::ByVal
    );
    assert_eq!(classify_text("ptr dead_on_return noundef"), Class::Pointer);
    assert_eq!(classify_text("i64"), Class::IntReg);
    assert_eq!(classify_text("zeroext i8"), Class::IntReg);
    assert_eq!(classify_text("double"), Class::SseReg);
    assert_eq!(classify_text("<2 x float>"), Class::SseReg);
    assert_eq!(classify_return("void"), Vec::new());
    assert_eq!(
        classify_return("{ i64, i32 }"),
        vec![Class::IntReg, Class::IntReg]
    );
    assert_eq!(
        split_top_level("i64, ptr byval(%struct.Big) align 8, <2 x float>").len(),
        3
    );
}

#[test]
fn win64_agrees_with_clang() {
    check(Conv::Win64, WINDOWS);
}

#[test]
fn system_v_agrees_with_clang() {
    check(Conv::SysV, LINUX);
}

fn check(conv: Conv, triple: &str) {
    let fixture = Fixture::build();
    let mut failures = Vec::new();

    for case in CASES {
        for position in [Position::Param, Position::Return] {
            let ty = fixture.named(case.name);
            let ours = fixture.ours(ty, conv, position);
            let theirs = theirs(case, position, triple);
            if ours != theirs {
                failures.push(format!(
                    "  {} as {:?}: we say {:?}, clang says {:?}",
                    case.name, position, ours, theirs
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "the classification disagrees with clang for {triple}:\n{}",
        failures.join("\n")
    );
}
