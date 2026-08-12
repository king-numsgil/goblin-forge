/**
 * Classes: vtables, virtual dispatch, inheritance, slicing, destructors.
 *
 * REWRITE-PLAN §12's milestone 8. The two behaviours worth naming, because they
 * are the ones a TypeScript programmer will not expect:
 *
 * * **Copying a class slices** (§4.1, §4.7). Assigning a `Dog` to an `Animal`
 *   binding copies the `Animal` part and installs the `Animal` vtable, so the
 *   result *is* an `Animal` — its methods dispatch to `Animal`'s. Polymorphism
 *   travels through `Reference<T>`, never through values.
 * * **A destructor is generated, not written.** There is no syntax for one. A
 *   class holding a `string` releases it because the field's type says so, and
 *   a derived class runs its own fields' releases and then its base's.
 *
 * Every `run` here asserts the live allocation count is zero afterwards, which
 * is what makes the destructor chain a checked property rather than an
 * intention (REWRITE-PLAN §9).
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("classes", () => {
  test("fields, a constructor, and a method that mutates", async () => {
    const result = await run(
      "class-basics",
      `class Counter {
         value: i32;
         constructor(start: i32) { this.value = start; }
         bump(by: i32): void { this.value = this.value + by; }
         read(): i32 { return this.value; }
       }

       export function main(): i32 {
         const c = new Counter(10);
         c.bump(5);
         c.bump(2);
         console.log(\`value=\${c.read()}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("value=17\n");
  });

  test("a class with no constructor is zero-initialised", async () => {
    // `Default` zeroes the storage and installs the vtable pointer, so an
    // object is dispatchable — and therefore destructible — before anything
    // else runs.
    const result = await run(
      "class-default",
      `class Empty {
         count: i32;
         label: string;
         report(): string { return \`\${this.count}/\${this.label.length}\`; }
       }

       export function main(): i32 {
         const e = new Empty();
         console.log(e.report());
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("0/0\n");
  });

  test("a method call dispatches to the derived override", async () => {
    // `describe` is declared once, on the base, and calls `this.name()`. The
    // derived object reaches the derived body — which is the whole point of the
    // vtable, and the thing a name-per-slot scheme gets right by accident and
    // wrong as soon as there are two hierarchies.
    const result = await run(
      "class-virtual",
      `class Shape {
         id: i32;
         constructor(id: i32) { this.id = id; }
         name(): string { return "shape"; }
         describe(): string { return \`#\${this.id} is a \${this.name()}\`; }
       }
       class Circle extends Shape {
         radius: i32;
         constructor(id: i32, radius: i32) { super(id); this.radius = radius; }
         override name(): string { return \`circle(r=\${this.radius})\`; }
       }

       export function main(): i32 {
         const s = new Shape(1);
         const c = new Circle(2, 7);
         console.log(s.describe());
         console.log(c.describe());
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("#1 is a shape\n#2 is a circle(r=7)\n");
  });

  test("copying a class slices it", async () => {
    // REWRITE-PLAN §4.7's second bullet, made observable. `a` takes `Animal`'s
    // fields and `Animal`'s vtable, so it speaks as an `Animal` — and `sound`
    // is not copied, because there is nowhere in an `Animal` to put it.
    const result = await run(
      "class-slicing",
      `class Animal {
         name: string;
         constructor(name: string) { this.name = name; }
         speak(): string { return "..."; }
       }
       class Dog extends Animal {
         sound: string;
         constructor(name: string, sound: string) { super(name); this.sound = sound; }
         override speak(): string { return this.sound; }
       }

       export function main(): i32 {
         const d = new Dog("rex", "woof");
         console.log(\`\${d.name}: \${d.speak()}\`);
         const a: Animal = d;
         console.log(\`\${a.name}: \${a.speak()}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("rex: woof\nrex: ...\n");
  });

  test("base fields are laid out first, so a field id survives inheritance", async () => {
    const result = await run(
      "class-field-order",
      `class A { a: i32; constructor() { this.a = 1; } }
       class B extends A { b: i32; constructor() { super(); this.b = 2; } }
       class C extends B { c: i32; constructor() { super(); this.c = 3; } }

       export function main(): i32 {
         const c = new C();
         console.log(\`\${c.a}\${c.b}\${c.c}\`);
         const b: B = c;
         console.log(\`\${b.a}\${b.b}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("123\n12\n");
  });

  test("a three-deep override chain reaches the final overrider", async () => {
    const result = await run(
      "class-deep-override",
      `class A { who(): string { return "A"; } }
       class B extends A { override who(): string { return "B"; } }
       class C extends B { }
       class D extends C { override who(): string { return "D"; } }

       export function main(): i32 {
         console.log(\`\${new A().who()}\${new B().who()}\${new C().who()}\${new D().who()}\`);
         return 0;
       }\n`,
    );
    // `C` inherits `B`'s override rather than falling back to `A`'s.
    expect(result.stdout).toBe("ABBD\n");
  });

  test("a class holding a string releases it, and so does its base", async () => {
    // The leak assertion in `run` is the real test here: two `string` fields on
    // two levels of the hierarchy, released by a destructor nobody wrote.
    const result = await run(
      "class-destructor-chain",
      `class Base { one: string; constructor(one: string) { this.one = one; } }
       class Derived extends Base {
         two: string;
         constructor(one: string, two: string) { super(one); this.two = two; }
       }

       export function main(): i32 {
         let total: usize = 0;
         let i: i32 = 0;
         while (i < 3) {
           const d = new Derived(\`a\${i}\`, \`b\${i}\`);
           total = total + d.one.length + d.two.length;
           i = i + 1;
         }
         console.log(\`total=\${total}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("total=12\n");
  });

  test("`super.m()` calls the base's body, and terminates", async () => {
    // The direct call is not an optimisation, it is the only thing that
    // terminates: a virtual call here would find `Cat.speak` again and recurse
    // until the stack ran out. `super` names a body, not a slot.
    //
    // Taken from a Bun REPL session, so the expected output is what JavaScript
    // itself prints for the same program.
    const result = await run(
      "class-super-method",
      `class Animal {
         constructor() {}
         public speak(): void { console.log("..."); }
       }
       class Dog extends Animal {
         private name: string;
         constructor(name: string) { super(); this.name = name; }
         public override speak(): void { console.log(\`\${this.name} barks!\`); }
       }
       class Cat extends Animal {
         private name: string;
         constructor(name: string) { super(); this.name = name; }
         public override speak(): void {
           super.speak();
           console.log(\`\${this.name} mewls!\`);
         }
       }

       export function main(): i32 {
         const d = new Dog("test");
         d.speak();
         const c = new Cat("cat");
         c.speak();
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("test barks!\n...\ncat mewls!\n");
  });

  test("`super.m()` reaches the nearest override, not the root", async () => {
    const result = await run(
      "class-super-middle",
      `class A { who(): string { return "A"; } }
       class B extends A { override who(): string { return "B"; } }
       class C extends B {
         override who(): string { return \`C(\${super.who()})\`; }
       }

       export function main(): i32 {
         console.log(new C().who());
         return 0;
       }\n`,
    );
    // `B`, because `B` is what `C`'s base resolves `who` to — not `A`.
    expect(result.stdout).toBe("C(B)\n");
  });

  test("`super.m()` returning a value, with arguments", async () => {
    const result = await run(
      "class-super-args",
      `class Base {
         scale(by: i32): i32 { return by * 2; }
       }
       class Twice extends Base {
         override scale(by: i32): i32 { return super.scale(by) + super.scale(by); }
       }

       export function main(): i32 {
         console.log(\`\${new Twice().scale(5)}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("20\n");
  });

  test("a class is a value: binding copies it", async () => {
    const result = await run(
      "class-value-semantics",
      `class Box {
         value: i32;
         constructor(value: i32) { this.value = value; }
       }

       export function main(): i32 {
         const a = new Box(1);
         const b: Box = a;
         b.value = 5;
         console.log(\`a=\${a.value} b=\${b.value}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("a=1 b=5\n");
  });

  test("a by-value class parameter is a copy", async () => {
    const result = await run(
      "class-by-value-param",
      `class Box {
         value: i32;
         constructor(value: i32) { this.value = value; }
       }

       function bump(box: Box): i32 {
         box.value = box.value + 100;
         return box.value;
       }

       export function main(): i32 {
         const b = new Box(1);
         const inside = bump(b);
         console.log(\`inside=\${inside} outside=\${b.value}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("inside=101 outside=1\n");
  });

  test("a class holding a string survives being copied", async () => {
    // The copy has to *clone* the string, not share the handle: both objects
    // are destroyed, and a shared handle is REWRITE-PLAN §10's double free.
    const result = await run(
      "class-copy-owning",
      `class Named {
         name: string;
         constructor(name: string) { this.name = name; }
       }

       export function main(): i32 {
         const a = new Named("hello");
         const b: Named = a;
         console.log(\`\${a.name}/\${b.name}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("hello/hello\n");
  });

  test("a method returning void is callable as a statement", async () => {
    const result = await run(
      "class-void-method",
      `class Log {
         count: i32;
         constructor() { this.count = 0; }
         note(): void { this.count = this.count + 1; }
       }

       export function main(): i32 {
         const l = new Log();
         l.note();
         l.note();
         console.log(\`\${l.count}\`);
         return 0;
       }\n`,
    );
    expect(result.stdout).toBe("2\n");
  });
});

describe("classes: what is rejected", () => {
  test("a field shadowing a base field", async () => {
    // The base's field would still be in the layout, unreachable and still
    // destroyed. Rejected rather than laid out twice.
    const diagnostic = await expectRejected(
      "class-shadow",
      // `override` because tsc insists on it for a member that hides a base
      // member. TypeScript is happy to let the derived declaration win; here
      // the base's field is still in the layout and still destroyed, so there
      // is nothing for a second one to override.
      `class A { x: i32; }
       class B extends A { override x: i32; }
       export function main(): i32 { return 0; }\n`,
      "GF0002",
    );
    expect(diagnostic.message).toContain("shadows");
  });

  test("a static member", async () => {
    await expectRejected(
      "class-static",
      `class A { static count: i32; }
       export function main(): i32 { return 0; }\n`,
      "GF0001",
    );
  });

  test("a getter", async () => {
    const diagnostic = await expectRejected(
      "class-getter",
      `class A {
         value: i32;
         constructor() { this.value = 1; }
         get doubled(): i32 { return this.value * 2; }
       }
       export function main(): i32 { return 0; }\n`,
      "GF0001",
    );
    expect(diagnostic.message).toContain("getter");
  });

  test("an `implements` clause", async () => {
    // Contracts and itables are the second half of milestone 8; the shape of
    // the answer is settled in DECISIONS §11.2 and not built yet.
    await expectRejected(
      "class-implements",
      `interface Speaker { speak(): string; }
       class A implements Speaker { speak(): string { return "a"; } }
       export function main(): i32 { return 0; }\n`,
      "GF0001",
    );
  });

  test("an interface with a method is a contract, and says so", async () => {
    const diagnostic = await expectRejected(
      "interface-contract",
      `interface Speaker { speak(): string; }
       function use(s: Speaker): i32 { return 0; }
       export function main(): i32 { return 0; }\n`,
      "GF0001",
    );
    // The message has to name the two things that *do* work, because "not
    // implemented" on its own leaves someone stuck. In particular it has to
    // point at the property-vs-method distinction, since that is the fix in
    // most of the cases where somebody did not want dispatch at all.
    expect(diagnostic.message).toContain("contract");
    expect(diagnostic.message).toContain("function pointer");
  });

  test("a parameter property", async () => {
    const diagnostic = await expectRejected(
      "class-param-property",
      `class A { constructor(public x: i32) { } }
       export function main(): i32 { return 0; }\n`,
      "GF0001",
    );
    expect(diagnostic.message).toContain("parameter property");
  });

  test("moving out of a by-value parameter", async () => {
    // Found by the C++ oracle as a double free before it was a diagnostic.
    // §11.4 puts destruction of a by-value argument on the caller, and an
    // owning value travels as a handle in a register — so the callee's `move`
    // empties a local the caller has never heard of, and both release the
    // buffer.
    const diagnostic = await expectRejected(
      "class-move-param",
      `class Named {
         name: string;
         constructor(name: string) { this.name = move(name); }
       }
       export function main(): i32 { return 0; }\n`,
      "GF0236",
    );
    expect(diagnostic.message).toContain("twice");
  });

  test("the same rule applies to a plain function", async () => {
    // Nothing about it is class-specific; classes are just where it showed up.
    await expectRejected(
      "move-param-function",
      `function keep(s: string): string { return move(s); }
       export function main(): i32 { return 0; }\n`,
      "GF0236",
    );
  });

  test("`super.m()` naming a method the base does not have", async () => {
    // tsc gets there first, which is the right outcome — its message is better
    // and its caret is on the name. The lowerer keeps its own check anyway,
    // because REWRITE-PLAN §8 says the backend must never be the thing that
    // notices, and "tsc would have caught it" is an assumption rather than a
    // guarantee.
    await expectRejected(
      "class-super-missing",
      `class A { }
       class B extends A {
         go(): void { super.nope(); }
       }
       export function main(): i32 { return 0; }\n`,
      "TS2339",
    );
  });

  test("an interface holding a function-typed property stays a plain struct", async () => {
    // The other side of the same rule: `speak: () => string` is a *field*, so
    // the interface is data and is laid out as a struct. It is not implemented
    // yet either — there are no function values — but the diagnostic must be
    // about the function pointer rather than about dispatch.
    const diagnostic = await expectRejected(
      "interface-callback-field",
      `interface Handler { speak: () => i32; }
       function use(h: Handler): i32 { return 0; }
       export function main(): i32 { return 0; }\n`,
      "GF0001",
    );
    expect(diagnostic.message).not.toContain("contract");
  });
});
