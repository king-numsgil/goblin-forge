//! Static per-class data: the type descriptor and the vtable.
//!
//! Both are ordinary read-only data objects with relocations in them, emitted
//! once per class before any function is translated so that a constructor can
//! name a vtable that has not been defined yet.
//!
//! The layout is Itanium's, and the reason is worth stating because it looks
//! like an off-by-one otherwise:
//!
//! ```text
//!   __gf_vt$Dog:   [ descriptor ][ slot 0 ][ slot 1 ] …
//!                                ^
//!                                the object's vtable pointer aims here
//! ```
//!
//! The pointer stored in an object addresses the *first method slot*, so a
//! virtual call is `load [vptr + slot * 8]` with no bias, and the descriptor is
//! at `[vptr - 8]`. Putting the descriptor first and biasing every call instead
//! would pay for the rarer operation on every one of the common ones.
//!
//! Slot 0 is the destructor (REWRITE-PLAN §4.1).

use std::collections::HashMap;

use cranelift_module::{DataDescription, DataId, Linkage as ClifLinkage, Module as ClifModule};

use goblin_mir::Module;

use crate::error::{InternalError, Result};
use crate::layout::TargetInfo;
use crate::translate::FuncRefs;

/// The static data belonging to one class.
#[derive(Debug, Clone)]
pub struct ClassData {
    /// The vtable object. Note that this addresses the *descriptor* word; an
    /// object's vtable pointer is this plus one pointer — see
    /// [`ClassData::vtable_bias`].
    pub vtable: DataId,
    pub descriptor: DataId,
    /// One itab per interface this class is convertible to, by `InterfaceId`.
    ///
    /// An **itab is a cache**, not an identity: it holds this class's answers
    /// to one interface's method set, gathered from the vtable at compile time.
    /// Nothing may ever compare one's address, and two modules converting the
    /// same pair will each emit one. Identity lives in the descriptor, which
    /// has exactly one owner (DECISIONS §11.2).
    pub itabs: HashMap<u32, DataId>,
}

impl ClassData {
    /// How far into the vtable object an object's vtable pointer aims.
    pub const fn vtable_bias(target: TargetInfo) -> i64 {
        target.pointer_bytes as i64
    }
}

/// Emit the descriptor and vtable for every class in the module.
///
/// Returns them indexed by `ClassId`, which is what makes a later lookup a
/// slice index rather than a search.
pub fn emit(
    module: &Module,
    clif_module: &mut dyn ClifModule,
    func_refs: &FuncRefs,
    target: TargetInfo,
) -> Result<Vec<ClassData>> {
    let pointer = target.pointer_bytes as usize;

    // Declare everything first: a descriptor points at its base's descriptor,
    // and a base may be declared after the class that derives from it.
    let mut data = Vec::with_capacity(module.classes.len());
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
                declare(clif_module, &format!("__gf_itab${interface}${name}"))?,
            );
        }
        data.push(ClassData {
            vtable: declare(clif_module, &format!("__gf_vt${name}"))?,
            descriptor: declare(clif_module, &format!("__gf_desc${name}"))?,
            itabs,
        });
    }

    for (index, class) in module.classes.iter().enumerate() {
        let name = module
            .sym(class.name)
            .ok_or_else(|| InternalError::new(format!("class {index} has no name")))?;
        let entry = &data[index];

        // -- the descriptor: { name, base } ---------------------------------
        //
        // Enough for `instanceof` to walk the chain and compare pointers, which
        // is what DECISIONS §11.3 settles on. Two modules must never each own a
        // copy of this object: it is the *identity*, and identity has one owner
        // (DECISIONS §11.2).
        let name_data = declare_string(clif_module, &format!("__gf_name${name}"), name)?;

        // Followed by the itab table `gf_find_itab` searches:
        //
        //   +0  name   +8  base   +16  count   +24  [ { key, itab } ; count ]
        //
        // `key` is a hash of the *interface's name*, never its `InterfaceId`.
        // Ids are numbered per compilation, so two modules would disagree about
        // them the moment `static-lib` exists; a name is the same everywhere.
        let mut sorted: Vec<_> = class.implements.iter().collect();
        sorted.sort_by_key(|implemented| implemented.interface.0);

        let mut descriptor = DataDescription::new();
        let mut bytes = vec![0u8; pointer * (3 + sorted.len() * 2)];
        bytes[pointer * 2..pointer * 3]
            .copy_from_slice(&(sorted.len() as u64).to_le_bytes()[..pointer]);
        for (index, implemented) in sorted.iter().enumerate() {
            let interface = module
                .interface(implemented.interface)
                .and_then(|def| module.sym(def.name))
                .ok_or_else(|| {
                    InternalError::new(format!("interface {} is missing", implemented.interface.0))
                })?;
            let at = pointer * (3 + index * 2);
            bytes[at..at + pointer]
                .copy_from_slice(&interface_key(interface).to_le_bytes()[..pointer]);
        }
        descriptor.define(bytes.into_boxed_slice());

        let name_ref = clif_module.declare_data_in_data(name_data, &mut descriptor);
        descriptor.write_data_addr(0, name_ref, 0);
        if let Some(base) = class.base {
            let base_data = data
                .get(base.index())
                .ok_or_else(|| InternalError::new(format!("base class {} is missing", base.0)))?;
            let base_ref = clif_module.declare_data_in_data(base_data.descriptor, &mut descriptor);
            descriptor.write_data_addr(pointer as u32, base_ref, 0);
        }
        for (index, implemented) in sorted.iter().enumerate() {
            let itab = *entry.itabs.get(&implemented.interface.0).ok_or_else(|| {
                InternalError::new(format!(
                    "class `{name}` has no itab declared for interface {}",
                    implemented.interface.0,
                ))
            })?;
            let itab_ref = clif_module.declare_data_in_data(itab, &mut descriptor);
            // Biased past the itab's own descriptor word, so what a dynamic
            // cast hands back is what a static conversion would have built.
            descriptor.write_data_addr(
                (pointer * (4 + index * 2)) as u32,
                itab_ref,
                ClassData::vtable_bias(target),
            );
        }
        define(
            clif_module,
            entry.descriptor,
            &descriptor,
            &format!("__gf_desc${name}"),
        )?;

        // -- the vtable: [ descriptor ][ slot 0 ] … --------------------------
        let mut vtable = DataDescription::new();
        vtable.define(vec![0u8; pointer * (class.vtable.len() + 1)].into_boxed_slice());
        let descriptor_ref = clif_module.declare_data_in_data(entry.descriptor, &mut vtable);
        vtable.write_data_addr(0, descriptor_ref, 0);
        for (slot, func) in class.vtable.iter().enumerate() {
            let clif_func = func_refs
                .defined
                .get(func.index())
                .copied()
                .ok_or_else(|| {
                    InternalError::new(format!(
                        "class `{name}` names function {} in vtable slot {slot}, \
                     and that function is not in the module",
                        func.0,
                    ))
                })?;
            let func_ref = clif_module.declare_func_in_data(clif_func, &mut vtable);
            vtable.write_function_addr(((slot + 1) * pointer) as u32, func_ref);
        }
        define(
            clif_module,
            entry.vtable,
            &vtable,
            &format!("__gf_vt${name}"),
        )?;

        // -- the itabs: [ descriptor ][ method 0 ] … --------------------------
        //
        // Deliberately the same shape as a vtable, so that a dynamic cast can
        // hand back an itab pointer and everything downstream — including
        // reaching the type descriptor at `[-1]` — works unchanged.
        //
        // The methods are a *gather from the vtable*: the class's final
        // overrider for each of the interface's methods, resolved by the
        // frontend and recorded in `Impl::methods`. No search happens here and
        // none happens at run time.
        for implemented in &class.implements {
            let id = *entry.itabs.get(&implemented.interface.0).ok_or_else(|| {
                InternalError::new(format!(
                    "class `{name}` has no itab declared for interface {}",
                    implemented.interface.0,
                ))
            })?;
            let mut itab = DataDescription::new();
            itab.define(vec![0u8; pointer * (implemented.methods.len() + 1)].into_boxed_slice());
            let descriptor_ref = clif_module.declare_data_in_data(entry.descriptor, &mut itab);
            itab.write_data_addr(0, descriptor_ref, 0);
            for (slot, func) in implemented.methods.iter().enumerate() {
                let clif_func = func_refs
                    .defined
                    .get(func.index())
                    .copied()
                    .ok_or_else(|| {
                        InternalError::new(format!(
                            "class `{name}` names function {} in itab slot {slot}, \
                         and that function is not in the module",
                            func.0,
                        ))
                    })?;
                let func_ref = clif_module.declare_func_in_data(clif_func, &mut itab);
                itab.write_function_addr(((slot + 1) * pointer) as u32, func_ref);
            }
            define(clif_module, id, &itab, "an itab")?;
        }
    }

    Ok(data)
}

fn declare(clif_module: &mut dyn ClifModule, symbol: &str) -> Result<DataId> {
    clif_module
        .declare_data(symbol, ClifLinkage::Local, false, false)
        .map_err(|error| InternalError::new(format!("declaring `{symbol}`: {error}")))
}

fn declare_string(clif_module: &mut dyn ClifModule, symbol: &str, text: &str) -> Result<DataId> {
    let id = declare(clif_module, symbol)?;
    let mut description = DataDescription::new();
    let mut bytes = text.as_bytes().to_vec();
    // Nul-terminated, so a descriptor's name can be handed straight to C.
    bytes.push(0);
    description.define(bytes.into_boxed_slice());
    define(clif_module, id, &description, symbol)?;
    Ok(id)
}

fn define(
    clif_module: &mut dyn ClifModule,
    id: DataId,
    description: &DataDescription,
    symbol: &str,
) -> Result<()> {
    clif_module
        .define_data(id, description)
        .map_err(|error| InternalError::new(format!("defining `{symbol}`: {error}")))
}

/// A stable key for an interface, from its **name**.
///
/// FNV-1a, 64-bit. Deliberately not the `InterfaceId`: ids are numbered per
/// compilation, so two modules would disagree about them the moment a library
/// boundary exists — which is precisely the closed-world mistake REWRITE-PLAN
/// §3 says to design out rather than fix later.
///
/// A collision would make a dynamic cast answer yes to the wrong interface.
/// Two names colliding in 64 bits is not something to plan around, but it is
/// something to *notice* if a cast ever comes back inexplicably true.
pub fn interface_key(name: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in name.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}
