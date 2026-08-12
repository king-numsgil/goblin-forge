// Copying a derived object into a base binding slices it.
//
// The base part is copied — allocating for its own owning field — and the
// derived part is not, because there is nowhere in a `Base` to put it. The
// trace therefore shows one allocation for the slice and not two.
#include "trace.hpp"

class Base {
 public:
  explicit Base(oracle::Str one) : one_(one) {}
  const oracle::Str& one() const { return one_; }

 private:
  oracle::Str one_;
};

class Derived : public Base {
 public:
  Derived(oracle::Str one, oracle::Str two) : Base(one), two_(two) {}

 private:
  oracle::Str two_;
};

int main() {
  Derived d(oracle::Str("o") + "ne", oracle::Str("t") + "wo");
  Base sliced = d;
  oracle::print(sliced.one());
  return 0;
}
