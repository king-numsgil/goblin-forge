// The C++ side of the oracle.
//
// REWRITE-PLAN §9.1: if the semantics are meant to be C++'s, then C++ is the
// oracle. Each case is written twice — once in Goblin, once in C++ — and both
// print a trace of every allocation and release. The two traces must be
// identical.
//
// That is worth more than any number of hand-written expectations, because the
// question "what *should* this print?" stops being a judgement call.
//
// # Why `Str` and not `std::string`
//
// `std::string` has the small-string optimisation, so `std::string a = "hi"`
// allocates nothing while a longer one allocates once. Goblin's `string` does
// not work that way. Comparing against `std::string` would compare two memory
// models and call the difference a bug.
//
// `Str` is `std::string`'s *semantics* — value semantics, copy on assignment,
// move leaves the source empty, destructor releases — with Goblin's
// *representation*: a heap buffer with an `owned` flag, and literals static.
// Every trace line it prints has a counterpart the Goblin runtime prints for
// the same event.
//
// A `Traced` type with named construction and destruction lines arrives with
// classes, in milestone 8. Until then there is no user type with a destructor
// to trace.

#pragma once

#include <cstddef>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>

namespace oracle {

/// Print one trace line, unbuffered so ordering survives everything.
inline void trace(const char* event) {
  std::fputs(event, stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

/// A heap-allocated, value-semantic string, with every heap event announced.
class Str {
 public:
  Str() : Str("") {}

  /// A literal: static, exactly as Goblin lays one out with `owned = 0`.
  /// Nothing is allocated and nothing is freed, which is what makes "the
  /// binding's scope releases it" a rule with no exceptions on either side.
  Str(const char* text)
      : data_(const_cast<char*>(text)), size_(std::strlen(text)), owned_(false) {}

  Str(const Str& other) {
    // Copying a static hands back the same bytes: strings are immutable, so
    // there is nothing to observe, and the allocation never happens rather
    // than happening and being optimised away.
    if (!other.owned_) {
      borrow(other);
      return;
    }
    adopt(other.data_, other.size_);
  }

  Str(Str&& other) noexcept
      : data_(other.data_), size_(other.size_), owned_(other.owned_) {
    // A move takes the buffer and leaves the source safe to destroy. No
    // allocation, and no trace line — nothing happened to the heap.
    other.clear();
  }

  Str& operator=(const Str& other) {
    if (this == &other) return *this;
    // The old value is destroyed before the new one lands: the whole
    // difference between `Assign` and `Init` in the MIR.
    release();
    if (other.owned_) {
      adopt(other.data_, other.size_);
    } else {
      borrow(other);
    }
    return *this;
  }

  Str& operator=(Str&& other) noexcept {
    if (this == &other) return *this;
    release();
    data_ = other.data_;
    size_ = other.size_;
    owned_ = other.owned_;
    other.clear();
    return *this;
  }

  ~Str() { release(); }

  std::size_t size() const { return size_; }
  const char* c_str() const { return data_ == nullptr ? "" : data_; }

  /// Take a copy of bytes that are about to go away. Always allocates.
  static Str owned(const char* text, std::size_t size) {
    Str out;
    out.adopt(text, size);
    return out;
  }

  friend Str operator+(const Str& left, const Str& right) {
    const std::size_t size = left.size_ + right.size_;
    Str out;
    out.data_ = new char[size + 1];
    if (left.size_ != 0) std::memcpy(out.data_, left.c_str(), left.size_);
    if (right.size_ != 0) std::memcpy(out.data_ + left.size_, right.c_str(), right.size_);
    out.data_[size] = '\0';
    out.size_ = size;
    out.owned_ = true;
    trace("alloc");
    return out;
  }

  friend bool operator==(const Str& left, const Str& right) {
    return left.size_ == right.size_ &&
           (left.size_ == 0 || std::memcmp(left.c_str(), right.c_str(), left.size_) == 0);
  }
  friend bool operator!=(const Str& left, const Str& right) { return !(left == right); }

 private:
  void borrow(const Str& other) {
    data_ = other.data_;
    size_ = other.size_;
    owned_ = false;
  }

  void clear() {
    data_ = nullptr;
    size_ = 0;
    owned_ = false;
  }

  void adopt(const char* text, std::size_t size) {
    data_ = new char[size + 1];
    if (size != 0) std::memcpy(data_, text, size);
    data_[size] = '\0';
    size_ = size;
    owned_ = true;
    trace("alloc");
  }

  void release() {
    char* buffer = owned_ ? data_ : nullptr;
    clear();
    if (buffer != nullptr) {
      delete[] buffer;
      trace("free");
    }
  }

  char* data_ = nullptr;
  std::size_t size_ = 0;
  /// Mirrors the `owned` word in Goblin's string header.
  bool owned_ = false;
};

/// `console.log`.
inline void print(const Str& value) {
  std::fputs(value.c_str(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

/// Interpolation of an integer, matching what `${n}` produces in Goblin.
inline Str str(long long value) {
  const std::string text = std::to_string(value);
  return Str::owned(text.c_str(), text.size());
}

/// `alloc<T>()` — storage for one `T`, zeroed, and announced.
///
/// The Goblin runtime traces every `gf_alloc`, so a case that reaches the heap
/// has a line the C++ side must produce too. Announced here rather than by
/// overriding the global `operator new`, which would also catch `Str`'s own
/// buffers and trace each of them twice.
///
/// `T{}` is value-initialisation: scalars zeroed, members default-constructed.
/// That is what `Rvalue::Default` does, and a default `Str` is the static empty
/// — no allocation on either side, which is what makes the traces line up.
template <typename T>
inline T* alloc() {
  trace("alloc");
  return new T{};
}

/// `p.free()` — the value first, then the storage.
///
/// The order is the whole point and it is not decorative: `delete` runs `~T`,
/// which releases what the members own, *before* the storage line. Goblin emits
/// `Drop` of the pointee and then the runtime call, in that order.
template <typename T>
inline void free(T* pointer) {
  delete pointer;
  trace("free");
}

}  // namespace oracle
