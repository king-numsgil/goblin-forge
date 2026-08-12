// The C compiler's answer to "how is this laid out".
//
// REWRITE-PLAN §6: **differential-test the layout, do not assert it.** v1's
// struct-ABI suite asks the C compiler for `size_of` and `offset_of` and
// compares, and that pattern is why its layout code is the best-tested part of
// the project.
//
// Every shape here has a counterpart built as MIR in `tests/layout.test.ts`,
// under the same name. Adding one here without adding it there makes the test
// fail rather than silently cover less.

#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace {

struct Scalars {
  int32_t a;
  int32_t b;
};

// The classic: a byte, then something that has to be aligned, so there is
// padding in the middle and at the end.
struct Padded {
  int8_t a;
  int32_t b;
  int8_t c;
};

struct WideThenNarrow {
  double a;
  int8_t b;
};

// A nested aggregate is **inline**. It occupies its own layout inside the
// parent, not a pointer to itself — which is the property C interop depends on
// and the one v1 had to be retrofitted for.
struct Inner {
  int16_t a;
  int16_t b;
};

struct Nested {
  int8_t before;
  Inner inner;
  int8_t after;
};

struct DeeplyNested {
  Nested outer;
  double tail;
};

// A handle is one machine word, whatever it points at.
struct WithHandles {
  const char* text;
  int32_t n;
};

struct AllTheWidths {
  int8_t i8;
  int16_t i16;
  int32_t i32;
  int64_t i64;
  uint8_t u8;
  uint16_t u16;
  uint32_t u32;
  uint64_t u64;
  float f32;
  double f64;
};

struct BoolAndFloat {
  bool flag;
  float value;
};

struct OneField {
  int64_t only;
};

#define REPORT2(T, f0, f1) \
  std::printf("%s|%zu|%zu|%zu,%zu\n", #T, sizeof(T), alignof(T), offsetof(T, f0), \
              offsetof(T, f1))
#define REPORT3(T, f0, f1, f2)                                                  \
  std::printf("%s|%zu|%zu|%zu,%zu,%zu\n", #T, sizeof(T), alignof(T),            \
              offsetof(T, f0), offsetof(T, f1), offsetof(T, f2))

}  // namespace

int main() {
  REPORT2(Scalars, a, b);
  REPORT3(Padded, a, b, c);
  REPORT2(WideThenNarrow, a, b);
  REPORT2(Inner, a, b);
  REPORT3(Nested, before, inner, after);
  REPORT2(DeeplyNested, outer, tail);
  REPORT2(WithHandles, text, n);
  std::printf("AllTheWidths|%zu|%zu|%zu,%zu,%zu,%zu,%zu,%zu,%zu,%zu,%zu,%zu\n",
              sizeof(AllTheWidths), alignof(AllTheWidths), offsetof(AllTheWidths, i8),
              offsetof(AllTheWidths, i16), offsetof(AllTheWidths, i32),
              offsetof(AllTheWidths, i64), offsetof(AllTheWidths, u8),
              offsetof(AllTheWidths, u16), offsetof(AllTheWidths, u32),
              offsetof(AllTheWidths, u64), offsetof(AllTheWidths, f32),
              offsetof(AllTheWidths, f64));
  REPORT2(BoolAndFloat, flag, value);
  std::printf("OneField|%zu|%zu|%zu\n", sizeof(OneField), alignof(OneField),
              offsetof(OneField, only));
  return 0;
}
