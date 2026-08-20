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
//   2. **The value moves in rather than being copied.** `"hi" + "!"` is a
//      temporary, and assigning a temporary takes its buffer. A second `alloc`
//      line would mean Goblin copied a value that nothing could observe again.
//
// The unnamed fields are the third claim and need no trace: `pad` is never
// written by either side, and both read it back as zero.
interface Pipe {
    flags: i32;
    pad: i32;
    name: string;
}

export function main(): i32 {
    const p = alloc<Pipe>({flags: 7, name: "hi" + "!"});

    console.log(p.name);
    console.log(`${p.flags}`);
    console.log(`${p.pad}`);

    p.free();
    console.log("done");
    return 0;
}
