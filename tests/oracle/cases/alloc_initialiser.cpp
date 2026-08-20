// `alloc<T>({ … })` — zeroed storage, then the fields the initialiser names.
//
// The initialiser is sugar, and this is the case that says so in the only
// currency that settles it: the allocation trace. Goblin's
//
//     const p = alloc<Pipe>({ flags: 7, name: "hi" + "!" });
//
// is meant to be exactly C++'s
//
//     Pipe* p = new Pipe{};
//     p->flags = 7;
//     p->name = Str("hi") + "!";
//
// and nothing more. Two claims ride on that, both invisible without a trace:
//
//   1. **Assigning over a zero releases nothing.** The named field holds a live
//      *empty* string when the initialiser writes it, so the write destroys what
//      was there — and destroying an empty string is a null check, not a `free`.
//      A stray `free` line here would mean Goblin had freed something it never
//      allocated; C++ produces none, because `release()` on a non-owning buffer
//      is silent.
//
//   2. **The value moves in rather than being copied.** `Str("hi") + "!"` is a
//      temporary, and assigning a temporary takes its buffer. A second `alloc`
//      line would mean Goblin copied a value that nothing could observe again.
//
// The unnamed fields are the third claim and need no trace: `pad` is never
// written by either side, and both read it back as zero.
#include "trace.hpp"

struct Pipe {
  int flags;
  int pad;
  oracle::Str name;
};

int main() {
  Pipe* p = oracle::alloc<Pipe>();
  p->flags = 7;
  p->name = oracle::Str("hi") + "!";

  oracle::print(p->name);
  oracle::print(oracle::str(p->flags));
  oracle::print(oracle::str(p->pad));

  oracle::free(p);
  oracle::trace("done");
  return 0;
}
