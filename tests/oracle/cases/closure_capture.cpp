// A capture is a borrow. The closure reads the enclosing frame's object and
// neither copies it nor destroys it, so the trace is the same one the program
// would print with the closure removed.
//
// A template parameter is the C++ spelling of a non-escaping closure — the same
// thing `LocalFn<F>` says, and the reason `std::function` is not used here: it
// type-erases onto the heap, which would be comparing against a different
// design rather than against C++.
#include "trace.hpp"

template <class F>
static void apply(F &&f) {
  f();
}

int main() {
  oracle::Str name = oracle::Str("wor") + "ld";
  apply([&]() { oracle::print(name); });
  oracle::print(name);
  return 0;
}
