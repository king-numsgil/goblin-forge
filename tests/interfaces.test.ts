/**
 * Contracts and interface dispatch.
 *
 * The second half of REWRITE-PLAN §12's milestone 8, answering §11.2. The
 * design is in DECISIONS; what matters when reading these:
 *
 * * **An interface is a shape or a contract, decided by syntax.** `feed(): void`
 *   is a `MethodSignature` and makes it a contract — dispatched, no layout,
 *   held only as `Reference<I>`. `feed: () => void` is a `PropertySignature`
 *   and leaves it a plain struct with a function-pointer field. Different AST
 *   node kinds, so nothing is inferred.
 * * **Conversion is structural.** A class needs no `implements` clause, exactly
 *   as in TypeScript. Declaring one is allowed and will later be what makes a
 *   class findable by a *dynamic* cast.
 * * **Itabs are static.** One per `(interface, class)` pair actually converted,
 *   emitted at compile time as a gather from the class's vtable. There is no
 *   runtime table, no hashing and no lock — Go's laziness solves problems
 *   (reflection, plugins) this language does not have.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

const SPEAKER = `interface Speaker { speak(): string; }\n`;

describe("contracts", () => {
  test("two unrelated classes satisfy one contract", async () => {
    // The case that makes itables necessary rather than merely tidy: `Dog` and
    // `Robot` share no base, so there is no vtable layout that could serve
    // both. The itab is the third object neither of them owns.
    const result = await run(
      "iface-two-classes",
      `${SPEAKER}
       class Dog implements Speaker {
         name: string;
         constructor(name: string) { this.name = name; }
         speak(): string { return \`\${this.name} says woof\`; }
       }
       class Robot implements Speaker {
         id: i32;
         constructor(id: i32) { this.id = id; }
         speak(): string { return \`unit \${this.id} reporting\`; }
       }

       function announce(who: Reference<Speaker>): void {
         console.log(who.speak());
       }

       export function main(): i32 {
         announce(new Dog("rex"));
         announce(new Robot(7));
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("rex says woof\nunit 7 reporting\n");
  });

  test("a class needs no `implements` clause", async () => {
    // Structural, as in TypeScript. The conversion site is what registers the
    // itab, so a class the interface has never heard of still converts.
    const result = await run(
      "iface-structural",
      `${SPEAKER}
       class Cat {
         sound: string;
         constructor(sound: string) { this.sound = sound; }
         speak(): string { return this.sound; }
       }

       function announce(who: Reference<Speaker>): void { console.log(who.speak()); }

       export function main(): i32 {
         announce(new Cat("mew"));
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("mew\n");
  });

  test("dispatch reaches the derived override", async () => {
    const result = await run(
      "iface-override",
      `${SPEAKER}
       class Animal { speak(): string { return "..."; } }
       class Wolf extends Animal { override speak(): string { return "howl"; } }

       function announce(who: Reference<Speaker>): void { console.log(who.speak()); }

       export function main(): i32 {
         announce(new Wolf());
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("howl\n");
  });

  test("the itab is for the static type, so a sliced object speaks as its base", async () => {
    // The subtle one, and the reason the itab records a *class* rather than
    // being looked up from the object. `a` was sliced to an `Animal`, so it
    // converts with `Animal`'s itab and answers with `Animal`'s body — which
    // is also where a virtual call through it would have gone.
    const result = await run(
      "iface-slice-then-convert",
      `${SPEAKER}
       class Animal { speak(): string { return "..."; } }
       class Wolf extends Animal { override speak(): string { return "howl"; } }

       function announce(who: Reference<Speaker>): void { console.log(who.speak()); }

       export function main(): i32 {
         const w = new Wolf();
         announce(w);
         const a: Animal = w;
         announce(a);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("howl\n...\n");
  });

  test("slots are sorted by name, not by declaration order", async () => {
    // Declared scale/area/name; dispatched area/name/scale. If the slot were
    // the declaration's position, every one of these three would call the
    // wrong body — and two of them have compatible signatures, so it would
    // print plausible numbers rather than crash.
    const result = await run(
      "iface-slot-order",
      `interface Shape {
         scale(by: i32): i32;
         area(): i32;
         name(): string;
       }
       class Square implements Shape {
         side: i32;
         constructor(side: i32) { this.side = side; }
         area(): i32 { return this.side * this.side; }
         name(): string { return "square"; }
         scale(by: i32): i32 { return this.side * by; }
       }

       function report(s: Reference<Shape>): void {
         console.log(\`\${s.name()}: area=\${s.area()} scaled=\${s.scale(3)}\`);
       }

       export function main(): i32 {
         report(new Square(4));
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("square: area=16 scaled=12\n");
  });

  test("a contract method taking and returning an owning value", async () => {
    // The leak assertion is the point: a `string` argument and a `string`
    // return, across a dispatch the caller cannot see the far side of.
    const result = await run(
      "iface-owning",
      `interface Greeter { greet(who: string): string; }
       class Polite implements Greeter {
         prefix: string;
         constructor(prefix: string) { this.prefix = prefix; }
         greet(who: string): string { return \`\${this.prefix}, \${who}\`; }
       }

       function use(g: Reference<Greeter>): void {
         console.log(g.greet("world"));
       }

       export function main(): i32 {
         let i: i32 = 0;
         while (i < 3) {
           use(new Polite("hello"));
           i = i + 1;
         }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("hello, world\nhello, world\nhello, world\n");
  });

  test("a local can hold a contract reference", async () => {
    const result = await run(
      "iface-local",
      `${SPEAKER}
       class Cat { speak(): string { return "mew"; } }

       export function main(): i32 {
         const c = new Cat();
         const s: Reference<Speaker> = c;
         console.log(s.speak());
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("mew\n");
  });

  test("an interface with only data members is still a struct", async () => {
    // The rule that must not have changed: adding contracts to the language
    // changed the meaning of no existing declaration.
    const result = await run(
      "iface-data-is-struct",
      `interface Point { x: i32; y: i32; }

       export function main(): i32 {
         const p: Point = { x: 3, y: 4 };
         const q: Point = p;
         q.x = 9;
         console.log(\`\${p.x},\${p.y} \${q.x},\${q.y}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("3,4 9,4\n");
  });
});

describe("contracts: what is rejected", () => {
  test("an interface mixing methods and data", async () => {
    const diagnostic = await expectRejected(
      "iface-mixed",
      `interface Bad { name: string; speak(): string; }
       function use(b: Reference<Bad>): void { console.log(b.speak()); }
       export function main(): i32 { return 0; }\n`,
      "GF0002",
    );
    expect(diagnostic.message).toContain("shape");
    expect(diagnostic.message).toContain("contract");
  });

  test("a contract as a by-value parameter", async () => {
    const diagnostic = await expectRejected(
      "iface-by-value",
      `${SPEAKER}
       function use(s: Speaker): void { console.log(s.speak()); }
       export function main(): i32 { return 0; }\n`,
      "GF0002",
    );
    expect(diagnostic.message).toContain("Reference<Speaker>");
  });

  test("a contract as a struct field", async () => {
    await expectRejected(
      "iface-as-field",
      `${SPEAKER}
       interface Holder { who: Speaker; }
       function use(h: Holder): void { console.log(h.who.speak()); }
       export function main(): i32 { return 0; }\n`,
      "GF0002",
    );
  });

  test("a class that does not satisfy the contract is tsc's business", async () => {
    // Nothing here needs its own check: the conversion is an assignment, and
    // tsc decides assignability. Worth pinning so that a future frontend check
    // does not duplicate — and eventually disagree with — the type system.
    await expectRejected(
      "iface-unsatisfied",
      `${SPEAKER}
       class Mute { }
       function announce(who: Reference<Speaker>): void { console.log(who.speak()); }
       export function main(): i32 { announce(new Mute()); return 0; }\n`,
      "TS2345",
    );
  });
});

describe("tryCast", () => {
  const HIERARCHY = `interface Speaker { speak(): string; }
       class Animal { legs(): i32 { return 4; } }
       class Dog extends Animal implements Speaker {
         speak(): string { return "woof"; }
       }
       class Rock extends Animal { }\n`;

  test("answers yes and no", async () => {
    const result = await run(
      "trycast-yes-no",
      `${HIERARCHY}
       export function main(): i32 {
         const d = tryCast<Speaker>(new Dog());
         if (d !== null) { console.log("dog: yes"); } else { console.log("dog: no"); }
         const r = tryCast<Speaker>(new Rock());
         if (r !== null) { console.log("rock: yes"); } else { console.log("rock: no"); }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("dog: yes\nrock: no\n");
  });

  test("the result dispatches once it has been checked", async () => {
    const result = await run(
      "trycast-dispatch",
      `${HIERARCHY}
       export function main(): i32 {
         const s = tryCast<Speaker>(new Dog());
         if (s !== null) { console.log(s.speak()); }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("woof\n");
  });

  test("each class in a hierarchy gets its own final overriders", async () => {
    // The bug this exists to catch: if a derived class inherited its base's
    // itab rather than getting its own, every one of these would print "base".
    // Right shape, wrong bodies — and nothing about the program would look
    // wrong while it happened.
    const result = await run(
      "trycast-overriders",
      `interface Speaker { speak(): string; }
       class Base implements Speaker { speak(): string { return "base"; } }
       class Middle extends Base { override speak(): string { return "middle"; } }
       class Leaf extends Middle { }

       export function main(): i32 {
         const b = tryCast<Speaker>(new Base());
         const m = tryCast<Speaker>(new Middle());
         const l = tryCast<Speaker>(new Leaf());
         if (b !== null && m !== null && l !== null) {
           console.log(\`\${b.speak()}/\${m.speak()}/\${l.speak()}\`);
         }
         return 0;
       }\n`,
    );
    // `Leaf` overrides nothing, so it reaches `Middle`'s body and not `Base`'s.
    expect(result.stdout).toBe("base/middle/middle\n");
  });

  test("`null ===` on the left is the same question", async () => {
    const result = await run(
      "trycast-null-left",
      `${HIERARCHY}
       export function main(): i32 {
         const r = tryCast<Speaker>(new Rock());
         if (null === r) { console.log("no"); } else { console.log("yes"); }
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("no\n");
  });

  test("using the result unchecked is tsc's business", async () => {
    // The reason `| null` was chosen over a boolean type guard: a guard can be
    // ignored, and this cannot. tsc refuses it before the compiler is involved.
    await expectRejected(
      "trycast-unchecked",
      `${HIERARCHY}
       export function main(): i32 {
         console.log(tryCast<Speaker>(new Dog()).speak());
         return 0;
       }\n`,
      "TS2531",
    );
  });

  test("casting to a class walks the base chain", async () => {
    // The same question as the interface case and a different mechanism:
    // descriptors have one owner and are compared by *address*, so this is a
    // pointer walk with no names in it — which is what works across a library
    // boundary, where comparing against the set of vtables known at compile
    // time does not (DECISIONS §11.3).
    const result = await run(
      "trycast-class",
      `class Animal { speak(): string { return "..."; } }
       class Dog extends Animal {
         override speak(): string { return "woof"; }
         trick(): string { return "roll over"; }
       }
       class Cat extends Animal { override speak(): string { return "mew"; } }

       function report(a: Reference<Animal>): void {
         const d = tryCast<Dog>(a);
         if (d !== null) {
           console.log(\`dog: \${d.speak()} and can \${d.trick()}\`);
         } else {
           console.log(\`not a dog: \${a.speak()}\`);
         }
       }

       export function main(): i32 {
         report(new Dog());
         report(new Cat());
         report(new Animal());
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe(
      "dog: woof and can roll over\nnot a dog: mew\nnot a dog: ...\n",
    );
  });

  test("casting to something that is neither a class nor a contract", async () => {
    const diagnostic = await expectRejected(
      "trycast-to-width",
      `${HIERARCHY}
       export function main(): i32 {
         const n = tryCast<i32>(new Rock());
         return 0;
       }\n`,
      "GF0002",
    );
    expect(diagnostic.message).toContain("nativeCast");
  });
});

describe("contract edges", () => {
  test("a contract with two methods dispatches to both", async () => {
    const result = await run(
      "contract-two-methods",
      `interface Pair { first(): i32; second(): i32; }
       class Impl { first(): i32 { return 1; } second(): i32 { return 2; } }

       function total(p: Reference<Pair>): i32 { return p.first() * 10 + p.second(); }

       export function main(): i32 {
         const impl = new Impl();
         return total(impl);
       }\n`,
    );
    expect(result.exitCode).toBe(12);
  });

  test("a contract method takes arguments", async () => {
    const result = await run(
      "contract-args",
      `interface Adder { add(a: i32, b: i32): i32; }
       class Impl { add(a: i32, b: i32): i32 { return a + b; } }

       function use(x: Reference<Adder>): i32 { return x.add(2, 3); }

       export function main(): i32 {
         const impl = new Impl();
         return use(impl);
       }\n`,
    );
    expect(result.exitCode).toBe(5);
  });

  test("a contract may extend another, and the itab carries both halves", async () => {
    const result = await run(
      "contract-extends",
      `interface Base { a(): i32; }
       interface Derived extends Base { b(): i32; }
       class Impl { a(): i32 { return 1; } b(): i32 { return 2; } }

       function use(x: Reference<Derived>): i32 { return x.a() * 10 + x.b(); }

       export function main(): i32 {
         const impl = new Impl();
         return use(impl);
       }\n`,
    );
    expect(result.exitCode).toBe(12);
  });

  test("a temporary may be converted at a call site, unlike a binding", async () => {
    // GF0234 rejects a *binding* that borrows a temporary, because the binding
    // outlives it. A conversion made for an argument does not: the temporary
    // lives to the end of the full expression, and the call finishes inside it.
    const result = await run(
      "contract-temp-arg",
      `interface Speaker { speak(): string; }
       class Dog { speak(): string { return "woof"; } }

       function announce(who: Reference<Speaker>): void { console.log(who.speak()); }

       export function main(): i32 {
         announce(new Dog());
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("woof\n");
    expect(result.leaked).toBe(0);
  });

  test("`tryCast` finds a class only when it says `implements`", async () => {
    // Conversion is structural; discovery is not. The itab a conversion site
    // registers belongs to that site, and a dynamic cast has never seen it —
    // so `implements` is what puts the answer in the type descriptor.
    const withClause = await run(
      "contract-trycast-implements",
      `interface Speaker { speak(): string; }
       class Dog implements Speaker { speak(): string { return "woof"; } }

       export function main(): i32 {
         const d = new Dog();
         const s = tryCast<Speaker>(d);
         if (s !== null) { console.log(s.speak()); return 0; }
         return 1;
       }\n`,
    );
    expect(withClause.stdout).toBe("woof\n");
    expect(withClause.exitCode).toBe(0);

    const without = await run(
      "contract-trycast-structural",
      `interface Speaker { speak(): string; }
       class Dog { speak(): string { return "woof"; } }

       export function main(): i32 {
         const d = new Dog();
         const s = tryCast<Speaker>(d);
         if (s !== null) { return 0; }
         return 1;
       }\n`,
    );
    expect(without.exitCode).toBe(1);
  });
});
