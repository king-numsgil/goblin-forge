// Assigning *through* a capture. The old buffer belongs to the enclosing
// frame, so the release happens there and on schedule — the closure is writing
// to the frame's object, not to one of its own.
//
// This is the case that separates a by-reference capture from a copy: with a
// copy the trace still balances, and it balances around the wrong object.
#include "trace.hpp"

template <class F>
static void apply(F &&f) {
  f();
}

int main() {
  oracle::Str s = oracle::Str("a") + "b";
  apply([&]() { s = oracle::Str("c") + "d"; });
  oracle::print(s);
  return 0;
}
