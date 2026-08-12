// Scope exit order: values are destroyed in reverse order of construction.
#include "trace.hpp"

int main() {
  oracle::Str a = oracle::Str("a") + "1";
  oracle::Str b = oracle::Str("b") + "2";
  oracle::Str c = oracle::Str("c") + "3";
  oracle::print(c);
  return 0;
}
