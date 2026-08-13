// Default member initialisers: when they run, and in what order.
//
// C++ fixes the order and it is not the obvious one. For `new Derived()`:
//
//   1. the base subobject is constructed — *its* member initialisers, then its
//      constructor body;
//   2. the derived class's member initialisers, in **declaration** order;
//   3. the derived class's constructor body.
//
// So a base constructor body runs *before* a derived member initialiser, and a
// derived constructor body runs *after* it — which means a constructor body can
// assign over an initialiser and win, and an initialiser can assign over
// whatever the base's body left. Both directions are exercised below.
//
// The trace is the allocations, so every step is written to allocate: each
// initialiser and each constructor body builds a string with `+`.
#include "trace.hpp"

class Base {
 public:
  Base() {
    oracle::trace("base-body");
    from_base_ = oracle::Str("base") + "-body";
  }

  oracle::Str from_base_ = oracle::Str("base") + "-init";
};

class Derived : public Base {
 public:
  Derived() {
    oracle::trace("derived-body");
    second_ = oracle::Str("derived") + "-body";
  }

  // Declaration order, and the second one reads the first — which only works
  // because they run in the order they are written.
  oracle::Str first_ = oracle::Str("derived") + "-init";
  oracle::Str second_ = first_;
};

int main() {
  {
    Derived value;
    oracle::print(value.from_base_);
    oracle::print(value.first_);
    oracle::print(value.second_);
  }
  oracle::trace("done");
  return 0;
}
