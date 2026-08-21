//! Static data: constants with relocations in them.
//!
//! A vtable slot holds a function's address and a descriptor holds another
//! descriptor's, so none of this is bytes alone — every object here is a
//! constant with relocations, and LLVM spells a relocation as a reference to
//! another global inside a constant initialiser.
//!
//! Two things that look like decoration and are not:
//!
//! * **Everything is `<{ … }>`, packed.** Same reason as `ty.rs`: the byte
//!   offsets are ours, computed by `Layouts` and by the shapes the runtime
//!   agrees to, and LLVM is told them rather than asked for them.
//! * **Everything carries an explicit `align`.** A packed struct is align-1 to
//!   LLVM, and a string literal's header is two `u64` loads the runtime
//!   performs at a negative offset. Leaving the alignment implicit would be
//!   correct on x86 and a fault elsewhere.

use crate::layout::TargetInfo;

/// One machine word inside a static object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Word {
    Int(u64),
    /// A null pointer — a base class that does not exist, mostly.
    Null,
    /// The address of another global, optionally biased.
    ///
    /// The bias is not a curiosity: an object's vtable pointer aims at the
    /// *first method slot*, one pointer past the vtable object, so a descriptor
    /// storing an itab address stores it already biased. See
    /// `crate::vtable::ClassData::vtable_bias`.
    Addr {
        symbol: String,
        bias: i64,
    },
}

impl Word {
    pub fn addr(symbol: impl Into<String>) -> Word {
        Word::Addr {
            symbol: symbol.into(),
            bias: 0,
        }
    }

    fn ty(&self, target: TargetInfo) -> &'static str {
        match self {
            Word::Int(_) => match target.pointer_bytes {
                4 => "i32",
                _ => "i64",
            },
            Word::Null | Word::Addr { .. } => "ptr",
        }
    }

    fn value(&self, target: TargetInfo) -> String {
        match self {
            Word::Int(value) => format!("{} {value}", self.ty(target)),
            Word::Null => "ptr null".to_owned(),
            Word::Addr { symbol, bias } if *bias == 0 => {
                format!("ptr @{}", super::ty::ident(symbol))
            }
            Word::Addr { symbol, bias } => format!(
                "ptr getelementptr (i8, ptr @{}, i64 {bias})",
                super::ty::ident(symbol)
            ),
        }
    }
}

/// The module's static objects, in emission order.
#[derive(Default)]
pub struct Globals {
    lines: Vec<String>,
}

impl Globals {
    pub fn new() -> Globals {
        Globals::default()
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    /// An object made of machine words, some of them addresses.
    ///
    /// `internal` rather than `private`: Cranelift declares these
    /// `Linkage::Local`, which is a real symbol the object file carries, and
    /// keeping the name is what makes `llvm-objdump` legible when a vtable is
    /// wrong. `private` would drop it from the symbol table entirely.
    pub fn words(&mut self, symbol: &str, words: &[Word], target: TargetInfo) {
        let types: Vec<&str> = words.iter().map(|word| word.ty(target)).collect();
        let values: Vec<String> = words.iter().map(|word| word.value(target)).collect();
        self.lines.push(format!(
            "@{} = internal constant <{{ {} }}> <{{ {} }}>, align {}",
            super::ty::ident(symbol),
            types.join(", "),
            values.join(", "),
            target.pointer_bytes
        ));
    }

    /// Raw bytes — a class's name, handed to C as a `char *`.
    pub fn bytes(&mut self, symbol: &str, bytes: &[u8]) {
        self.lines.push(format!(
            "@{} = internal constant [{} x i8] c\"{}\", align 1",
            super::ty::ident(symbol),
            bytes.len(),
            escape_bytes(bytes)
        ));
    }

    /// A string literal in the runtime's shape.
    ///
    /// ```text
    ///   [ len: u64 ][ owned: u64 ][ bytes … ][ 0 ]
    ///                             ^ the `string` value points here
    /// ```
    ///
    /// `owned = 0` marks it static, so freeing a literal is a no-op the
    /// *runtime* decides rather than something the compiler has to remember at
    /// each use site. The value the program carries is this symbol's address
    /// plus [`crate::runtime::STRING_HEADER_BYTES`], which is what keeps a
    /// literal and a heap string indistinguishable everywhere downstream.
    pub fn literal(&mut self, symbol: &str, text: &str) {
        let mut bytes = text.as_bytes().to_vec();
        bytes.push(0);
        self.lines.push(format!(
            "@{} = internal constant <{{ i64, i64, [{} x i8] }}> \
             <{{ i64 {}, i64 0, [{} x i8] c\"{}\" }}>, align 8",
            super::ty::ident(symbol),
            bytes.len(),
            text.len(),
            bytes.len(),
            escape_bytes(&bytes)
        ));
    }
}

/// LLVM's `c"…"` escaping: `\XX` for anything not plainly printable.
fn escape_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for byte in bytes {
        match byte {
            b'"' | b'\\' => out.push_str(&format!("\\{byte:02X}")),
            0x20..=0x7e => out.push(*byte as char),
            other => out.push_str(&format!("\\{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TARGET: TargetInfo = TargetInfo { pointer_bytes: 8 };

    #[test]
    fn a_biased_address_is_a_getelementptr() {
        let mut globals = Globals::new();
        globals.words(
            "__gf_desc$Dog",
            &[
                Word::addr("__gf_name$Dog"),
                Word::Null,
                Word::Int(1),
                Word::Addr {
                    symbol: "__gf_itab$Animal$Dog".into(),
                    bias: 8,
                },
            ],
            TARGET,
        );
        assert_eq!(
            globals.lines()[0],
            "@__gf_desc$Dog = internal constant <{ ptr, ptr, i64, ptr }> \
             <{ ptr @__gf_name$Dog, ptr null, i64 1, \
             ptr getelementptr (i8, ptr @__gf_itab$Animal$Dog, i64 8) }>, align 8"
        );
    }

    #[test]
    fn a_literal_carries_its_length_and_a_nul() {
        // The same shape `runtime::literal_data` produces, written the other
        // way round — bytes there, a typed initialiser here — so the two agree
        // about where the text starts.
        let mut globals = Globals::new();
        globals.literal("gf_str_test", "hi");
        assert_eq!(
            globals.lines()[0],
            "@gf_str_test = internal constant <{ i64, i64, [3 x i8] }> \
             <{ i64 2, i64 0, [3 x i8] c\"hi\\00\" }>, align 8"
        );
    }

    #[test]
    fn quotes_and_backslashes_survive() {
        let mut globals = Globals::new();
        globals.literal("gf_str_q", "a\"b\\c\n");
        let line = &globals.lines()[0];
        assert!(line.contains("c\"a\\22b\\5Cc\\0A\\00\""), "{line}");
        // The length is the text's, in bytes, not counting the nul.
        assert!(line.contains("i64 6,"), "{line}");
    }
}
