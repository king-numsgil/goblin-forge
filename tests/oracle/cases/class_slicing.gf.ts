// Copying a derived object into a base binding slices it.
//
// The base part is copied — allocating for its own owning field — and the
// derived part is not, because there is nowhere in a `Base` to put it. The
// trace therefore shows one allocation for the slice and not two.
class Base {
  one: string;
  constructor(one: string) { this.one = one; }
}

class Derived extends Base {
  two: string;
  constructor(one: string, two: string) { super(one); this.two = two; }
}

export function main(): i32 {
  const d = new Derived("o" + "ne", "t" + "wo");
  const sliced: Base = d;
  console.log(sliced.one);
  return 0;
}
