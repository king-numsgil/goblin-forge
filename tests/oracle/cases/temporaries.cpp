// A temporary dies at the end of the full-expression that made it, in reverse
// order of creation.
#include "trace.hpp"

int main() {
  oracle::Str a = oracle::Str("a") + "a";
  {
    oracle::Str joined = a + (oracle::Str("b") + "b");
    oracle::print(joined);
  }
  oracle::print(a);
  return 0;
}
