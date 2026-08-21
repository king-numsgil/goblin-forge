//! The runtime's entry points, as the backend sees them.
//!
//! Every operation an owning type needs is a call into `goblin-runtime`, and
//! every one of them crosses the same `extern "C"` boundary user code crosses.
//! There is no privileged channel: a bug in `gf_string_clone` looks like a bug
//! in any other C function, and can be found the same way.
//!
//! Declared lazily, on first use, so a program that touches no strings does not
//! carry an undefined reference to the string runtime.

/// The header sitting behind every `string` pointer: `len: u64`, `owned: u64`.
///
/// A string literal is emitted as static data in exactly this shape with
/// `owned = 0`, and the value the program holds is the symbol's address plus
/// this many bytes. Freeing a literal is then a no-op the *runtime* decides,
/// not something the compiler has to remember at each site.
pub const STRING_HEADER_BYTES: i64 = 16;

/// A runtime function the backend can call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuntimeFn {
    /// `gf_string_clone(s) -> s` — the copy operation for `string`.
    StringClone,
    /// `gf_string_free(s)` — the destroy operation for `string`.
    StringFree,
    /// `gf_string_len(s) -> usize`.
    StringLen,
    /// `gf_cstr_len(s) -> usize` — `strlen`, for a `CString`. A scan, where
    /// `StringLen` is a load, which is what the two types are for.
    CStrLen,
    /// `gf_string_concat(a, b) -> s`.
    StringConcat,
    /// `gf_string_eq(a, b) -> u8`.
    StringEq,
    StringFromI64,
    StringFromU64,
    StringFromF64,
    StringFromBool,
    /// `gf_print(s)` — one line to stdout.
    Print,
    /// `gf_eprint(s)` — one line to stderr.
    EPrint,
    /// `gf_find_itab(descriptor, key) -> *const Itab` — the dynamic half of
    /// `tryCast`. Null when the type does not satisfy the interface.
    FindItab,
    /// `gf_is_a(descriptor, target) -> u8` — the class half of `tryCast`.
    IsA,
    /// `gf_array_new(len, stride, align) -> a` — storage for `len`
    /// **uninitialised** elements. The caller fills them, applying each one's
    /// own copy operation, because only the backend knows what that is.
    ArrayNew,
    /// `gf_array_empty() -> a` — the shared static empty array. No allocation.
    ArrayEmpty,
    /// `gf_array_len(a) -> usize` — a load, like a string's.
    ArrayLen,
    /// `gf_array_push_slot(&a, stride, align) -> *mut T` — make room for one
    /// more and hand back its address, reseating the handle.
    ArrayPushSlot,
    /// `gf_array_pop(a)` — forget the last element, after it has been
    /// destroyed. The capacity is kept, as `std::vector::pop_back` keeps it.
    ArrayPop,
    /// `gf_array_free(a)` — release the buffer. The elements are destroyed by
    /// emitted code first.
    ///
    /// The handle and nothing else: mimalloc is asked what the block was, where
    /// Rust's `dealloc` had to be told, so the stride and alignment this used to
    /// carry are two numbers no call site can now get wrong.
    ArrayFree,
}

impl RuntimeFn {
    pub fn symbol(self) -> &'static str {
        match self {
            RuntimeFn::CStrLen => "gf_cstr_len",
            RuntimeFn::FindItab => "gf_find_itab",
            RuntimeFn::IsA => "gf_is_a",
            RuntimeFn::StringClone => "gf_string_clone",
            RuntimeFn::StringFree => "gf_string_free",
            RuntimeFn::StringLen => "gf_string_len",
            RuntimeFn::StringConcat => "gf_string_concat",
            RuntimeFn::StringEq => "gf_string_eq",
            RuntimeFn::StringFromI64 => "gf_string_from_i64",
            RuntimeFn::StringFromU64 => "gf_string_from_u64",
            RuntimeFn::StringFromF64 => "gf_string_from_f64",
            RuntimeFn::StringFromBool => "gf_string_from_bool",
            RuntimeFn::Print => "gf_print",
            RuntimeFn::EPrint => "gf_eprint",
            RuntimeFn::ArrayNew => "gf_array_new",
            RuntimeFn::ArrayEmpty => "gf_array_empty",
            RuntimeFn::ArrayLen => "gf_array_len",
            RuntimeFn::ArrayPushSlot => "gf_array_push_slot",
            RuntimeFn::ArrayPop => "gf_array_pop",
            RuntimeFn::ArrayFree => "gf_array_free",
        }
    }
}

/// The bytes of a string literal's static data: header, then the text, then a
/// NUL so the same pointer is a valid C `char *`.
pub fn literal_data(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(STRING_HEADER_BYTES as usize + text.len() + 1);
    bytes.extend_from_slice(&(text.len() as u64).to_le_bytes());
    // `owned = 0`: static, so the runtime's free is a no-op.
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes.extend_from_slice(text.as_bytes());
    bytes.push(0);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_literal_carries_its_length_and_a_nul() {
        let data = literal_data("hi");
        assert_eq!(data.len(), STRING_HEADER_BYTES as usize + 3);
        assert_eq!(&data[0..8], &2u64.to_le_bytes());
        // Not owned, so freeing it does nothing.
        assert_eq!(&data[8..16], &0u64.to_le_bytes());
        assert_eq!(&data[16..], b"hi\0");
    }

    #[test]
    fn an_empty_literal_is_still_a_valid_c_string() {
        let data = literal_data("");
        assert_eq!(data.len(), STRING_HEADER_BYTES as usize + 1);
        assert_eq!(data[STRING_HEADER_BYTES as usize], 0);
    }
}
