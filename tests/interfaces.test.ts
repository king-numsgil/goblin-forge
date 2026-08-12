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
