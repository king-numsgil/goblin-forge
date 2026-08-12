// A class holding an owning field releases it when its binding's scope ends.
//
// In Goblin the destructor is generated: there is no syntax for one, and the
// field's own type is what says it has to be released. The C++ side writes the
// implicit destructor out longhand by simply not declaring one — which is the
// same thing.
class Named {
  name: string;
  constructor(name: string) { this.name = name; }
}

export function main(): i32 {
  {
    const a = new Named("a" + "1");
    console.log(a.name);
  }
  const b = new Named("b" + "2");
  console.log(b.name);
  return 0;
}
