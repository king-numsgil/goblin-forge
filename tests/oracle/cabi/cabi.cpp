// A real `extern "C"` library, for the struct-ABI differential suite.
//
// REWRITE-PLAN §9: "A struct-ABI differential suite from day one, against a
// real `extern "C"` library, checking layout agreement, by-value copy
// semantics, register assignment around structs, and return ownership. In v1
// this suite did not exist and the by-value path was silently broken the whole
// time."
//
// Every shape here sits on a branch of the classification:
//
//   Win64 passes a struct of 1, 2, 4 or 8 bytes in one integer register and
//   everything else by address.
//
//   System V splits up to sixteen bytes into eightbytes and classifies each
//   INTEGER or SSE. `struct { float x, y; }` goes to **one SSE register** and
//   `struct { int; float; }` to one integer register — getting that backwards
//   is silent corruption, not a crash (REWRITE-PLAN §6).
//
// The C compiler decides all of that. This file just has to be honest about
// what it received, so a mismatch shows up as a wrong number rather than as a
// crash somewhere else.

#include <cstdint>

extern "C" {

// ---- scalars, to pin the plain cases --------------------------------------

int32_t gf_c_add(int32_t a, int32_t b) { return a + b; }

// Sub-register widths, which the caller must extend. A callee compiled by a C
// compiler is entitled to use the whole register without masking.
int32_t gf_c_add_narrow(int8_t a, uint8_t b, int16_t c, uint16_t d) {
  return static_cast<int32_t>(a) + b + c + d;
}

double gf_c_scale(double value, float by) { return value * static_cast<double>(by); }

// Narrow *returns*, which the C ABI marks `signext` or `zeroext` on the result
// rather than on a parameter. Whether the caller may believe the high bits is
// the same question `gf_c_add_narrow` asks in the other direction, and the two
// have different answers only if somebody got one of them wrong.
//
// `bool` is here because it is what a real C library returns constantly —
// SDL3's `SDL_SubmitGPUCommandBuffer` among them — and it is one byte with an
// extension attribute, which is the combination that bites.
int8_t gf_c_ret_i8(int32_t v) { return static_cast<int8_t>(v); }
uint8_t gf_c_ret_u8(int32_t v) { return static_cast<uint8_t>(v); }
int16_t gf_c_ret_i16(int32_t v) { return static_cast<int16_t>(v); }
uint16_t gf_c_ret_u16(int32_t v) { return static_cast<uint16_t>(v); }
bool gf_c_ret_bool(int32_t v) { return v != 0; }

// ---- one byte, two bytes, four bytes, eight bytes -------------------------

struct One {
  int8_t a;
};
struct Two {
  int8_t a;
  int8_t b;
};
struct Four {
  int16_t a;
  int16_t b;
};
/// Eight bytes, both integers. One integer register under both conventions.
struct Pair {
  int32_t x;
  int32_t y;
};
/// Eight bytes, both floats. **One SSE register** under System V, and one
/// *integer* register under Win64 — the case that is easiest to get backwards.
struct TwoFloats {
  float x;
  float y;
};
/// Eight bytes, mixed. One eightbyte containing an integer is INTEGER, whatever
/// else is in it.
struct IntFloat {
  int32_t a;
  float b;
};

int32_t gf_c_one(One v) { return v.a; }
int32_t gf_c_two(Two v) { return v.a * 100 + v.b; }
int32_t gf_c_four(Four v) { return v.a * 1000 + v.b; }
int32_t gf_c_pair(Pair v) { return v.x * 1000 + v.y; }
double gf_c_two_floats(TwoFloats v) { return static_cast<double>(v.x) * 1000.0 + v.y; }
double gf_c_int_float(IntFloat v) { return v.a * 1000.0 + static_cast<double>(v.b); }

One gf_c_make_one(int8_t a) { return One{a}; }
Pair gf_c_make_pair(int32_t x, int32_t y) { return Pair{x, y}; }
TwoFloats gf_c_make_two_floats(float x, float y) { return TwoFloats{x, y}; }
IntFloat gf_c_make_int_float(int32_t a, float b) { return IntFloat{a, b}; }

// ---- past one register ----------------------------------------------------

/// Twelve bytes: Win64 passes it by address, System V in two eightbytes.
struct Twelve {
  int32_t a;
  int32_t b;
  int32_t c;
};
/// Sixteen bytes, all floats: two SSE eightbytes under System V.
struct TwoDoubles {
  double x;
  double y;
};
/// Twenty-four bytes: too big for registers under either convention.
struct Big {
  int64_t a;
  int64_t b;
  int64_t c;
};
/// A nested aggregate, to prove the flattening reaches through it.
struct Nested {
  Pair inner;
  int32_t tail;
};

int32_t gf_c_twelve(Twelve v) { return v.a * 10000 + v.b * 100 + v.c; }
double gf_c_two_doubles(TwoDoubles v) { return v.x * 1000.0 + v.y; }
int64_t gf_c_big(Big v) { return v.a * 10000 + v.b * 100 + v.c; }
int32_t gf_c_nested(Nested v) { return v.inner.x * 10000 + v.inner.y * 100 + v.tail; }

Twelve gf_c_make_twelve(int32_t a, int32_t b, int32_t c) { return Twelve{a, b, c}; }
TwoDoubles gf_c_make_two_doubles(double x, double y) { return TwoDoubles{x, y}; }
Big gf_c_make_big(int64_t a, int64_t b, int64_t c) { return Big{a, b, c}; }
Nested gf_c_make_nested(int32_t x, int32_t y, int32_t tail) {
  return Nested{Pair{x, y}, tail};
}

// ---- by-value copy semantics ----------------------------------------------

/// Mutates its parameter and returns the mutated value.
///
/// The caller's struct must be **untouched** afterwards. A by-value argument is
/// a copy the caller made, and a callee writing through to the original is the
/// failure this checks for.
int32_t gf_c_clobber(Pair v) {
  v.x = 999;
  v.y = 999;
  return v.x + v.y;
}

/// Several structs in a row, to push past the register-argument budget and
/// onto the stack.
int32_t gf_c_many(Pair a, Pair b, Pair c, Pair d, Pair e) {
  return a.x + b.x + c.x + d.x + e.x + a.y + b.y + c.y + d.y + e.y;
}

/// A struct after enough scalars to exhaust the integer registers.
int32_t gf_c_mixed(int32_t a, int32_t b, int32_t c, int32_t d, Pair e, int32_t f) {
  return a + b + c + d + e.x + e.y + f;
}

}  // extern "C"
