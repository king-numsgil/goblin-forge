//! Source positions.
//!
//! These exist for debug info, not for diagnostics. Per REWRITE-PLAN §8, the
//! backend never reports a user error, so it never needs to point at source —
//! but `debugInfo: true` has to put a line number in the object file, and that
//! line number has to come from somewhere.

use postcard_schema::Schema;
use serde::{Deserialize, Serialize};

use crate::ids::FileId;

/// A position in a source file. 1-based line and column, matching what tsc
/// reports and what every debugger expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Schema)]
pub struct Span {
    pub file: FileId,
    pub line: u32,
    pub col: u32,
}

impl Span {
    /// A position for generated code that corresponds to nothing the user
    /// wrote. Debug info skips these rather than attributing them to line 0 of
    /// whatever file happened to be first.
    pub const SYNTHETIC: Span = Span {
        file: FileId(0),
        line: 0,
        col: 0,
    };

    #[inline]
    pub const fn is_synthetic(self) -> bool {
        self.line == 0
    }
}
