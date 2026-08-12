// A class holding an owning field releases it when its binding's scope ends.
//
// In Goblin the destructor is generated: there is no syntax for one, and the
// field's own type is what says it has to be released. The C++ side writes the
// implicit destructor out longhand by simply not declaring one — which is the
// same thing.
#include "trace.hpp"

class Named {
 public:
  // A copy, not a move, because Goblin cannot spell the moving version:
  // an owning value travels as a handle in a register, and the caller
  // releases a by-value argument, so a callee-side move is a double free
  // (GF0236). Both sides copy, so both sides allocate twice.
  explicit Named(oracle::Str name) : name_(name) {}
  const oracle::Str& name() const { return name_; }

 private:
  oracle::Str name_;
};

int main() {
  {
    Named a(oracle::Str("a") + "1");
    oracle::print(a.name());
  }
  Named b(oracle::Str("b") + "2");
  oracle::print(b.name());
  return 0;
}
