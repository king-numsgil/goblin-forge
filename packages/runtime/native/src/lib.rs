//! The Goblin runtime.
//!
//! Everything a compiled program needs that is not machine code the compiler
//! emitted: the string representation, its operations, `console`, and the live
//! allocation counter.
//!
//! It is reached through exactly the same `extern "C"` boundary user code uses.
//! There is no privileged channel, which means the runtime is testable as an
//! ordinary C library and that a bug here looks like a bug anywhere else.
//!
//! # The string representation
//!
//! `string` is one machine word — a pointer to the first byte — with a header
//! sitting *behind* it:
//!
//! ```text
//!   [ len: u64 ][ owned: u64 ][ bytes … ][ 0 ]
//!                             ^ the `string` value points here
//! ```
//!
//! Three properties fall out, and all three are load-bearing:
//!
//! * `length` is a load, not a scan.
//! * The pointer is a valid C `char *`, so a string crosses to a native
//!   function without conversion.
//! * A **literal** is static data laid out in exactly this shape, with
//!   `owned = 0`. Freeing one is a no-op, so "the binding's scope releases it"
//!   has no exceptions — which is what keeps ownership a property of the type
//!   rather than of where the value came from.

#![allow(clippy::missing_safety_doc)]

use core::sync::atomic::{AtomicI64, AtomicBool, Ordering};
use std::alloc::{Layout, alloc, dealloc};
use std::io::Write;

/// A `string`: a pointer to the first byte, with a [`Header`] behind it.
pub type GfStr = *mut u8;

#[repr(C)]
struct Header {
    len: u64,
    /// Non-zero when the bytes came from the allocator and must go back.
    owned: u64,
}

const HEADER: usize = core::mem::size_of::<Header>();
/// The header is two `u64`s, so the allocation is 8-aligned and so is the
/// pointer handed out — which matters because the header is read through it.
const ALIGN: usize = 8;

// ---------------------------------------------------------------------------
// The live allocation counter
// ---------------------------------------------------------------------------

/// Allocations made by the runtime and not yet released.
///
/// REWRITE-PLAN §9 calls the automatic leak check on every run-test
/// non-negotiable, and says it "found more real bugs than every deliberate
/// assertion combined". This is what it reads.
static LIVE: AtomicI64 = AtomicI64::new(0);

/// The number of live allocations. Zero at the end of a correct program.
#[unsafe(no_mangle)]
pub extern "C" fn gf_live_allocations() -> i64 {
    LIVE.load(Ordering::SeqCst)
}

/// Whether to print an `alloc`/`free` line for every string event.
///
/// This is the Goblin half of the C++ oracle (REWRITE-PLAN §9.1). The C++ side
/// prints exactly the same two words for exactly the same events, and the test
/// requires the two traces to be identical — which turns "what should this
/// print?" from a judgement call into a comparison.
static TRACE_ALLOC: AtomicBool = AtomicBool::new(false);
static TRACE_READ: AtomicBool = AtomicBool::new(false);

fn tracing() -> bool {
    if !TRACE_READ.swap(true, Ordering::SeqCst) {
        TRACE_ALLOC.store(std::env::var_os("GOBLIN_TRACE_ALLOC").is_some(), Ordering::SeqCst);
    }
    TRACE_ALLOC.load(Ordering::SeqCst)
}

fn trace(event: &str) {
    if !tracing() {
        return;
    }
    let mut out = std::io::stdout();
    let _ = out.write_all(event.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

static REPORTER_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Print the live count on the way out, when asked to.
///
/// Registered lazily on the first allocation rather than from a constructor,
/// because a constructor in a static library is a per-platform arrangement and
/// this is not. A program that never allocates never registers it — and never
/// leaks either, so the harness reads a missing line as zero.
fn install_reporter() {
    if REPORTER_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    if std::env::var_os("GOBLIN_LEAK_CHECK").is_none() {
        return;
    }
    unsafe { libc::atexit(report_leaks) };
}

extern "C" fn report_leaks() {
    let live = LIVE.load(Ordering::SeqCst);
    // A machine-readable line on stderr, distinct enough that a program
    // printing something similar by accident is not a plausible worry.
    let mut err = std::io::stderr();
    let _ = writeln!(err, "##goblin-live-allocations:{live}");
    let _ = err.flush();
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

fn layout_for(len: usize) -> Layout {
    // header + bytes + the NUL that makes this a C string.
    Layout::from_size_align(HEADER + len + 1, ALIGN).expect("string layout")
}

/// Allocate an owned string of `len` bytes, uninitialised.
unsafe fn allocate(len: usize) -> GfStr {
    install_reporter();
    let raw = unsafe { alloc(layout_for(len)) };
    if raw.is_null() {
        std::process::abort();
    }
    unsafe {
        (raw as *mut Header).write(Header { len: len as u64, owned: 1 });
        let bytes = raw.add(HEADER);
        // The NUL is written now so every path that fills the bytes gets a
        // valid C string without having to remember.
        bytes.add(len).write(0);
        LIVE.fetch_add(1, Ordering::SeqCst);
        trace("alloc");
        bytes
    }
}

unsafe fn header_of(s: GfStr) -> *mut Header {
    unsafe { s.sub(HEADER) as *mut Header }
}

unsafe fn bytes_of<'a>(s: GfStr) -> &'a [u8] {
    if s.is_null() {
        return &[];
    }
    unsafe {
        let len = (*header_of(s)).len as usize;
        core::slice::from_raw_parts(s, len)
    }
}

unsafe fn str_of<'a>(s: GfStr) -> &'a str {
    // Every string this runtime produces is UTF-8. A caller can break that with
    // `substring` through a multi-byte character, which is documented as
    // producing bytes that are no longer valid UTF-8 — so the lossy path is
    // reachable and must not panic.
    unsafe { core::str::from_utf8(bytes_of(s)).unwrap_or("") }
}

unsafe fn from_bytes(bytes: &[u8]) -> GfStr {
    unsafe {
        let s = allocate(bytes.len());
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), s, bytes.len());
        s
    }
}

// ---------------------------------------------------------------------------
// The string operations
// ---------------------------------------------------------------------------

/// Length in **bytes**, in O(1). Not a character count.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_len(s: GfStr) -> usize {
    if s.is_null() {
        return 0;
    }
    unsafe { (*header_of(s)).len as usize }
}

/// The copy operation for `string`.
///
/// A literal is static, and strings are immutable, so copying one hands back
/// the same pointer — an allocation that never happens rather than one that is
/// optimised away later. Freeing it is already a no-op, so nothing downstream
/// has to know which kind it got.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_clone(s: GfStr) -> GfStr {
    if s.is_null() {
        return s;
    }
    unsafe {
        if (*header_of(s)).owned == 0 {
            return s;
        }
        from_bytes(bytes_of(s))
    }
}

/// The destroy operation for `string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_free(s: GfStr) {
    if s.is_null() {
        return;
    }
    unsafe {
        let header = header_of(s);
        if (*header).owned == 0 {
            return;
        }
        let len = (*header).len as usize;
        LIVE.fetch_sub(1, Ordering::SeqCst);
        dealloc(header as *mut u8, layout_for(len));
        trace("free");
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_concat(a: GfStr, b: GfStr) -> GfStr {
    unsafe {
        let left = bytes_of(a);
        let right = bytes_of(b);
        let s = allocate(left.len() + right.len());
        core::ptr::copy_nonoverlapping(left.as_ptr(), s, left.len());
        core::ptr::copy_nonoverlapping(right.as_ptr(), s.add(left.len()), right.len());
        s
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_eq(a: GfStr, b: GfStr) -> u8 {
    unsafe { u8::from(bytes_of(a) == bytes_of(b)) }
}

/// Copy a NUL-terminated C string into a managed string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_from_cstr(pointer: *const u8) -> GfStr {
    if pointer.is_null() {
        return unsafe { from_bytes(b"") };
    }
    unsafe {
        let mut len = 0usize;
        while *pointer.add(len) != 0 {
            len += 1;
        }
        from_bytes(core::slice::from_raw_parts(pointer, len))
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_substring(s: GfStr, start: usize, end: usize) -> GfStr {
    unsafe {
        let bytes = bytes_of(s);
        // Clamped, and a reversed pair swapped, matching JavaScript — so
        // parsing code does not need a bounds check on every call.
        let (mut lo, mut hi) = (start.min(bytes.len()), end.min(bytes.len()));
        if lo > hi {
            core::mem::swap(&mut lo, &mut hi);
        }
        from_bytes(&bytes[lo..hi])
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_index_of(haystack: GfStr, needle: GfStr, from: usize) -> isize {
    unsafe {
        let hay = bytes_of(haystack);
        let pin = bytes_of(needle);
        if from > hay.len() {
            return -1;
        }
        if pin.is_empty() {
            return from as isize;
        }
        hay[from..]
            .windows(pin.len())
            .position(|window| window == pin)
            .map_or(-1, |at| (at + from) as isize)
    }
}

/// The code point starting at byte `index`.
///
/// Zero when `index` is past the end or lands inside a multi-byte character,
/// which is how a byte-by-byte scan tells characters from continuation bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_code_point_at(s: GfStr, index: usize) -> u32 {
    unsafe {
        let text = str_of(s);
        if index >= text.len() || !text.is_char_boundary(index) {
            return 0;
        }
        text[index..].chars().next().map_or(0, u32::from)
    }
}

// ---------------------------------------------------------------------------
// Conversions, for interpolation
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn gf_string_from_i64(value: i64) -> GfStr {
    unsafe { from_bytes(value.to_string().as_bytes()) }
}

#[unsafe(no_mangle)]
pub extern "C" fn gf_string_from_u64(value: u64) -> GfStr {
    unsafe { from_bytes(value.to_string().as_bytes()) }
}

/// Formatted the way JavaScript formats a number, so that a value printed by a
/// Goblin program reads the same as the same value printed by the TypeScript it
/// was written to resemble.
#[unsafe(no_mangle)]
pub extern "C" fn gf_string_from_f64(value: f64) -> GfStr {
    let text = if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity".to_owned() } else { "-Infinity".to_owned() }
    } else if value == value.trunc() && value.abs() < 1e21 {
        // `1.0` prints as `1`, as it does in JavaScript.
        format!("{}", value as i64)
    } else {
        format!("{value}")
    };
    unsafe { from_bytes(text.as_bytes()) }
}

#[unsafe(no_mangle)]
pub extern "C" fn gf_string_from_bool(value: u8) -> GfStr {
    unsafe { from_bytes(if value != 0 { b"true" } else { b"false" }) }
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------

/// `console.log`, `console.info`, `console.debug` — one line to stdout.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_print(s: GfStr) {
    let mut out = std::io::stdout();
    let _ = out.write_all(unsafe { bytes_of(s) });
    let _ = out.write_all(b"\n");
    // Flushed every line: a program that aborts should still have printed what
    // it printed, and a test that compares stdout exactly cannot be at the
    // mercy of buffering.
    let _ = out.flush();
}

/// `console.warn`, `console.error` — one line to stderr, matching Node.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_eprint(s: GfStr) {
    let mut err = std::io::stderr();
    let _ = err.write_all(unsafe { bytes_of(s) });
    let _ = err.write_all(b"\n");
    let _ = err.flush();
}

/// `strlen`, for a `CString`.
///
/// The other half of the string pair, and the reason it is a separate type: a
/// `string` answers `length` with a load, and this one scans. Making that two
/// types rather than one keeps the cost visible where it is paid instead of
/// hiding it under `.length` on every string in the language.
///
/// # Safety
///
/// `s` must be null or point at nul-terminated bytes. There is no header, no
/// length and no owner — that is the whole point of the type, and checking is
/// not possible.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_cstr_len(s: *const u8) -> usize {
    if s.is_null() {
        return 0;
    }
    let mut len = 0usize;
    // SAFETY: the caller promises nul-terminated bytes.
    while unsafe { *s.add(len) } != 0 {
        len += 1;
    }
    len
}

// -- dynamic casts ----------------------------------------------------------
//
// `tryCast<T>(value)` asks "is this really a `T`", and for a contract the
// answer is an itab. The search happens here rather than inline because it is a
// loop, and a loop is much clearer as ordinary Rust than as hand-built
// Cranelift blocks.
//
// The type descriptor a class carries at `[vptr - 8]` is laid out by
// `goblin-codegen::vtable`:
//
// ```text
//   +0   name        *const u8, nul-terminated
//   +8   base        *const Descriptor, or null
//   +16  count       usize
//   +24  entries     [ { key: u64, itab: *const Itab } ; count ]
// ```
//
// The entry list is **flattened**, not inherited: a derived class carries its
// own itab for every interface any of its bases satisfies, holding *its* final
// overriders. Walking the base chain instead would find the base's itab and
// call the base's methods, which is the wrong answer and a quiet one.
//
// `key` is a hash of the interface's *name*, not a module-local id. Ids are
// numbered per compilation and two modules would disagree about them the moment
// `static-lib` exists; a name hash is the same everywhere.

/// Look up an interface's itab on a type descriptor. Null when absent.
///
/// # Safety
///
/// `descriptor` must be a descriptor this compiler emitted, or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_find_itab(descriptor: *const u8, key: u64) -> *const u8 {
    if descriptor.is_null() {
        return std::ptr::null();
    }
    let words = descriptor as *const usize;
    unsafe {
        let count = *words.add(2);
        let entries = words.add(3);
        for index in 0..count {
            if *entries.add(index * 2) as u64 == key {
                return *entries.add(index * 2 + 1) as *const u8;
            }
        }
    }
    std::ptr::null()
}

/// Whether `descriptor`'s base chain reaches `target`. `1` for yes.
///
/// The class half of `tryCast`, and DECISIONS §11.3's answer: descriptors have
/// one owner and are compared by *address*, so this is a pointer walk with no
/// names involved. That is what works across a library boundary, where the
/// closed-world trick of comparing against the set of vtables known at compile
/// time does not.
///
/// # Safety
///
/// Both arguments must be descriptors this compiler emitted, or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_is_a(descriptor: *const u8, target: *const u8) -> u8 {
    let mut current = descriptor;
    while !current.is_null() {
        if current == target {
            return 1;
        }
        // `base` is the second word; see `goblin-codegen::vtable`.
        current = unsafe { *(current as *const usize).add(1) } as *const u8;
    }
    0
}
