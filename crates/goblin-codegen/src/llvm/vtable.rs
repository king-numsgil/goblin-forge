//! Per-class static data, as LLVM constants.
//!
//! Itanium's arrangement, and the shape is worth stating because it is where
//! an off-by-one hides:
//!
//! ```text
//!   __gf_vt$Dog:   [ descriptor ][ slot 0 ][ slot 1 ] …
//!                                ^
//!                                the object's vtable pointer aims here
//! ```
//!
//! So a descriptor storing an itab address stores it **already biased** by one
//! pointer, and what a dynamic cast hands back is what a static conversion
//! would have built.

use std::collections::HashMap;

use goblin_mir::Module;

use crate::error::{InternalError, Result};
use crate::layout::TargetInfo;
use crate::llvm::data::{Globals, Word};

/// How far into the vtable object an object's vtable pointer aims.
///
/// The pointer stored in an object addresses the *first method slot*, so a
/// virtual call is `load [vptr + slot * 8]` with no bias and the descriptor is
/// at `[vptr - 8]`. Putting the descriptor first and biasing every call instead
/// would pay for the rarer operation on every one of the common ones.
pub const fn vtable_bias(target: TargetInfo) -> i64 {
    target.pointer_bytes as i64
}

/// A stable key for an interface, from its **name**.
///
/// FNV-1a, 64-bit. Deliberately not the `InterfaceId`: ids are numbered per
/// compilation, so two modules would disagree about them the moment a library
/// boundary exists — which is precisely the closed-world mistake REWRITE-PLAN
/// §3 says to design out rather than fix later.
///
/// A collision would make a dynamic cast answer yes to the wrong interface. Two
/// names colliding in 64 bits is not something to plan around, but it is
/// something to *notice* if a cast ever comes back inexplicably true.
pub fn interface_key(name: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in name.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The symbols belonging to one class.
#[derive(Debug, Clone)]
pub struct ClassSymbols {
    /// The vtable object — which addresses the *descriptor* word. An object's
    /// vtable pointer is this plus [`vtable_bias`].
    pub vtable: String,
    pub descriptor: String,
    /// One itab per interface this class is convertible to, by `InterfaceId`.
    pub itabs: HashMap<u32, String>,
}

/// Emit the descriptor, vtable and itabs for every class in the module.
pub fn emit(
    module: &Module,
    globals: &mut Globals,
    target: TargetInfo,
) -> Result<Vec<ClassSymbols>> {
    let bias = vtable_bias(target);

    // Names first, for every class, because a descriptor points at its base's
    // descriptor and a base may be declared after the class deriving from it.
    // Nothing is *defined* in this pass — in LLVM a global may be referenced
    // before its definition appears, so this only has to settle the spelling.
    let mut symbols = Vec::with_capacity(module.classes.len());
    for (index, class) in module.classes.iter().enumerate() {
        let name = module
            .sym(class.name)
            .ok_or_else(|| InternalError::new(format!("class {index} has no name")))?;
        let mut itabs = HashMap::new();
        for implemented in &class.implements {
            let interface = module
                .interface(implemented.interface)
                .and_then(|def| module.sym(def.name))
                .ok_or_else(|| {
                    InternalError::new(format!(
                        "class `{name}` implements interface {}, which is not in the module",
                        implemented.interface.0,
                    ))
                })?;
            itabs.insert(
                implemented.interface.0,
                format!("__gf_itab${interface}${name}"),
            );
        }
        symbols.push(ClassSymbols {
            vtable: format!("__gf_vt${name}"),
            descriptor: format!("__gf_desc${name}"),
            itabs,
        });
    }

    for (index, class) in module.classes.iter().enumerate() {
        let name = module
            .sym(class.name)
            .ok_or_else(|| InternalError::new(format!("class {index} has no name")))?;
        let entry = &symbols[index];

        // -- the descriptor -------------------------------------------------
        //
        //   +0 name   +1 base   +2 count   +3 [ { key, itab } ; count ]
        //
        // `key` is a hash of the *interface's name*, never its `InterfaceId`:
        // ids are numbered per compilation and two modules would disagree the
        // moment `static-lib` exists.
        let name_symbol = format!("__gf_name${name}");
        let mut bytes = name.as_bytes().to_vec();
        // Nul-terminated, so a descriptor's name can be handed straight to C.
        bytes.push(0);
        globals.bytes(&name_symbol, &bytes);

        let mut sorted: Vec<_> = class.implements.iter().collect();
        sorted.sort_by_key(|implemented| implemented.interface.0);

        let mut words = vec![
            Word::addr(&name_symbol),
            match class.base {
                Some(base) => Word::addr(
                    &symbols
                        .get(base.index())
                        .ok_or_else(|| {
                            InternalError::new(format!("base class {} is missing", base.0))
                        })?
                        .descriptor,
                ),
                None => Word::Null,
            },
            Word::Int(sorted.len() as u64),
        ];
        for implemented in &sorted {
            let interface = module
                .interface(implemented.interface)
                .and_then(|def| module.sym(def.name))
                .ok_or_else(|| {
                    InternalError::new(format!("interface {} is missing", implemented.interface.0))
                })?;
            let itab = entry.itabs.get(&implemented.interface.0).ok_or_else(|| {
                InternalError::new(format!(
                    "class `{name}` has no itab declared for interface {}",
                    implemented.interface.0,
                ))
            })?;
            words.push(Word::Int(interface_key(interface)));
            // Biased past the itab's own descriptor word, so what a dynamic
            // cast hands back is what a static conversion would have built.
            words.push(Word::Addr {
                symbol: itab.clone(),
                bias,
            });
        }
        globals.words(&entry.descriptor, &words, target);

        // -- the vtable: [ descriptor ][ slot 0 ] … ---------------------------
        let mut slots = vec![Word::addr(&entry.descriptor)];
        for (slot, func) in class.vtable.iter().enumerate() {
            slots.push(Word::addr(function_symbol(
                module, *func, name, "vtable", slot,
            )?));
        }
        globals.words(&entry.vtable, &slots, target);

        // -- the itabs: [ descriptor ][ method 0 ] … --------------------------
        //
        // Deliberately a vtable's shape, so a dynamic cast can hand back an
        // itab pointer and everything downstream — including reaching the type
        // descriptor at `[-1]` — works unchanged.
        for implemented in &class.implements {
            let symbol = entry.itabs.get(&implemented.interface.0).ok_or_else(|| {
                InternalError::new(format!(
                    "class `{name}` has no itab declared for interface {}",
                    implemented.interface.0,
                ))
            })?;
            let mut methods = vec![Word::addr(&entry.descriptor)];
            for (slot, func) in implemented.methods.iter().enumerate() {
                methods.push(Word::addr(function_symbol(
                    module, *func, name, "itab", slot,
                )?));
            }
            globals.words(symbol, &methods, target);
        }
    }

    Ok(symbols)
}

/// The linker-visible name of a function a table names.
fn function_symbol(
    module: &Module,
    func: goblin_mir::FuncId,
    class: &str,
    table: &str,
    slot: usize,
) -> Result<String> {
    module
        .funcs
        .get(func.index())
        .and_then(|def| module.sym(def.name))
        .map(str::to_owned)
        .ok_or_else(|| {
            InternalError::new(format!(
                "class `{class}` names function {} in {table} slot {slot}, \
                 and that function is not in the module",
                func.0,
            ))
        })
}
