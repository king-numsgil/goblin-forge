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

//! # Why this crate is `no_std`
//!
//! Not for the usual reason. Nothing here is freestanding — the runtime calls
//! libc on every page, and is linked into a program that has a full C runtime
//! under it. What `no_std` buys is the ability to write our own
//! [`panic_handler`], which on stable Rust is the only way to stop linking
//! std's.
//!
//! std's panic hook resolves a backtrace, which drags in the whole DWARF
//! symbolizer — gimli, addr2line, rustc_demangle, miniz_oxide. That was 182 KB
//! of the 259 KB of sized symbols in a program that computes a factorial and
//! prints nothing, and every byte of it was unreachable: `main` is emitted by
//! the compiler, not by Rust, so no Rust panic ever runs to print anything.
//! `panic = "abort"` does not help — it removes the unwinder, not the hook.
//!
//! The cost is that the eleven places this crate wanted std are written against
//! libc instead. They are all in this file, all marked, and none of them are
//! subtle; see [`stdio`], [`env_is_set`], and [`Digits`].

#![cfg_attr(not(test), no_std)]
#![allow(clippy::missing_safety_doc)]

use core::mem::{align_of, size_of};
use core::sync::atomic::{AtomicI64, AtomicBool, Ordering};
use core::fmt::Write;

use core::ffi::{c_char, c_void, CStr};

use libmimalloc_sys::{
    mi_calloc, mi_free, mi_malloc, mi_malloc_aligned, mi_malloc_aligned_at, mi_realloc,
    mi_realloc_aligned, mi_usable_size, mi_zalloc,
};

/// Terminate, the same way every other failure here terminates.
///
/// There is deliberately no message. A panic reachable from a compiled program
/// is a broken *compiler* — the frontend was supposed to have rejected it — and
/// the project treats that as an abort rather than a diagnostic, exactly as
/// `CLAUDE.md` describes for the backend. Formatting the payload would relink
/// the machinery this crate is `no_std` to avoid.
#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unsafe { libc::abort() }
}

/// `abort`, spelled once.
///
/// `libc::abort` rather than a trap instruction because that is precisely what
/// `std::process::abort` called on the way to raising `SIGABRT`, and these are
/// all out-of-memory paths whose observable behaviour should not shift.
fn abort() -> ! {
    unsafe { libc::abort() }
}

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

/// Is an environment variable present, whatever its value?
///
/// `getenv` rather than `std::env::var_os`: both answer from the same
/// `environ`, and this one does not need an owned `OsString` to throw away.
/// Read once, before any Goblin code could have called `setenv`.
fn env_is_set(name: &CStr) -> bool {
    !unsafe { libc::getenv(name.as_ptr()) }.is_null()
}

/// Which of the two standard streams a write is going to.
///
/// Not a file descriptor. It was one, and on unix it still is — but the
/// Windows half of [`write_some`] does not go through the CRT at all, so this
/// is a choice of stream that each platform spells its own way.
const STDIN: i32 = 0;
const STDOUT: i32 = 1;
const STDERR: i32 = 2;

/// One write, at the platform's own boundary, returning how many bytes moved.
///
/// Split because the two platforms disagree about what a standard stream *is*,
/// and the Windows answer is emphatically not the CRT's — see the `cfg(windows)`
/// arm.
#[cfg(not(windows))]
fn write_some(stream: i32, bytes: &[u8]) -> isize {
    // `as _` on the count and the result: `size_t` and `ssize_t` here.
    unsafe { libc::write(stream, bytes.as_ptr() as *const c_void, bytes.len() as _) as isize }
}

#[cfg(windows)]
unsafe extern "system" {
    fn GetStdHandle(which: u32) -> *mut c_void;

    fn WriteFile(
        handle: *mut c_void,
        buffer: *const c_void,
        len: u32,
        written: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;

    fn ReadFile(
        handle: *mut c_void,
        buffer: *mut c_void,
        len: u32,
        read: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
}

/// One read from a standard stream, returning how many bytes arrived.
///
/// The mirror of [`write_some`], and it goes around the CRT for the same
/// reason: descriptor 0 opened in text mode would rewrite the bytes on the way
/// in, and a program reading its own input should see what was sent.
///
/// Zero means end of input. It is not distinguished from a failed read, for the
/// reason [`stdio`] gives about `errno`: there is no portable spelling, and
/// nothing here could act differently on the answer.
#[cfg(not(windows))]
fn read_some(stream: i32, bytes: &mut [u8]) -> isize {
    // `as _` on the count and the result: `size_t` and `ssize_t` here.
    unsafe { libc::read(stream, bytes.as_mut_ptr() as *mut c_void, bytes.len() as _) as isize }
}

#[cfg(windows)]
fn read_some(stream: i32, bytes: &mut [u8]) -> isize {
    // `STD_INPUT_HANDLE` is -10. Only stdin is ever read from, so the other two
    // are not mapped: asking to read stdout is a question with no answer, and
    // giving it one would be inventing behaviour rather than reporting it.
    if stream != STDIN {
        return 0;
    }
    let len = if bytes.len() > u32::MAX as usize { u32::MAX } else { bytes.len() as u32 };
    let mut moved: u32 = 0;
    let ok = unsafe {
        ReadFile(
            GetStdHandle(-10i32 as u32),
            bytes.as_mut_ptr() as *mut c_void,
            len,
            &mut moved,
            core::ptr::null_mut(),
        )
    };
    if ok == 0 { 0 } else { moved as isize }
}

/// `WriteFile` on the raw handle, and *not* the CRT's `write`.
///
/// This was `libc::write` on descriptor 1, on the reasoning that the Windows
/// CRT numbers its descriptors the same way. It does — and it also opens them
/// in text mode, where every `\n` on the way out becomes `\r\n`. That is
/// invisible on unix, invisible in a terminal, and it broke every test that
/// asserts on exact output, which is very nearly all of them.
///
/// `std::io::stdout` never had the problem because std does not use the CRT
/// here either; it writes to the handle. Doing the same restores the bytes
/// this runtime emitted before it went `no_std`, rather than approximating
/// them.
///
/// The console case is the one deliberate departure: std reaches for
/// `WriteConsoleW`, converting to UTF-16 so that a non-ASCII character
/// survives a console whose code page is not UTF-8. `WriteFile` hands the
/// console raw UTF-8 instead. It is the same choice every C program that calls
/// `WriteFile` makes, it costs no conversion buffer, and it does not affect a
/// redirected stream — which is what a test, a pipe, and a file all are.
#[cfg(windows)]
fn write_some(stream: i32, bytes: &[u8]) -> isize {
    // `STD_OUTPUT_HANDLE` and `STD_ERROR_HANDLE`: -11 and -12, unsigned.
    let which = if stream == STDOUT { -11i32 as u32 } else { -12i32 as u32 };
    let len = if bytes.len() > u32::MAX as usize { u32::MAX } else { bytes.len() as u32 };
    let mut moved: u32 = 0;
    let ok = unsafe {
        WriteFile(
            GetStdHandle(which),
            bytes.as_ptr() as *const c_void,
            len,
            &mut moved,
            core::ptr::null_mut(),
        )
    };
    if ok == 0 { 0 } else { moved as isize }
}

/// Write bytes to a standard stream, unbuffered.
///
/// Every caller here flushed after every line already, so nothing is buffered
/// that was not before.
///
/// A write can come back having moved less than it was asked to: a partial
/// write filling a pipe, or a signal that interrupted it before it moved
/// anything. Both are retried. They are deliberately *not* told apart —
/// `errno` has three different spellings across the platforms this crate is
/// built for (`__errno_location`, `__error`, `_errno`) and no portable one,
/// and the distinction would not change what can be done about it. So progress
/// resets the budget and a fixed number of fruitless attempts ends it, which
/// terminates on a genuinely broken stream instead of spinning on it.
///
/// A write that fails for real is dropped in silence, because a runtime that
/// cannot write has nowhere to report that it could not write.
///
/// The count it returns is what `gf_file_write` reports; `console.log` has
/// nothing to do with it and ignores it, as it did when there was none.
fn stdio(stream: i32, bytes: &[u8]) -> usize {
    let mut written = 0;
    let mut fruitless = 0;
    while written < bytes.len() && fruitless < 16 {
        let n = write_some(stream, &bytes[written..]);
        if n > 0 {
            written += n as usize;
            fruitless = 0;
        } else {
            fruitless += 1;
        }
    }
    written
}

/// A line, written in one `write` so that two of them cannot interleave.
///
/// `std::io::stdout` held a lock to get this; a single `write` of at most
/// `PIPE_BUF` gets it from the kernel instead. Longer lines fall back to two
/// writes rather than growing a buffer — a runtime cannot allocate on the way
/// to reporting that allocation failed.
fn stdio_line(stream: i32, bytes: &[u8]) {
    let mut line = [0u8; 512];
    if bytes.len() < line.len() {
        line[..bytes.len()].copy_from_slice(bytes);
        line[bytes.len()] = b'\n';
        stdio(stream, &line[..bytes.len() + 1]);
    } else {
        stdio(stream, bytes);
        stdio(stream, b"\n");
    }
}

fn tracing() -> bool {
    if !TRACE_READ.swap(true, Ordering::SeqCst) {
        TRACE_ALLOC.store(env_is_set(c"GOBLIN_TRACE_ALLOC"), Ordering::SeqCst);
    }
    TRACE_ALLOC.load(Ordering::SeqCst)
}

fn trace(event: &str) {
    if !tracing() {
        return;
    }
    stdio_line(STDOUT, event.as_bytes());
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
    if !env_is_set(c"GOBLIN_LEAK_CHECK") {
        return;
    }
    unsafe { libc::atexit(report_leaks) };
}

extern "C" fn report_leaks() {
    let live = LIVE.load(Ordering::SeqCst);
    // A machine-readable line on stderr, distinct enough that a program
    // printing something similar by accident is not a plausible worry.
    let mut digits = Digits::new();
    let _ = write!(digits, "##goblin-live-allocations:{live}");
    stdio_line(STDERR, digits.as_bytes());
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/// The alignment `mi_malloc` gives without being asked for one.
///
/// Deliberately a machine word rather than mimalloc's `MI_MAX_ALIGN_SIZE` of
/// 16. mimalloc's own natural-alignment test is `alignment <= size` on top of
/// the size class, so a one-byte block really can come back 8-aligned and no
/// more; restating that rule here would be restating it wrongly. Eight is what
/// holds for every block, and every allocation this runtime makes today is at
/// or below it — so the branch below always takes the plain `mi_malloc` path
/// until an over-aligned type exists to need the other one.
const NATURAL_ALIGN: usize = align_of::<usize>();

/// `bytes` of storage, aligned to `align`, or null.
///
/// Where Rust's `alloc`/`dealloc` pair needed the `Layout` on *both* ends,
/// mimalloc takes every one of these back through the same one-argument
/// [`mi_free`] — including the over-aligned ones, which is the property the
/// whole free-side ABI rests on and which `_aligned_malloc` on Windows does
/// not have.
unsafe fn raw_alloc(bytes: usize, align: usize) -> *mut u8 {
    if align <= NATURAL_ALIGN {
        unsafe { mi_malloc(bytes).cast() }
    } else {
        unsafe { mi_malloc_aligned(bytes, align).cast() }
    }
}

/// `bytes` of storage where it is `base + offset` — not the base — that lands
/// on `align`.
///
/// What a header in front of the elements needs. Aligning the *base* would put
/// the elements `offset` bytes past an aligned address, which is only aligned
/// again when `offset` happens to be a multiple of `align`; that coincidence
/// held for every type this compiler can lay out today and would stop holding
/// on the first 32-byte vector.
unsafe fn raw_alloc_at(bytes: usize, align: usize, offset: usize) -> *mut u8 {
    if align <= NATURAL_ALIGN {
        // `offset` is a multiple of `align` here — both headers are whole
        // machine words — so the base's own alignment is the elements' too.
        unsafe { mi_malloc(bytes).cast() }
    } else {
        unsafe { mi_malloc_aligned_at(bytes, align, offset).cast() }
    }
}

/// Hand storage back. One argument, whatever it was allocated with.
unsafe fn raw_free(pointer: *mut u8) {
    unsafe { mi_free(pointer.cast()) };
}

/// Allocate an owned string of `len` bytes, uninitialised.
unsafe fn allocate(len: usize) -> GfStr {
    install_reporter();
    // header + bytes + the NUL that makes this a C string.
    let raw = unsafe { raw_alloc(HEADER + len + 1, ALIGN) };
    if raw.is_null() {
        abort();
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

/// Grow an owned string's block to hold `capacity` bytes, keeping what is in it.
///
/// **Not counted**, because nothing was allocated: this is the same allocation
/// with a different size, so touching `LIVE` here would report a leak on every
/// buffer that had to grow. `mi_realloc` rather than `raw_alloc` for the same
/// reason [`allocate`] uses `mi_malloc` — the header is two machine words, so
/// the block is naturally aligned and no over-aligned path is involved.
///
/// The caller owns keeping the header's `len` truthful; this only moves bytes.
unsafe fn reallocate(s: GfStr, capacity: usize) -> GfStr {
    unsafe {
        let raw = mi_realloc(header_of(s).cast(), HEADER + capacity + 1).cast::<u8>();
        if raw.is_null() {
            abort();
        }
        raw.add(HEADER)
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
        LIVE.fetch_sub(1, Ordering::SeqCst);
        raw_free(header as *mut u8);
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
//
// The *free* side takes neither. mimalloc is asked what a block was, where
// Rust's `dealloc` had to be told — so the one number a caller could get wrong
// is not a number any caller passes.
// ---------------------------------------------------------------------------

/// Storage for one value, **uninitialised**. The caller constructs into it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_alloc(size: usize, align: usize) -> *mut u8 {
    install_reporter();
    // A zero-sized type still gets a distinct address, as it does in C++: two
    // objects that exist are not the same object.
    let raw = unsafe { raw_alloc(size.max(1), align.max(1)) };
    if raw.is_null() {
        abort();
    }
    LIVE.fetch_add(1, Ordering::SeqCst);
    trace("alloc");
    raw
}

/// Release storage from [`gf_alloc`]. The value in it is already destroyed.
///
/// One argument. The block remembers its own size and alignment, so there is no
/// layout for a caller to reconstruct and therefore none to reconstruct wrongly
/// — which is why an erased `Pointer<unknown>` freed here would leak rather
/// than corrupt (it is still refused, by `GF0305`, because the *destructor*
/// cannot run without a type).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_free(pointer: *mut u8) {
    if pointer.is_null() {
        return;
    }
    LIVE.fetch_sub(1, Ordering::SeqCst);
    unsafe { raw_free(pointer) };
    trace("free");
}

// ---------------------------------------------------------------------------
// The allocator, published
//
// The prelude declares these eight as `mi_malloc`, `mi_calloc` and so on — the
// C names, because the whole point is that a call to
// `SDL_SetMemoryFunctions(mi_malloc, …)` type-checks against a signature C
// wrote. What is *emitted* is the `gf_` name below, and the indirection is
// worth one jump for a reason that only shows up when the runtime is a shared
// library.
//
// A cdylib exports the Rust symbols it defines. It does **not** re-export C
// symbols that arrived from a native static library it linked, and each
// platform hides them differently: MSVC needs `/EXPORT:` per symbol, ELF has a
// version script whose `local: *` wins over `--export-dynamic-symbol`, and
// Mach-O refuses `-exported_symbol` beside the `-exported_symbols_list` rustc
// already passes. Three mechanisms, one of them a hard link error, and only the
// first testable on the machine this was written on.
//
// A trampoline is a Rust symbol, so it exports from a staticlib and a cdylib
// identically, on all three, with no linker argument anywhere. The second
// benefit is the one that will matter later: this is *our* ABI, so the
// allocator underneath it can change again without the published surface
// moving.
// ---------------------------------------------------------------------------

/// C's `malloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_mi_malloc(size: usize) -> *mut c_void {
    unsafe { mi_malloc(size) }
}

/// C's `calloc`: `count * size` bytes, zeroed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_mi_calloc(count: usize, size: usize) -> *mut c_void {
    unsafe { mi_calloc(count, size) }
}

/// C's `realloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_mi_realloc(pointer: *mut c_void, size: usize) -> *mut c_void {
    unsafe { mi_realloc(pointer, size) }
}

/// C's `free`. A null pointer is a no-op, as it is in C.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_mi_free(pointer: *mut c_void) {
    unsafe { mi_free(pointer) };
}

/// `size` bytes, zeroed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_mi_zalloc(size: usize) -> *mut c_void {
    unsafe { mi_zalloc(size) }
}

/// `size` bytes on an `align` boundary, freed through the same [`gf_mi_free`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_mi_malloc_aligned(size: usize, align: usize) -> *mut c_void {
    unsafe { mi_malloc_aligned(size, align) }
}

/// `realloc`, keeping the block on an `align` boundary.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_mi_realloc_aligned(
    pointer: *mut c_void,
    size: usize,
    align: usize,
) -> *mut c_void {
    unsafe { mi_realloc_aligned(pointer, size, align) }
}

/// Usable bytes at `pointer`; nought for null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_mi_usable_size(pointer: *mut c_void) -> usize {
    unsafe { mi_usable_size(pointer) }
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
// mimalloc *can* be asked, but the cookie stays unconditional all the same: it
// carries the **count**, and `p.freeArray()` needs that to know how many
// destructors to run, which is a question no allocator answers.
//
// The header is one machine word and its size is a *constant*, not a function
// of the element's alignment. That is what lets `gf_free_array` and
// `gf_alloc_array_count` take a pointer and nothing else: the base is always
// exactly `RUN_HEADER` bytes back. An over-aligned element is handled by
// aligning the *elements* rather than the base — see `raw_alloc_at` — instead
// of by growing the header to `align` bytes and having to be told `align`
// again on the way out.
// ---------------------------------------------------------------------------

/// The hidden word in front of a run: the element count.
///
/// Named for the *run* rather than for the array, because `T[]` a few hundred
/// lines down has a header of its own and a different one — that one carries a
/// length and a capacity and belongs to a growable container, where this is one
/// hidden word behind a raw pointer.
const RUN_HEADER: usize = core::mem::size_of::<usize>();

/// Storage for `count` elements, **uninitialised**, with the count remembered.
///
/// `stride` is what one element occupies in an array — the size rounded up to
/// the alignment, which is what C's `sizeof` reports and what the backend's
/// indexing strides by. Passing the unrounded size instead overlaps the
/// elements with each other (REWRITE-PLAN §10).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_alloc_array(count: usize, stride: usize, align: usize) -> *mut u8 {
    install_reporter();
    let bytes = stride
        .checked_mul(count)
        .and_then(|total| total.checked_add(RUN_HEADER))
        .expect("array too large");
    let raw = unsafe { raw_alloc_at(bytes, align.max(1), RUN_HEADER) };
    if raw.is_null() {
        abort();
    }
    unsafe { raw.cast::<usize>().write(count) };
    LIVE.fetch_add(1, Ordering::SeqCst);
    trace("alloc");
    unsafe { raw.add(RUN_HEADER) }
}

/// How many elements [`gf_alloc_array`] was asked for.
///
/// Read back rather than remembered by the caller, which is the whole reason
/// the cookie exists: `p.freeArray()` names a pointer and nothing else.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_alloc_array_count(pointer: *mut u8) -> usize {
    if pointer.is_null() {
        return 0;
    }
    unsafe { pointer.sub(RUN_HEADER).cast::<usize>().read() }
}

/// Release storage from [`gf_alloc_array`]. The elements are already destroyed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_free_array(pointer: *mut u8) {
    if pointer.is_null() {
        return;
    }
    LIVE.fetch_sub(1, Ordering::SeqCst);
    unsafe { raw_free(pointer.sub(RUN_HEADER)) };
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

/// The bytes a buffer of `cap` elements occupies, header included.
///
/// The header is a fixed two words and does *not* grow with the element's
/// alignment. Keeping the elements aligned is [`raw_alloc_at`]'s job: it aligns
/// `base + ARRAY_HEADER` rather than `base`, so the two are correct
/// independently. Rounding the header up to the element's alignment instead
/// would leave `gf_array_free` needing to be told that alignment again to find
/// its way back — and the previous arrangement, which aligned the *base* and
/// left the header at two words, quietly under-aligned any element wanting
/// more than the header's own 16 bytes.
fn array_bytes(cap: u64, stride: u64) -> usize {
    ARRAY_HEADER + (cap as usize) * (stride as usize)
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
    let align = (align as usize).max(1);
    let raw = unsafe { raw_alloc_at(array_bytes(len, stride), align, ARRAY_HEADER) };
    if raw.is_null() {
        abort();
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
            let align = (align as usize).max(1);
            let raw = raw_alloc_at(array_bytes(grown, stride), align, ARRAY_HEADER);
            if raw.is_null() {
                abort();
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
                raw_free(header as *mut u8);
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
///
/// The handle and nothing else. The header is a fixed distance behind it and
/// the block remembers its own size, so neither the stride nor the alignment
/// has to be carried back to the one place that used to need them.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_array_free(a: GfArray) {
    if a.is_null() {
        return;
    }
    unsafe {
        let header = array_header(a);
        // Static, so there is nothing to give back — the empty array.
        if (*header).cap == 0 {
            return;
        }
        LIVE.fetch_sub(1, Ordering::SeqCst);
        raw_free(header as *mut u8);
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

unsafe extern "C" {
    /// `trunc`, from libm.
    ///
    /// `core` has the float *predicates* — `is_nan`, `is_infinite`, and since
    /// recently `abs` — but not the rounding, which stayed in std because it
    /// is a call into libm rather than an instruction. This crate already
    /// links `-lm` (it is in `--print native-static-libs`), so the declaration
    /// is all that was missing. Declared rather than reimplemented on purpose:
    /// a hand-rolled `trunc` over the exponent field is four lines that are
    /// wrong for subnormals and right for every value anyone would test it
    /// with.
    fn trunc(value: f64) -> f64;
}

/// Room for the widest thing [`Digits`] is ever asked to hold.
///
/// Set by `f64`, and larger than it looks like it needs to be, because
/// `Display for f64` never switches to exponent notation: it writes the
/// shortest round-tripping decimal *in full*. The widest is the smallest
/// subnormal, `-5e-324`, which is 327 bytes of mostly zeroes — not the ~24 a
/// reading of "shortest round-tripping" suggests.
///
/// This was originally 64, on exactly that misreading, and the result was that
/// `${5e-324}` interpolated to `0.` — a truncation that is not obviously
/// wrong at a glance, which is the kind this project goes out of its way not
/// to ship.
const DIGITS: usize = 384;

/// A stack buffer that a `core::fmt` value can be written into.
///
/// What `to_string` was, without the heap.
///
/// The point of routing through `core::fmt` rather than dividing by ten by
/// hand is [`gf_string_from_f64`]: `Display for f64` is the shortest
/// round-tripping form, it lives in `core`, and reimplementing it is how a
/// float starts printing differently from the TypeScript it was ported from.
struct Digits {
    buffer: [u8; DIGITS],
    len: usize,
}

impl Digits {
    fn new() -> Self {
        Digits { buffer: [0; DIGITS], len: 0 }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.buffer[..self.len]
    }
}

impl Write for Digits {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let bytes = s.as_bytes();
        // Aborts rather than returning `Err`, which `write!` would swallow into
        // a short string. [`DIGITS`] is provably enough for every caller, so
        // arriving here means that proof stopped holding — and a loud stop is
        // worth more than a number that is quietly missing its tail.
        if self.len + bytes.len() > DIGITS {
            abort();
        }
        self.buffer[self.len..self.len + bytes.len()].copy_from_slice(bytes);
        self.len += bytes.len();
        Ok(())
    }
}

/// `Display`, into a fresh `string`.
fn from_display(value: impl core::fmt::Display) -> GfStr {
    let mut digits = Digits::new();
    let _ = write!(digits, "{value}");
    unsafe { from_bytes(digits.as_bytes()) }
}

#[unsafe(no_mangle)]
pub extern "C" fn gf_string_from_i64(value: i64) -> GfStr {
    from_display(value)
}

#[unsafe(no_mangle)]
pub extern "C" fn gf_string_from_u64(value: u64) -> GfStr {
    from_display(value)
}

/// Formatted the way JavaScript formats a number, so that a value printed by a
/// Goblin program reads the same as the same value printed by the TypeScript it
/// was written to resemble.
#[unsafe(no_mangle)]
pub extern "C" fn gf_string_from_f64(value: f64) -> GfStr {
    if value.is_nan() {
        return unsafe { from_bytes(b"NaN") };
    }
    if value.is_infinite() {
        let text: &[u8] = if value > 0.0 { b"Infinity" } else { b"-Infinity" };
        return unsafe { from_bytes(text) };
    }
    if value == unsafe { trunc(value) } && value.abs() < 1e21 {
        // `1.0` prints as `1`, as it does in JavaScript.
        return from_display(value as i64);
    }
    from_display(value)
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
    // Unbuffered: a program that aborts should still have printed what it
    // printed, and a test that compares stdout exactly cannot be at the mercy
    // of buffering.
    stdio_line(STDOUT, unsafe { bytes_of(s) });
}

/// `console.warn`, `console.error` — one line to stderr, matching Node.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_eprint(s: GfStr) {
    stdio_line(STDERR, unsafe { bytes_of(s) });
}

// ---------------------------------------------------------------------------
// Files — `std/io`, from the runtime side
//
// A `File` is an **opaque handle**: the language never sees inside one, so
// everything it can be asked lives here and the layout below is free to change
// without anything recompiling against it.
//
// **The standard streams are not C streams here, and that is deliberate.**
// Writing to stdout through the CRT on Windows turns every `\n` into `\r\n` —
// the bug `write_some` above exists to avoid, and the one that broke every test
// asserting on exact output. So `gf_stdout` and `gf_stderr` route through the
// same unbuffered path `console.log` uses, and only a file opened by name is a
// `FILE *`. Reading is the same arrangement in the other direction.
//
// Two consequences worth stating, because both are what a caller will notice:
//
//   * **A handle from `gf_file_open` is counted** by the live-allocation check,
//     like every other allocation this runtime hands out. So a program that
//     forgets to close a file fails the harness's automatic check rather than
//     leaking a descriptor quietly — which is the whole argument for spending an
//     allocation on a handle that could have been an integer.
//   * **The three standard streams are static** and therefore counted by
//     nothing. Closing one is a no-op rather than an error: they are the
//     platform's, they outlive the program, and a `close` that worked would take
//     `console.log` down with it.
// ---------------------------------------------------------------------------

/// An open file, behind the language's `Pointer<File>`.
#[repr(C)]
pub struct GfFile {
    /// The C stream, or null when this is one of the standard streams.
    stream: *mut libc::FILE,
    /// Which standard stream, when `stream` is null.
    standard: i32,
    /// Whether closing this is ours to do. Zero for the standard streams.
    owned: i32,
}

/// A standard stream, which is `static` and therefore shared.
///
/// `Sync` is the claim that sharing it is safe, and here it is true in the
/// strongest way available: every field is written once, by the `const`
/// constructor below, and nothing ever writes one again.
#[repr(transparent)]
struct StandardFile(GfFile);

// SAFETY: immutable after construction, and construction is a `const fn`.
unsafe impl Sync for StandardFile {}

const fn standard_stream(which: i32) -> StandardFile {
    StandardFile(GfFile { stream: core::ptr::null_mut(), standard: which, owned: 0 })
}

static STDIN_FILE: StandardFile = standard_stream(STDIN);
static STDOUT_FILE: StandardFile = standard_stream(STDOUT);
static STDERR_FILE: StandardFile = standard_stream(STDERR);

/// The address of a standard stream's handle.
///
/// `cast_mut` on something that is genuinely immutable, which is sound because
/// nothing writes through the result: every path below reads the fields and
/// `gf_file_close` returns early on `owned == 0` before it could do anything
/// else. The pointer is `*mut` only because that is what the language's
/// `Pointer<File>` is.
fn standard_handle(file: &'static StandardFile) -> *mut GfFile {
    core::ptr::from_ref(file).cast_mut().cast::<GfFile>()
}

/// Standard input.
#[unsafe(no_mangle)]
pub extern "C" fn gf_stdin() -> *mut GfFile {
    standard_handle(&STDIN_FILE)
}

/// Standard output — the same stream, and the same bytes, as `console.log`.
#[unsafe(no_mangle)]
pub extern "C" fn gf_stdout() -> *mut GfFile {
    standard_handle(&STDOUT_FILE)
}

/// Standard error.
#[unsafe(no_mangle)]
pub extern "C" fn gf_stderr() -> *mut GfFile {
    standard_handle(&STDERR_FILE)
}

/// Open a file by name. Null when it could not be opened.
///
/// Both arguments are Goblin strings, which are nul-terminated by construction
/// — so they are already the `const char *` `fopen` wants, with no conversion
/// and no copy.
///
/// # Safety
///
/// `path` and `mode` must be strings this runtime produced, or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_file_open(path: GfStr, mode: GfStr) -> *mut GfFile {
    if path.is_null() || mode.is_null() {
        return core::ptr::null_mut();
    }
    let stream = unsafe { libc::fopen(path.cast::<c_char>(), mode.cast::<c_char>()) };
    if stream.is_null() {
        return core::ptr::null_mut();
    }
    // Counted, like every other allocation, so that a file nobody closed is a
    // failing leak check rather than a descriptor nobody notices.
    let handle = unsafe { gf_alloc(size_of::<GfFile>(), align_of::<GfFile>()) }.cast::<GfFile>();
    unsafe { handle.write(GfFile { stream, standard: 0, owned: 1 }) };
    handle
}

/// Close a file and release its handle — C's `fclose`, and just as final.
///
/// One call, not two: the descriptor and the handle go together, so there is no
/// order for a caller to get wrong. A standard stream is a no-op.
///
/// # Safety
///
/// `file` must be a handle from [`gf_file_open`] or a standard stream, and must
/// not be used again afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_file_close(file: *mut GfFile) {
    if file.is_null() {
        return;
    }
    let handle = unsafe { &*file };
    if handle.owned == 0 {
        return;
    }
    if !handle.stream.is_null() {
        unsafe { libc::fclose(handle.stream) };
    }
    unsafe { gf_free(file.cast::<u8>()) };
}

/// Write a string's bytes, returning how many moved.
///
/// The string is **borrowed**: the caller still owns it and this never frees
/// it, which is the same rule every other parameter of this runtime follows.
///
/// # Safety
///
/// `file` must be an open handle and `text` a string this runtime produced.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_file_write(file: *mut GfFile, text: GfStr) -> usize {
    if file.is_null() {
        return 0;
    }
    let handle = unsafe { &*file };
    let bytes = unsafe { bytes_of(text) };
    if bytes.is_empty() {
        return 0;
    }
    if handle.stream.is_null() {
        stdio(handle.standard, bytes)
    } else {
        unsafe { libc::fwrite(bytes.as_ptr().cast::<c_void>(), 1, bytes.len(), handle.stream) }
    }
}

/// Read at most `max` bytes, as a string the caller owns.
///
/// **An empty result means there is no more input.** That is the whole
/// end-of-file story, and it is one rule rather than two: a `feof` to go with it
/// would answer for a `FILE *` and have nothing to say about a standard stream,
/// which has no such flag to read.
///
/// The allocation is made at full size and then *shortened*, rather than copied
/// into a right-sized second one. The block remembers its own size, so the
/// header's `len` is the only thing that has to agree with the bytes — which
/// makes a short read one allocation rather than two.
///
/// # Safety
///
/// `file` must be an open handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_file_read(file: *mut GfFile, max: usize) -> GfStr {
    if file.is_null() || max == 0 {
        return unsafe { from_bytes(b"") };
    }
    let handle = unsafe { &*file };
    let text = unsafe { allocate(max) };
    let buffer = unsafe { core::slice::from_raw_parts_mut(text, max) };

    let read = if handle.stream.is_null() {
        let moved = read_some(handle.standard, buffer);
        if moved < 0 { 0 } else { moved as usize }
    } else {
        unsafe { libc::fread(buffer.as_mut_ptr().cast::<c_void>(), 1, max, handle.stream) }
    };

    let read = read.min(max);
    unsafe {
        (*header_of(text)).len = read as u64;
        // The nul moves with the length: this is still a valid C string.
        text.add(read).write(0);
    }
    text
}

/// Flush whatever is buffered. The standard streams are unbuffered here, so
/// this is a no-op on them rather than a lie.
///
/// # Safety
///
/// `file` must be an open handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_file_flush(file: *mut GfFile) {
    if file.is_null() {
        return;
    }
    let handle = unsafe { &*file };
    if !handle.stream.is_null() {
        unsafe { libc::fflush(handle.stream) };
    }
}

// -- seeking ----------------------------------------------------------------
//
// `fseek` takes a `long`, which is **32 bits on Windows** — so the obvious
// spelling silently caps every offset at 2 GB on one of the three platforms
// this is built for, and does it without a diagnostic anywhere. Each platform's
// 64-bit spelling is used instead: `_fseeki64` on MSVC, `fseeko` elsewhere.
//
// The `Seek` values crossing from Goblin are **ours**, not C's. They are mapped
// to `SEEK_SET` and friends here rather than being declared as whatever the
// platform's headers happen to number them, because a constant that has to
// agree with a C macro is a constant that will eventually disagree with it.

#[cfg(windows)]
unsafe extern "C" {
    fn _fseeki64(stream: *mut libc::FILE, offset: i64, whence: i32) -> i32;
    fn _ftelli64(stream: *mut libc::FILE) -> i64;
}

#[cfg(windows)]
unsafe fn seek_stream(stream: *mut libc::FILE, offset: i64, whence: i32) -> i32 {
    unsafe { _fseeki64(stream, offset, whence) }
}

#[cfg(windows)]
unsafe fn tell_stream(stream: *mut libc::FILE) -> i64 {
    unsafe { _ftelli64(stream) }
}

#[cfg(not(windows))]
unsafe fn seek_stream(stream: *mut libc::FILE, offset: i64, whence: i32) -> i32 {
    unsafe { libc::fseeko(stream, offset as libc::off_t, whence) }
}

#[cfg(not(windows))]
unsafe fn tell_stream(stream: *mut libc::FILE) -> i64 {
    unsafe { libc::ftello(stream) as i64 }
}

/// `Seek.Set`, `Seek.Current`, `Seek.End` — the language's own numbering.
const SEEK_FROM_START: i32 = 0;
const SEEK_FROM_CURRENT: i32 = 1;
const SEEK_FROM_END: i32 = 2;

fn whence_of(from: i32) -> i32 {
    match from {
        SEEK_FROM_START => libc::SEEK_SET,
        SEEK_FROM_CURRENT => libc::SEEK_CUR,
        SEEK_FROM_END => libc::SEEK_END,
        // Unreachable rather than lenient: the frontend has already limited
        // this to the enum's three members. "From the start" is simply the
        // answer that loses least if that ever stops being true.
        _ => libc::SEEK_SET,
    }
}

/// Move the read/write position. False when the file could not be moved.
///
/// A standard stream is not seekable and answers false rather than pretending.
///
/// # Safety
///
/// `file` must be an open handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_file_seek(file: *mut GfFile, offset: i64, from: i32) -> u8 {
    if file.is_null() {
        return 0;
    }
    let handle = unsafe { &*file };
    if handle.stream.is_null() {
        return 0;
    }
    u8::from(unsafe { seek_stream(handle.stream, offset, whence_of(from)) } == 0)
}

/// Where the position is now, in bytes from the start. `-1` when there is none.
///
/// # Safety
///
/// `file` must be an open handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_file_tell(file: *mut GfFile) -> i64 {
    if file.is_null() {
        return -1;
    }
    let handle = unsafe { &*file };
    if handle.stream.is_null() {
        return -1;
    }
    unsafe { tell_stream(handle.stream) }
}

/// How many bytes the file holds. `-1` when that cannot be known.
///
/// Asked by seeking to the end and back rather than by `stat`: the position is
/// restored exactly, so this is an observation rather than a side effect. A
/// standard stream has no size and says so.
///
/// # Safety
///
/// `file` must be an open handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_file_size(file: *mut GfFile) -> i64 {
    if file.is_null() {
        return -1;
    }
    let handle = unsafe { &*file };
    if handle.stream.is_null() {
        return -1;
    }
    unsafe {
        let here = tell_stream(handle.stream);
        if here < 0 || seek_stream(handle.stream, 0, libc::SEEK_END) != 0 {
            return -1;
        }
        let end = tell_stream(handle.stream);
        // Put it back whatever the answer was, including when there was none:
        // a failed size must not also have moved the file.
        if seek_stream(handle.stream, here, libc::SEEK_SET) != 0 {
            return -1;
        }
        end
    }
}

/// Read from the position to the end, as a `string` the calling scope owns.
///
/// **From the position, not from the start.** So it composes with
/// `gf_file_seek`, and reading a whole file is `seek(0, Set)` away when
/// something has already been read.
///
/// The buffer starts at what is left of a seekable file and doubles otherwise,
/// which is what makes this work on `stdin()` — a stream with no size to ask
/// for. One byte of slack is deliberate: it lets the read that reports the end
/// happen without another growth, so the exact-size case allocates once.
///
/// # Safety
///
/// `file` must be an open handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gf_file_read_all(file: *mut GfFile) -> GfStr {
    if file.is_null() {
        return unsafe { from_bytes(b"") };
    }
    let handle = unsafe { &*file };

    let mut capacity = 4096;
    if !handle.stream.is_null() {
        let here = unsafe { tell_stream(handle.stream) };
        let end = unsafe { gf_file_size(file) };
        if here >= 0 && end > here {
            capacity = (end - here) as usize + 1;
        }
    }

    let mut text = unsafe { allocate(capacity) };
    let mut len = 0usize;
    loop {
        if len == capacity {
            capacity = capacity.saturating_mul(2);
            text = unsafe { reallocate(text, capacity) };
        }
        let room = unsafe { core::slice::from_raw_parts_mut(text.add(len), capacity - len) };
        let read = if handle.stream.is_null() {
            let moved = read_some(handle.standard, room);
            if moved < 0 { 0 } else { moved as usize }
        } else {
            unsafe { libc::fread(room.as_mut_ptr().cast::<c_void>(), 1, room.len(), handle.stream) }
        };
        if read == 0 {
            break;
        }
        len += read.min(room.len());
    }

    unsafe {
        (*header_of(text)).len = len as u64;
        text.add(len).write(0);
    }
    text
}

// ---------------------------------------------------------------------------
// Scalar maths — `std/math`, from the runtime side
//
// **Two of everything, because there are two float widths.** `dsin` takes an
// `f64` and `fsin` an `f32`, and neither promotes: a language with fixed widths
// and no implicit narrowing cannot have one `sin` without deciding, silently,
// which width a caller meant. The prefix is the decision, written down.
//
// The implementation is the `libm` crate rather than the platform's, and the
// reasoning is in `Cargo.toml` beside the dependency: nothing adds `-lm` to a
// Goblin link, and a MUSL port gives the same answer on all three targets where
// the platforms' own libms disagree in the last ulp. This project asserts on
// printed output, so that difference is one expected string against three.
//
// These are the only entry points here that are **not** `unsafe`: a float is a
// float, there is no pointer to get wrong, and every one of them is total —
// `dsqrt(-1)` is a NaN rather than a trap, exactly as C's is.
// ---------------------------------------------------------------------------

/// `f(x)`, for one float in and one out.
macro_rules! unary {
    ($ty:ty, $($symbol:ident = $implementation:path,)*) => {
        $(
            #[unsafe(no_mangle)]
            pub extern "C" fn $symbol(x: $ty) -> $ty {
                $implementation(x)
            }
        )*
    };
}

/// `f(x, y)`, for two floats in and one out.
macro_rules! binary {
    ($ty:ty, $($symbol:ident = $implementation:path,)*) => {
        $(
            #[unsafe(no_mangle)]
            pub extern "C" fn $symbol(x: $ty, y: $ty) -> $ty {
                $implementation(x, y)
            }
        )*
    };
}

/// A question about a float, answered as the `u8` a `boolean` crosses as.
macro_rules! predicate {
    ($ty:ty, $($symbol:ident = $method:ident,)*) => {
        $(
            #[unsafe(no_mangle)]
            pub extern "C" fn $symbol(x: $ty) -> u8 {
                u8::from(<$ty>::$method(x))
            }
        )*
    };
}

/// A constant, as a call — the language has no top-level `const` to bind it to.
macro_rules! constant {
    ($ty:ty, $($symbol:ident = $value:expr,)*) => {
        $(
            #[unsafe(no_mangle)]
            pub extern "C" fn $symbol() -> $ty {
                $value
            }
        )*
    };
}

unary!(
    f64,
    gf_dsin = libm::sin,
    gf_dcos = libm::cos,
    gf_dtan = libm::tan,
    gf_dasin = libm::asin,
    gf_dacos = libm::acos,
    gf_datan = libm::atan,
    gf_dsinh = libm::sinh,
    gf_dcosh = libm::cosh,
    gf_dtanh = libm::tanh,
    gf_dexp = libm::exp,
    gf_dexp2 = libm::exp2,
    gf_dlog = libm::log,
    gf_dlog2 = libm::log2,
    gf_dlog10 = libm::log10,
    gf_dsqrt = libm::sqrt,
    gf_dcbrt = libm::cbrt,
    gf_dfloor = libm::floor,
    gf_dceil = libm::ceil,
    gf_dround = libm::round,
    gf_dtrunc = libm::trunc,
    gf_dabs = libm::fabs,
);

unary!(
    f32,
    gf_fsin = libm::sinf,
    gf_fcos = libm::cosf,
    gf_ftan = libm::tanf,
    gf_fasin = libm::asinf,
    gf_facos = libm::acosf,
    gf_fatan = libm::atanf,
    gf_fsinh = libm::sinhf,
    gf_fcosh = libm::coshf,
    gf_ftanh = libm::tanhf,
    gf_fexp = libm::expf,
    gf_fexp2 = libm::exp2f,
    gf_flog = libm::logf,
    gf_flog2 = libm::log2f,
    gf_flog10 = libm::log10f,
    gf_fsqrt = libm::sqrtf,
    gf_fcbrt = libm::cbrtf,
    gf_ffloor = libm::floorf,
    gf_fceil = libm::ceilf,
    gf_fround = libm::roundf,
    gf_ftrunc = libm::truncf,
    gf_fabs = libm::fabsf,
);

binary!(
    f64,
    gf_datan2 = libm::atan2,
    gf_dpow = libm::pow,
    gf_dhypot = libm::hypot,
    gf_dfmod = libm::fmod,
    gf_dmin = libm::fmin,
    gf_dmax = libm::fmax,
    gf_dcopysign = libm::copysign,
);

binary!(
    f32,
    gf_fatan2 = libm::atan2f,
    gf_fpow = libm::powf,
    gf_fhypot = libm::hypotf,
    gf_ffmod = libm::fmodf,
    gf_fmin = libm::fminf,
    gf_fmax = libm::fmaxf,
    gf_fcopysign = libm::copysignf,
);

predicate!(
    f64,
    gf_disnan = is_nan,
    gf_disinf = is_infinite,
    gf_disfinite = is_finite,
);

predicate!(
    f32,
    gf_fisnan = is_nan,
    gf_fisinf = is_infinite,
    gf_fisfinite = is_finite,
);

constant!(
    f64,
    gf_dpi = core::f64::consts::PI,
    gf_dtau = core::f64::consts::TAU,
    gf_de = core::f64::consts::E,
    gf_dinf = f64::INFINITY,
    gf_dnan = f64::NAN,
);

constant!(
    f32,
    gf_fpi = core::f32::consts::PI,
    gf_ftau = core::f32::consts::TAU,
    gf_fe = core::f32::consts::E,
    gf_finf = f32::INFINITY,
    gf_fnan = f32::NAN,
);

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
        return core::ptr::null();
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
    core::ptr::null()
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

// ---------------------------------------------------------------------------
// Tests
//
// Only the alignment invariants, and deliberately: everything else here is
// exercised by real programs in `tests/`, which is where a runtime bug should
// be caught. Alignment is the exception, because the compiler cannot yet lay
// out a type wanting more than eight bytes — so the one arrangement these
// functions have to get right for the SIMD work to land is the one no Goblin
// program can currently ask for.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Alignments a vector type would plausibly want, either side of the
    /// `NATURAL_ALIGN` branch: SSE, AVX, AVX-512, and one past it.
    const ALIGNMENTS: [usize; 6] = [1, 8, 16, 32, 64, 128];

    #[test]
    fn a_headerless_block_lands_on_its_alignment() {
        for align in ALIGNMENTS {
            for size in [1usize, 7, 64, 4096] {
                let p = unsafe { raw_alloc(size, align) };
                assert!(!p.is_null(), "raw_alloc({size}, {align}) failed");
                assert_eq!(
                    p as usize % align,
                    0,
                    "raw_alloc({size}, {align}) came back at {p:p}"
                );
                unsafe { raw_free(p) };
            }
        }
    }

    /// The property the array headers depend on, and the one the previous
    /// arrangement got wrong: it is `base + offset` that has to be aligned, not
    /// `base`. Aligning the base and leaving a fixed header in front of the
    /// elements only works while the header happens to be a multiple of the
    /// element's alignment — true of every type this compiler lays out today,
    /// and false for the first 32-byte vector.
    #[test]
    fn a_header_leaves_the_elements_on_their_alignment() {
        for align in ALIGNMENTS {
            for offset in [RUN_HEADER, ARRAY_HEADER] {
                // A batch, held live so the blocks are distinct addresses. One
                // sample would pass a broken implementation once every `align`
                // tries by landing right anyway, which is exactly the sort of
                // test that reports green while the bug ships.
                let mut blocks = [core::ptr::null_mut::<u8>(); 16];
                for block in &mut blocks {
                    let p = unsafe { raw_alloc_at(offset + 256, align, offset) };
                    assert!(!p.is_null(), "raw_alloc_at(_, {align}, {offset}) failed");
                    assert_eq!(
                        (p as usize + offset) % align,
                        0,
                        "elements at {offset} past {p:p} are not {align}-aligned"
                    );
                    *block = p;
                }
                for block in blocks {
                    unsafe { raw_free(block) };
                }
            }
        }
    }

    /// A run remembers its count and hands the storage back through a free that
    /// is told neither the stride nor the alignment.
    #[test]
    fn a_run_round_trips_on_the_pointer_alone() {
        for align in ALIGNMENTS {
            for count in [0usize, 1, 37] {
                let stride = align.max(1);
                let p = unsafe { gf_alloc_array(count, stride, align) };
                assert_eq!(unsafe { gf_alloc_array_count(p) }, count);
                assert_eq!(p as usize % align, 0, "elements of a run are misaligned");
                unsafe { gf_free_array(p) };
            }
        }
    }

    /// The same for `T[]`, whose header is two words rather than one.
    #[test]
    fn an_array_round_trips_on_the_handle_alone() {
        for align in ALIGNMENTS {
            let stride = align.max(1) as u64;
            let a = unsafe { gf_array_new(9, stride, align as u64) };
            assert_eq!(unsafe { gf_array_len(a) }, 9);
            assert_eq!(a as usize % align, 0, "elements of a `T[]` are misaligned");
            unsafe { gf_array_free(a) };
        }
    }

    /// Freeing the shared empty array is a no-op rather than a free of static
    /// data — `cap == 0` is what says so, and it is read through the handle the
    /// same way now that nothing else is passed.
    #[test]
    fn the_empty_array_is_never_given_back() {
        let a = gf_array_empty();
        unsafe { gf_array_free(a) };
        unsafe { gf_array_free(a) };
        assert_eq!(unsafe { gf_array_len(a) }, 0);
    }

    /// Every free in the ABI takes a null pointer and does nothing with it.
    #[test]
    fn a_null_pointer_is_nobodys_block() {
        unsafe {
            gf_free(core::ptr::null_mut());
            gf_free_array(core::ptr::null_mut());
            gf_array_free(core::ptr::null_mut());
            gf_string_free(core::ptr::null_mut());
            assert_eq!(gf_alloc_array_count(core::ptr::null_mut()), 0);
        }
    }
}
