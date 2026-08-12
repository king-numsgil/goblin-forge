//! Backend errors, and why they are loud.
//!
//! REWRITE-PLAN §8, hard rule 1: **the backend never reports a user error.**
//! Every failure reachable from source that tsc accepted is a missing frontend
//! check. v1 violated this — `someF64 % 2` reached Cranelift and produced
//! `error: compiling function 'main': Rem is not defined on f64`, with no code,
//! no file and no line.
//!
//! The enforcement is the second half of that rule: in debug builds these
//! panic. A test that trips one fails loudly instead of looking like a clean
//! rejection, which is the failure mode that let v1's version survive.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};

/// Something the backend could not do.
///
/// Reaching one of these from a program tsc accepted is a compiler bug, not a
/// user error. The message is written for whoever has to fix the compiler.
#[derive(Debug, Clone)]
pub struct InternalError {
    pub message: String,
    /// The function being compiled, when there is one.
    pub function: Option<String>,
}

impl fmt::Display for InternalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.function {
            Some(function) => write!(f, "while compiling `{function}`: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for InternalError {}

pub type Result<T> = std::result::Result<T, InternalError>;

impl InternalError {
    pub fn new(message: impl Into<String>) -> Self {
        InternalError {
            message: message.into(),
            function: None,
        }
    }

    /// Attach the function being compiled, if it is not already attached.
    pub fn in_function(mut self, name: impl Into<String>) -> Self {
        self.function.get_or_insert_with(|| name.into());
        self
    }
}

/// Whether an internal error panics instead of returning.
///
/// Defaults to on in debug builds, and the test harness turns it on explicitly
/// so that it also holds for the release addon the tests actually load. A
/// build-mode `cfg!` alone would have meant the enforcement quietly evaporating
/// in exactly the configuration everything is tested in.
static PANIC_ON_INTERNAL: AtomicBool = AtomicBool::new(cfg!(debug_assertions));

/// Turn the panic on or off. See [`PANIC_ON_INTERNAL`].
pub fn set_panic_on_internal_errors(value: bool) {
    PANIC_ON_INTERNAL.store(value, Ordering::Relaxed);
}

pub fn panics_on_internal_errors() -> bool {
    PANIC_ON_INTERNAL.load(Ordering::Relaxed)
}

/// Raise an [`InternalError`], panicking when configured to.
///
/// The panic is the point. A backend error that comes back as a polite `Result`
/// is indistinguishable, from a test's perspective, from the compiler correctly
/// rejecting a program — which is how v1's `Rem is not defined on f64` survived.
/// REWRITE-PLAN §9 asks for `expectRejected` to require a diagnostic code for
/// the same reason; this is the other half of the same guard.
#[macro_export]
macro_rules! internal_error {
    ($($arg:tt)*) => {{
        let message = format!($($arg)*);
        if $crate::error::panics_on_internal_errors() {
            panic!(
                "goblin backend: {message}\n\n\
                 This is a compiler bug. The backend reached a case the frontend \
                 should have rejected or should never have emitted. It panics \
                 rather than returning a diagnostic so that a test cannot mistake \
                 it for the compiler correctly rejecting a program."
            );
        }
        return Err($crate::error::InternalError::new(message));
    }};
}
