// Binding a value to a second name copies it. Both are released.
#include "trace.hpp"

int main() {
  oracle::Str source = oracle::Str("x") + "y";
  oracle::Str copy = source;
  oracle::print(copy);
  return 0;
}
