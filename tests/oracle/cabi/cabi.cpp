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

#include <cstddef>
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

// ---- pointers to structs, and nesting reached through them ----------------
//
// Everything above passes structs *by value*, which is the half the
// classification decides. Real C libraries mostly do not: they hand out
// pointers and take them back, and a field is reached through one. Nothing was
// checking that, and it is where a wrong offset shows up as a plausible number
// rather than as a crash.
//
// The shapes are deliberately not anybody's real API. What matters is that a
// `Vec3` is three doubles — past a register under both conventions — and that
// `Body` nests two of them behind a scalar, so a field's offset is the sum of
// two layouts rather than one.

struct Vec3 {
  double x;
  double y;
  double z;
};

struct Body {
  int32_t id;
  Vec3 position;
  Vec3 velocity;
};

double gf_c_vec3_length_sq(const Vec3 *v) {
  return v->x * v->x + v->y * v->y + v->z * v->z;
}

/// Writes through the pointer. The caller must see the change — the opposite of
/// `gf_c_clobber`, and the reason those two sit in the same file.
void gf_c_vec3_set(Vec3 *v, double x, double y, double z) {
  v->x = x;
  v->y = y;
  v->z = z;
}

int32_t gf_c_body_id(const Body *b) { return b->id; }

/// Reads a nested struct through a pointer and writes another one back.
void gf_c_body_step(Body *b, double dt) {
  b->position.x += b->velocity.x * dt;
  b->position.y += b->velocity.y * dt;
  b->position.z += b->velocity.z * dt;
}

/// A pointer *into* a struct: the address arithmetic is the callee's, and the
/// caller has to agree about where the field starts.
const Vec3 *gf_c_body_position(const Body *b) { return &b->position; }

/// A struct by value that contains a nested struct by value, returned by value.
Body gf_c_make_body(int32_t id, double x, double y) {
  return Body{id, Vec3{x, y, 0.0}, Vec3{1.0, 2.0, 3.0}};
}

// ---- out-parameters -------------------------------------------------------
//
// The shape half of C uses for anything that can fail: a `bool` result and the
// real answer written through a pointer. It pairs a narrow return with a
// pointer write, which is exactly the combination an SDL3 program hits on its
// first line.

bool gf_c_try_divide(int32_t a, int32_t b, int32_t *out) {
  if (b == 0) {
    return false;
  }
  *out = a / b;
  return true;
}

/// Fills a caller-provided struct rather than returning one.
bool gf_c_try_make_pair(int32_t x, int32_t y, Pair *out) {
  if (x > y) {
    return false;
  }
  out->x = x;
  out->y = y;
  return true;
}

// ---- strings, both directions ---------------------------------------------
//
// A `const char *` in and a `const char *` out. The one out lives in static
// storage on purpose: whoever receives it must **not** free it, which is the
// ownership question at this boundary and the one a copy would paper over.

int32_t gf_c_strlen(const char *s) {
  int32_t n = 0;
  while (s[n] != '\0') {
    n += 1;
  }
  return n;
}

int32_t gf_c_str_equal(const char *a, const char *b) {
  while (*a != '\0' && *a == *b) {
    a += 1;
    b += 1;
  }
  return static_cast<int32_t>(*a == *b);
}

const char *gf_c_greeting(void) { return "hello from C"; }

/// Writes into caller-owned storage, the way `snprintf` does.
int32_t gf_c_copy_into(const char *src, char *dest, int32_t cap) {
  int32_t n = 0;
  while (src[n] != '\0' && n < cap - 1) {
    dest[n] = src[n];
    n += 1;
  }
  dest[n] = '\0';
  return n;
}

// ---- callbacks: C calling back into Goblin --------------------------------
//
// The direction the rest of this file never goes. Everything else has Goblin as
// the caller and the C ABI applied to arguments on the way out; here the C
// library is the caller and Goblin's exported function has to *receive* under
// the same rules.

typedef int32_t (*BinOp)(int32_t, int32_t);
typedef Pair (*PairOp)(Pair);

int32_t gf_c_apply(BinOp op, int32_t a, int32_t b) { return op(a, b); }

int32_t gf_c_fold(BinOp op, const int32_t *values, int32_t count) {
  int32_t total = 0;
  for (int32_t i = 0; i < count; i += 1) {
    total = op(total, values[i]);
  }
  return total;
}

/// A callback taking and returning a struct, so the classification applies on
/// the way in *and* the way out of a function this compiler defined.
int32_t gf_c_apply_pair(PairOp op, int32_t x, int32_t y) {
  Pair result = op(Pair{x, y});
  return result.x * 1000 + result.y;
}

// -- vertex blobs -------------------------------------------------------------
//
// The case a graphics API is: a run of interleaved vertices handed over as a
// `void *`, a count and a stride, with the *C* side deciding what the bytes
// mean. Nothing about the Goblin declaration reaches here — this file is
// compiled by the platform's C++ compiler and its `Vertex` is written from
// scratch — so agreement is agreement about layout and nothing else.
//
// `float pos[3]` rather than a vector type on purpose: what a `fvec3` has to
// be, for this to work, is three floats and no padding.

struct Vertex {
  float pos[3];
  float uv[2];
  uint32_t mat;
};

/// What C makes of the layout, so the two sides can be compared directly.
int32_t gf_c_vertex_size(void) { return (int32_t)sizeof(Vertex); }
int32_t gf_c_vertex_align(void) { return (int32_t)alignof(Vertex); }
int32_t gf_c_vertex_offset_uv(void) { return (int32_t)offsetof(Vertex, uv); }
int32_t gf_c_vertex_offset_mat(void) { return (int32_t)offsetof(Vertex, mat); }

/// Read one vertex out of an interleaved blob, striding as a GPU would.
///
/// Deliberately takes the stride from the caller rather than using
/// `sizeof(Vertex)`: if the two disagree this reads from the wrong offset and
/// the test fails, which is the failure worth catching.
double gf_c_vertex_read(const void *data, int32_t index, int32_t stride,
                        int32_t field) {
  const unsigned char *base = (const unsigned char *)data;
  const Vertex *v = (const Vertex *)(base + (size_t)index * (size_t)stride);
  switch (field) {
    case 0: return v->pos[0];
    case 1: return v->pos[1];
    case 2: return v->pos[2];
    case 3: return v->uv[0];
    case 4: return v->uv[1];
    case 5: return (double)v->mat;
    default: return -1.0;
  }
}

/// Write a vertex *from* C, so the traffic is checked in both directions.
void gf_c_vertex_write(void *data, int32_t index, int32_t stride, float x,
                       float y, float z, float u, float v, uint32_t mat) {
  unsigned char *base = (unsigned char *)data;
  Vertex *target = (Vertex *)(base + (size_t)index * (size_t)stride);
  target->pos[0] = x;
  target->pos[1] = y;
  target->pos[2] = z;
  target->uv[0] = u;
  target->uv[1] = v;
  target->mat = mat;
}

/// Sum every `mat` in the blob, which only works if the stride is right for
/// *every* element rather than only the first.
uint32_t gf_c_vertex_sum_mat(const void *data, int32_t count, int32_t stride) {
  const unsigned char *base = (const unsigned char *)data;
  uint32_t total = 0;
  for (int32_t i = 0; i < count; i += 1) {
    total += ((const Vertex *)(base + (size_t)i * (size_t)stride))->mat;
  }
  return total;
}

// The same question for a matrix, which is what a uniform buffer carries.
// Column-major, so `m[0]` is the first column and `m[12]`..`m[14]` are the
// translation — the layout every shader expects.
double gf_c_mat4_element(const void *data, int32_t index) {
  return (double)((const float *)data)[index];
}

int32_t gf_c_mat4_size(void) { return (int32_t)(16 * sizeof(float)); }

}  // extern "C"
