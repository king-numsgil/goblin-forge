// An early return out of nested scopes releases everything, innermost first.
#include "trace.hpp"

int main() {
  oracle::Str outer = oracle::Str("o") + "1";
  {
    oracle::Str middle = oracle::Str("m") + "2";
    {
      oracle::Str inner = oracle::Str("i") + "3";
      oracle::print(inner);
      return 0;
    }
  }
}
