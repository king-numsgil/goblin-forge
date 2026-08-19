// Capturing `this` costs nothing. The closure reads and writes the object
// through the receiver the method already had, so the trace is the one the
// method would print with the closure removed.
//
// The field is owning, which is what makes this worth a case: a `this` that was
// captured by value rather than by reference would copy the object, allocate a
// second buffer for the field, and release it again on the way out.
#include "trace.hpp"

template <class F>
static void apply(F &&f) {
  f();
}

class Named {
 public:
  explicit Named(oracle::Str name) : name_(name) {}

  void rename() {
    apply([&]() { name_ = oracle::Str("z") + "9"; });
  }

  const oracle::Str &name() const { return name_; }

 private:
  oracle::Str name_;
};

int main() {
  Named a(oracle::Str("a") + "1");
  oracle::print(a.name());
  a.rename();
  oracle::print(a.name());
  return 0;
}
