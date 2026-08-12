// A by-value parameter is a copy the caller makes and the caller destroys.
#include "trace.hpp"

static oracle::Str twice(oracle::Str s) { return s + s; }

int main() {
  oracle::Str original = oracle::Str("m") + "n";
  oracle::Str doubled = twice(original);
  oracle::print(original);
  oracle::print(doubled);
  return 0;
}
