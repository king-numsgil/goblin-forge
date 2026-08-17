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
class Base {
    fromBase: string = "base" + "-init";

    constructor() {
        console.log("base-body");
        this.fromBase = "base" + "-body";
    }
}

class Derived extends Base {
    // Declaration order, and the second one reads the first — which only works
    // because they run in the order they are written.
    first: string = "derived" + "-init";
    second: string = this.first;

    constructor() {
        super();
        console.log("derived-body");
        this.second = "derived" + "-body";
    }
}

export function main(): i32 {
    {
        const value = new Derived();
        console.log(value.fromBase);
        console.log(value.first);
        console.log(value.second);
    }
    console.log("done");
    return 0;
}
