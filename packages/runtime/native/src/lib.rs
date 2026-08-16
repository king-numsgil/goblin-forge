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

use core::mem::align_of;
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

/// The runtime's initialisation, called once at the top of `main`.
///
/// A `bin` target's entry point calls this before its first statement, which is
/// the whole reason it exists as a function rather than as a constructor: a
/// constructor in a static library is a per-platform arrangement *and* is only
/// linked in when something else in its object is referenced, so a program that
/// allocates nothing would silently not have one. A call from `main` is
/// portable and unconditional.
///
/// It matters that it is unconditional. The leak reporter used to be installed
/// on the first allocation, which meant a missing report was ambiguous —
/// either the program never allocated, or it died before `atexit` handlers ran.
/// The harness read both as zero, so a program that crashed on a double free
/// scored a clean leak check. Now the report is missing only if the program
/// did not reach a normal exit, and the harness says so.
#[unsafe(no_mangle)]
pub extern "C" fn gf_runtime_init() {
    install_reporter();
}

/// Print the live count on the way out, when asked to.
///
/// Idempotent: [`gf_runtime_init`] is the ordinary caller, and the allocator
/// calls it too so that a `static-lib` linked into someone else's `main` still
/// reports. Whichever gets there first wins and the other is a no-op.
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

// ---------------------------------------------------------------------------
// Raw storage: `alloc` and `free`
//
// C++'s `new T(…)` and `delete`, split the way this compiler splits every other
// owning operation: the runtime hands out and takes back *storage*, and the
// backend runs the constructor and the destructor. Neither knows what a `T` is.
//
// Size and alignment come from the call site as ordinary arguments, because the
// backend is the only thing that lays a type out and it knows both as
// constants. That is also why there is no `gf_alloc<T>`: there is nothing to
// specialise.
// ---------------------------------------------------------------------------

/// Storage for one value, **uninitialised**. The caller constructs into it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_alloc(size: usize, align: usize) -> *mut u8 {
    install_reporter();
    // A zero-sized type still gets a distinct address, as it does in C++: two
    // objects that exist are not the same object.
    let layout = Layout::from_size_align(size.max(1), align.max(1)).expect("alloc layout");
    let raw = unsafe { alloc(layout) };
    if raw.is_null() {
        std::process::abort();
    }
    LIVE.fetch_add(1, Ordering::SeqCst);
    trace("alloc");
    raw
}

/// Release storage from [`gf_alloc`]. The value in it is already destroyed.
///
/// The size and alignment must be the ones it was allocated with — Rust's
/// allocator is given the layout on the way out as well as on the way in, which
/// is why they are parameters rather than something the pointer remembers.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_free(pointer: *mut u8, size: usize, align: usize) {
    if pointer.is_null() {
        return;
    }
    let layout = Layout::from_size_align(size.max(1), align.max(1)).expect("free layout");
    LIVE.fetch_sub(1, Ordering::SeqCst);
    unsafe { dealloc(pointer, layout) };
    trace("free");
}

// ---------------------------------------------------------------------------
// `new T[n]` and `delete[]`
//
// The count has to survive the allocation, because `delete[]` is given only a
// pointer and needs two things the pointer does not carry: how many destructors
// to run, and how many bytes to hand back. C++ solves this with a **cookie** —
// a hidden word just before the first element — and so does this:
//
//   [ count: usize ][ pad ][ elem0 ][ elem1 ] …
//                           ^ the `Pointer<T>` the caller gets
//
// C++ writes the cookie only when the element has a non-trivial destructor,
// because `operator delete[]` can ask the allocator how big the block was.
// Rust's allocator cannot be asked — `dealloc` is *given* the layout — so the
// cookie is unconditional here. One word per array, and the alternative is a
// size the caller would have to remember and pass back.
//
// The header is `max(align, align_of::<usize>())` bytes, and the block is
// allocated at that alignment too: that keeps the cookie aligned for a `usize`
// *and* leaves the elements at their own alignment, since the header is then a
// multiple of both.
// ---------------------------------------------------------------------------

/// The block's alignment, and the offset from it to the first element.
///
/// Named for the *run* rather than for the array, because `T[]` a few hundred
/// lines down has a header of its own and a different one — that one carries a
/// length and a capacity and belongs to a growable container, where this is one
/// hidden word behind a raw pointer.
fn run_header(align: usize) -> (usize, usize) {
    let align = align.max(align_of::<usize>()).max(1);
    (align, align)
}

/// Storage for `count` elements, **uninitialised**, with the count remembered.
///
/// `stride` is what one element occupies in an array — the size rounded up to
/// the alignment, which is what C's `sizeof` reports and what the backend's
/// indexing strides by. Passing the unrounded size instead overlaps the
/// elements with each other (REWRITE-PLAN §10).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_alloc_array(count: usize, stride: usize, align: usize) -> *mut u8 {
    install_reporter();
    let (align, offset) = run_header(align);
    let bytes = stride
        .checked_mul(count)
        .and_then(|total| total.checked_add(offset))
        .expect("array too large");
    let layout = Layout::from_size_align(bytes, align).expect("array alloc layout");
    let raw = unsafe { alloc(layout) };
    if raw.is_null() {
        std::process::abort();
    }
    unsafe { raw.cast::<usize>().write(count) };
    LIVE.fetch_add(1, Ordering::SeqCst);
    trace("alloc");
    unsafe { raw.add(offset) }
}

/// How many elements [`gf_alloc_array`] was asked for.
///
/// Read back rather than remembered by the caller, which is the whole reason
/// the cookie exists: `p.freeArray()` names a pointer and nothing else.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_alloc_array_count(pointer: *mut u8, align: usize) -> usize {
    if pointer.is_null() {
        return 0;
    }
    let (_, offset) = run_header(align);
    unsafe { pointer.sub(offset).cast::<usize>().read() }
}

/// Release storage from [`gf_alloc_array`]. The elements are already destroyed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_free_array(pointer: *mut u8, stride: usize, align: usize) {
    if pointer.is_null() {
        return;
    }
    let (align, offset) = run_header(align);
    let base = unsafe { pointer.sub(offset) };
    let count = unsafe { base.cast::<usize>().read() };
    let bytes = stride * count + offset;
    let layout = Layout::from_size_align(bytes, align).expect("array free layout");
    LIVE.fetch_sub(1, Ordering::SeqCst);
    unsafe { dealloc(base, layout) };
    trace("free");
}

// ---------------------------------------------------------------------------
// `T[]`
//
// The same shape as a string, and deliberately: one machine word pointing at
// the first element, with a header behind it.
//
//   [ len: u64 ][ cap: u64 ][ elem0 ][ elem1 ] …
//                           ^ the `T[]` value points here
//
// Elements are stored **inline** — an element occupies its own stride, not a
// pointer to itself — which is what makes the bytes match what a C compiler
// produces for the same declaration, and what lets the backend address element
// `i` as `base + i * stride`.
//
// The runtime owns the buffer and the bookkeeping, and nothing else. Per-element
// construction and destruction belong to the *backend*, because only it knows an
// element's copy and drop operations — the same split that makes a struct
// holding a `string` work. So `gf_array_free` releases the buffer and never
// looks inside it: whoever calls it has already destroyed the elements.
//
// Stride and alignment are passed in at each call rather than stored, because
// the backend knows both as compile-time constants. That keeps the header two
// words, exactly like a string's.
// ---------------------------------------------------------------------------

/// A `T[]`: a pointer to the first element, with an [`ArrayHeader`] behind it.
pub type GfArray = *mut u8;

#[repr(C)]
struct ArrayHeader {
    len: u64,
    /// Elements the buffer has room for. **Zero means static**: the shared
    /// empty array below, which is not the allocator's and must not go back to
    /// it. That is the same trick a string literal plays with `owned = 0`, and
    /// it buys the same thing — `[]` allocates nothing, as an empty
    /// `std::vector` does not, so an allocation trace can be compared with C++.
    cap: u64,
}

const ARRAY_HEADER: usize = core::mem::size_of::<ArrayHeader>();

/// The empty array every `[]` points at, and the reason one costs nothing.
///
/// `cap = 0`, so pushing onto it allocates a fresh buffer and freeing it is a
/// no-op. Sharing one between every empty array in the program is safe because
/// nothing can be written through it: there is no element zero to write.
static EMPTY_ARRAY: ArrayHeader = ArrayHeader { len: 0, cap: 0 };

unsafe fn array_header(a: GfArray) -> *mut ArrayHeader {
    unsafe { a.sub(ARRAY_HEADER) as *mut ArrayHeader }
}

fn array_layout(cap: u64, stride: u64, align: u64) -> Layout {
    let size = ARRAY_HEADER + (cap as usize) * (stride as usize);
    // The header is two words, so it is a multiple of every alignment an
    // element can have — which is what keeps the first element correctly
    // aligned while the header sits immediately in front of it.
    let align = (align as usize).max(ALIGN);
    Layout::from_size_align(size, align).expect("array layout")
}

/// `main(args: string[])` — argv, copied into an owned `string[]`.
///
/// Built here rather than by emitted code because it is the one array whose
/// elements do not come from the program: `argv` is the platform's, its entries
/// are C strings, and each has to be copied before the program can own it.
/// Everything after that is an ordinary `string[]` — the same handle a literal
/// produces, released by the scope that holds it.
///
/// `argv[0]` is **included**, as it is in C. Dropping it would be the
/// convenient choice and the wrong one: which arguments a program gets is not
/// something a compiler should have an opinion about.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_args(argc: i32, argv: *const *const u8) -> GfArray {
    install_reporter();
    if argc <= 0 || argv.is_null() {
        return gf_array_empty();
    }
    let count = argc as u64;
    let stride = core::mem::size_of::<GfStr>() as u64;
    let array = unsafe { gf_array_new(count, stride, ALIGN as u64) };
    for i in 0..argc as usize {
        let entry = unsafe { *argv.add(i) };
        let owned = unsafe { gf_string_from_cstr(entry) };
        unsafe { (array as *mut GfStr).add(i).write(owned) };
    }
    array
}

/// The shared empty array. Allocates nothing.
#[unsafe(no_mangle)]
pub extern "C" fn gf_array_empty() -> GfArray {
    install_reporter();
    unsafe { (&EMPTY_ARRAY as *const ArrayHeader as *mut u8).add(ARRAY_HEADER) }
}

/// Storage for `len` elements, with `len` already set and the elements
/// **uninitialised** — the caller fills them, applying each one's own copy.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_array_new(len: u64, stride: u64, align: u64) -> GfArray {
    if len == 0 {
        return gf_array_empty();
    }
    install_reporter();
    let raw = unsafe { alloc(array_layout(len, stride, align)) };
    if raw.is_null() {
        std::process::abort();
    }
    unsafe {
        (raw as *mut ArrayHeader).write(ArrayHeader { len, cap: len });
        LIVE.fetch_add(1, Ordering::SeqCst);
        trace("alloc");
        raw.add(ARRAY_HEADER)
    }
}

/// The element count, in O(1).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_array_len(a: GfArray) -> usize {
    if a.is_null() {
        return 0;
    }
    unsafe { (*array_header(a)).len as usize }
}

/// Make room for one more element and hand back the address of it.
///
/// `slot` is the address of the *handle*, not the handle: growing reallocates,
/// which moves the buffer, so the caller's variable has to be reseated. The
/// element itself is stored by the backend through the returned address, so
/// that `push` copies or moves according to the element's own type.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_array_push_slot(
    slot: *mut GfArray,
    stride: u64,
    align: u64,
) -> *mut u8 {
    unsafe {
        let current = *slot;
        let header = array_header(current);
        let len = (*header).len;
        let cap = (*header).cap;

        if len == cap {
            // Doubling, from a floor of four. Amortised constant, and the same
            // growth strategy every `std::vector` implementation uses — the
            // exponent is what makes a loop of pushes linear rather than
            // quadratic.
            let grown = if cap == 0 { 4 } else { cap * 2 };
            let raw = alloc(array_layout(grown, stride, align));
            if raw.is_null() {
                std::process::abort();
            }
            (raw as *mut ArrayHeader).write(ArrayHeader { len, cap: grown });
            let elements = raw.add(ARRAY_HEADER);
            // A byte copy is right here and only here: the elements are being
            // *relocated*, not duplicated. Each one keeps whatever it owns and
            // there is exactly one of it afterwards, so no copy operation runs
            // and nothing is freed twice.
            core::ptr::copy_nonoverlapping(current, elements, (len * stride) as usize);
            LIVE.fetch_add(1, Ordering::SeqCst);
            trace("alloc");
            if cap != 0 {
                LIVE.fetch_sub(1, Ordering::SeqCst);
                dealloc(header as *mut u8, array_layout(cap, stride, align));
                trace("free");
            }
            *slot = elements;
        }

        let base = *slot;
        (*array_header(base)).len = len + 1;
        base.add((len * stride) as usize)
    }
}

/// Drop the last element's *slot*, after the backend has destroyed it.
///
/// The buffer is kept, exactly as `std::vector::pop_back` keeps its capacity.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_array_pop(a: GfArray) {
    unsafe {
        let header = array_header(a);
        if (*header).len != 0 {
            (*header).len -= 1;
        }
    }
}

/// Release the buffer. The elements are the backend's to destroy first.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_array_free(a: GfArray, stride: u64, align: u64) {
    if a.is_null() {
        return;
    }
    unsafe {
        let header = array_header(a);
        let cap = (*header).cap;
        // Static, so there is nothing to give back — the empty array.
        if cap == 0 {
            return;
        }
        LIVE.fetch_sub(1, Ordering::SeqCst);
        dealloc(header as *mut u8, array_layout(cap, stride, align));
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

/// Copy `len` bytes into a managed string, terminator or no terminator.
///
/// The honest primitive where a length is already known: a file read, a
/// `void *` and a `size_t` out-parameter, a slice of a larger buffer. Scanning
/// for a NUL there is a second pass over bytes already measured, and it is
/// *wrong* rather than merely wasteful when the data contains one — the string
/// would stop at the first zero and report a length nobody asked for.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_string_from_bytes(pointer: *const u8, len: usize) -> GfStr {
    if pointer.is_null() || len == 0 {
        return unsafe { from_bytes(b"") };
    }
    unsafe { from_bytes(core::slice::from_raw_parts(pointer, len)) }
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
