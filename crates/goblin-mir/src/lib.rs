//! Goblin MIR: the intermediate representation that crosses the napi boundary.
//!
//! Defined here, in Rust, exactly once. The TypeScript frontend does not
//! declare a parallel copy of these types — it uses bindings generated from
//! them, encoder included. See [`schema`] for why the encoder has to be
//! generated too.
//!
//! The shape is rustc-flavoured MIR: a CFG of basic blocks over places and
//! rvalues, with copy, move, initialisation and destruction written down rather
//! than inferred. REWRITE-PLAN §4 states the semantic model, and §5 states this
//! IR; the two are meant to be read together, because the point of the IR is to
//! be incapable of expressing a program that violates the model.

pub mod bindings;
pub mod body;
pub mod ids;
pub mod module;
pub mod schema;
pub mod span;
pub mod ty;

pub use body::{
    AbortReason, BinOp, Block, BlockKind, CallDest, Callee, CastKind, Const, FuncRef, Function,
    Linkage, LocalDecl, Operand, Place, Projection, Rvalue, Statement, SwitchTarget, Terminator,
    UnOp, UnwindAction,
};
pub use ids::{
    BlockId, ClassId, ExternId, FieldId, FileId, FuncId, InterfaceId, LocalId, SigId, StructId,
    SymId, TyId,
};
pub use module::{ExternFunc, Global, Module};
pub use span::Span;
pub use ty::{
    Abi, Category, ClassDef, FieldDef, FloatTy, Impl, IntTy, InterfaceDef, InterfaceMethod, Param,
    Signature, StorageClass, StructDef, TyDef, TyKind,
};

/// Encode a module for the trip across the boundary.
pub fn encode(module: &Module) -> Result<Vec<u8>, postcard::Error> {
    postcard::to_stdvec(module)
}

/// Decode a module that arrived across the boundary.
pub fn decode(bytes: &[u8]) -> Result<Module, postcard::Error> {
    postcard::from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_names_are_unique() {
        schema::check_unique_names().unwrap();
    }

    #[test]
    fn the_graph_is_finite_and_reaches_the_leaves() {
        let names: Vec<_> = schema::types().into_iter().map(|t| t.name).collect();
        // Dependencies come before their users, so a leaf id type is first-ish
        // and `Module` is last.
        assert_eq!(names.last().map(String::as_str), Some("Module"));
        for expected in [
            "Place",
            "Rvalue",
            "Statement",
            "Terminator",
            "TyKind",
            "UnwindAction",
        ] {
            assert!(
                names.iter().any(|n| n == expected),
                "missing `{expected}` in {names:?}"
            );
        }
    }

    #[test]
    fn the_fingerprint_is_stable_within_a_build() {
        assert_eq!(schema::fingerprint(), schema::fingerprint());
        assert_ne!(schema::fingerprint(), 0);
    }

    /// The generated bindings are checked in, so they can go stale the moment
    /// somebody edits a type in this crate and does not rebuild the addon. The
    /// build script regenerates them, but a build script only helps the person
    /// who runs it — this makes the staleness a test failure instead.
    #[test]
    fn the_checked_in_bindings_are_current() {
        let path = bindings::repo_root().join(bindings::OUTPUT_PATH);
        let on_disk = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()));
        assert_eq!(
            on_disk,
            bindings::generate(),
            "{} is out of date. Run `cargo run -p goblin-mir --bin gen-bindings`, \
             then rebuild the addon so the two agree on the wire format.",
            path.display(),
        );
    }

    #[test]
    fn a_module_survives_a_rust_side_round_trip() {
        let module = Module {
            schema_fingerprint: schema::fingerprint(),
            name: SymId(0),
            strings: vec!["demo".into(), "main".into()],
            files: vec!["main.ts".into()],
            types: vec![TyDef {
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
            funcs: vec![Function {
                name: SymId(1),
                sig: SigId(0),
                linkage: Linkage::Export,
                locals: vec![LocalDecl {
                    ty: TyId(0),
                    storage: StorageClass::Owned,
                    name: None,
                    span: Span::SYNTHETIC,
                }],
                blocks: vec![Block {
                    kind: BlockKind::Normal,
                    statements: vec![Statement::Init {
                        place: Place::local(LocalId::RETURN),
                        rvalue: Rvalue::Use(Operand::Const(Const::Int {
                            bits: 42,
                            ty: TyId(0),
                        })),
                    }],
                    terminator: Terminator::Return,
                }],
                span: Span::SYNTHETIC,
            }],
        };

        let bytes = encode(&module).unwrap();
        assert_eq!(decode(&bytes).unwrap(), module);
    }
}
