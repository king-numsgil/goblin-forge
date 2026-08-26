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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RESERVED_ON_POINTER } from "../packages/forge/src/classes.ts";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

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

    test("a class laid out inside itself", async () => {
        // The erasure answers this for every other type, and cannot answer it
        // for a class: a class is nominal, so `erase` gives back its name and
        // never looks at its fields — which is what stops `Pointer<Node>` inside
        // `Node` from recursing there. So the lowerer asks it of the flattened
        // fields instead. Without it the backend's layout pass recurses until
        // the stack ends, with no file and no line.
        const diagnostic = await expectRejected(
            "class-inline-cycle",
            `class Node { value: i32; self: Node; }
       export function main(): i32 { return 0; }\n`,
            "GF0307",
        );
        expect(diagnostic.message).toContain("Pointer<Node>");
    });

    test("two classes laid out inside each other", async () => {
        await expectRejected(
            "class-inline-cycle-mutual",
            `class A { b: B; }
       class B { a: A; }
       export function main(): i32 { return 0; }\n`,
            "GF0307",
        );
    });

    test("a class reaching itself through a struct field", async () => {
        // Inline is inline whatever the aggregate is called, so the walk has to
        // go through a struct as well as through another class.
        await expectRejected(
            "class-inline-cycle-struct",
            `interface Holder { n: Node; }
       class Node { h: Holder; }
       export function main(): i32 { return 0; }\n`,
            "GF0307",
        );
    });

    test("a class holding a fixed array of itself", async () => {
        await expectRejected(
            "class-inline-cycle-fixed",
            `class Node { kids: FixedArray<Node, 2>; }
       export function main(): i32 { return 0; }\n`,
            "GF0307",
        );
    });

    test("a class that points at itself is fine, and so is a vector of itself", async () => {
        // The other side of the same rule, and the reason it is drawn at *inline*
        // storage: both of these are one machine word in the layout. The vector
        // works where a struct's would not because a class's drop is already a
        // function — `Node$drop` calls itself rather than being spliced in.
        const result = await run(
            "class-cyclic-handles",
            `class Node {
         value: i32;
         next: Pointer<Node> | null;
         kids: Node[];
         constructor(value: i32) { this.value = value; this.next = null; this.kids = []; }
       }

       export function main(): i32 {
         const root = new Node(1);
         root.kids.push(new Node(2));
         root.kids.push(new Node(3));
         let total: i32 = root.value;
         for (let i: usize = 0; i < root.kids.length; i = i + 1) {
           total = total + root.kids[i].value;
         }
         console.log(\`\${total}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("6\n");
        expect(result.leaked).toBe(0);
    });

    test("a getter reads through a call — see `tests/accessors.test.ts`", async () => {
        const result = await run(
            "class-getter",
            `class A {
         value: i32;
         constructor() { this.value = 1; }
         get doubled(): i32 { return this.value * 2; }
       }

       export function main(): i32 {
         return new A().doubled;
       }\n`,
        );
        expect(result.exitCode).toBe(2);
    });

    test("a contract used as a value", async () => {
        // A contract has no layout — it is C++'s abstract base, which cannot be
        // held by value either. The message has to name both ways out, because
        // "no layout" on its own leaves someone stuck: `Reference<I>` if dispatch
        // was wanted, a function-typed property if it was not.
        const diagnostic = await expectRejected(
            "interface-as-value",
            `interface Speaker { speak(): string; }
       function use(s: Speaker): i32 { return 0; }
       export function main(): i32 { return 0; }\n`,
            "GF0002",
        );
        expect(diagnostic.message).toContain("Reference<Speaker>");
        expect(diagnostic.message).toContain("function pointer");
    });

    test("a parameter property that duplicates a field is tsc's error", async () => {
        // The compiler keeps its own check — laying the field out twice would
        // destroy it twice — but tsc gets there first, which is where the error
        // belongs: `x` really is a duplicate identifier.
        const {result} = await compileSource(
            "class-param-property-twice",
            `class A {
         x: i32 = 0;
         constructor(public x: i32) { }
       }
       export function main(): i32 { return 0; }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2300");
    });

    test("a parameter property that shadows a base field is the compiler's", async () => {
        // tsc allows this one: a derived class may redeclare a base's property.
        // Here it would be laid out twice and destroyed twice.
        const diagnostic = await expectRejected(
            "class-param-property-shadow",
            `class Base { x: i32 = 0; }
       class Derived extends Base {
         constructor(public override x: i32) { super(); }
       }
       export function main(): i32 { return 0; }\n`,
            "GF0002",
        );
        expect(diagnostic.message).toContain("declared twice");
    });

    test("a parameter property using a name reserved on `Pointer<T>`", async () => {
        const diagnostic = await expectRejected(
            "class-param-property-reserved",
            `class A { constructor(public address: i32) { } }
       export function main(): i32 { return 0; }\n`,
            "GF0002",
        );
        expect(diagnostic.message).toContain("reserved");
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
        // The other side of the same rule: `speak: () => i32` is a *field*, so the
        // interface is data and is laid out as a struct holding a code address —
        // C's struct-of-callbacks, and not a contract with a vtable.
        const result = await run(
            "interface-callback-field",
            `interface Handler { speak: () => i32; }

       function one(): i32 { return 1; }
       function use(h: Handler): i32 { return h.speak(); }

       export function main(): i32 {
         const h: Handler = { speak: one };
         return use(h);
       }\n`,
        );
        expect(result.exitCode).toBe(1);
    });
});

describe("`Reference<C>` for a class", () => {
    test("keeps the dynamic type, where a by-value parameter slices", async () => {
        // The pair of lines this feature exists for, and the reason `Reference<T>`
        // is something you write rather than something the compiler infers.
        const result = await run(
            "classref-vs-value",
            `class Animal { speak(): string { return "..."; } }
       class Wolf extends Animal { override speak(): string { return "howl"; } }

       function viaRef(a: Reference<Animal>): string { return a.speak(); }
       function viaValue(a: Animal): string { return a.speak(); }

       export function main(): i32 {
         const w = new Wolf();
         console.log(\`ref=\${viaRef(w)} value=\${viaValue(w)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ref=howl value=...\n");
    });

    test("mutation through a reference reaches the caller's object", async () => {
        const result = await run(
            "classref-mutate",
            `class Box { v: i32; constructor(v: i32) { this.v = v; } }
       function bump(b: Reference<Box>): void { b.v = b.v + 100; }

       export function main(): i32 {
         const box = new Box(1);
         bump(box);
         console.log(\`\${box.v}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("101\n");
    });

    test("a reference is a borrow: nothing is released twice", async () => {
        // `Category::Borrow` doing its job. If a reference were treated as owning,
        // the callee would release a string the caller still owns.
        const result = await run(
            "classref-borrow",
            `class Named { name: string; constructor(name: string) { this.name = name; } }
       function read(n: Reference<Named>): usize { return n.name.length; }

       export function main(): i32 {
         let i: i32 = 0;
         let total: usize = 0;
         while (i < 3) {
           const n = new Named(\`item\${i}\`);
           total = total + read(n);
           i = i + 1;
         }
         console.log(\`total=\${total}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("total=15\n");
    });

    test("an upcast costs nothing, because a base is a layout prefix", async () => {
        const result = await run(
            "classref-upcast",
            `class A { who(): string { return "A"; } }
       class B extends A { override who(): string { return "B"; } }
       class C extends B { override who(): string { return "C"; } }

       function asA(x: Reference<A>): string { return x.who(); }
       function asB(x: Reference<B>): string { return x.who(); }

       export function main(): i32 {
         const c = new C();
         console.log(\`\${asA(c)}\${asB(c)}\`);
         return 0;
       }\n`,
        );
        // Both find `C`'s override: an upcast changes the type, not the object.
        expect(result.stdout).toBe("CC\n");
    });

    test("binding a reference to a temporary is GF0234", async () => {
        // REWRITE-PLAN §4.4: no lifetime extension. C++ keeps a temporary bound to
        // a `const&` alive; here it is rejected, because extending a lifetime puts
        // ownership back into the compiler's inference.
        const diagnostic = await expectRejected(
            "classref-temporary",
            `class Box { v: i32; constructor(v: i32) { this.v = v; } }
       export function main(): i32 {
         const r: Reference<Box> = new Box(1);
         return r.v;
       }\n`,
            "GF0234",
        );
        expect(diagnostic.message).toContain("outlive");
    });
});

describe("field initialisers", () => {
    // `class C { x: i32 = 5 }` is ordinary TypeScript and ordinary C++ — a
    // default member initialiser. The lowerer used to build the class's layout
    // from the declarations and never emit the initialiser, so the field held
    // whatever zero-initialisation left there and no diagnostic said so.
    //
    // They are constructor work now, which is what C++ makes them: a class with
    // initialisers and no `constructor` gets a generated `Class$new`, and the
    // order is base construction, then this class's initialisers in declaration
    // order, then the constructor body.

    test("a scalar field initialiser is stored", async () => {
        const result = await run(
            "class-init-scalar",
            `class C { x: i32 = 5; }

       export function main(): i32 {
         const c = new C();
         return c.x;
       }\n`,
        );
        expect(result.exitCode).toBe(5);
    });

    test("an owning field initialiser is stored", async () => {
        const result = await run(
            "class-init-string",
            `class C { s: string = "ab"; }

       export function main(): i32 {
         const c = new C();
         console.log(\`[\${c.s}]\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("[ab]\n");
    });

    test("an initialiser runs even when there is also a constructor", async () => {
        const result = await run(
            "class-init-with-ctor",
            `class C {
         x: i32 = 5;
         y: i32;
         constructor() { this.y = 2; }
       }

       export function main(): i32 {
         const c = new C();
         return c.x * 10 + c.y;
       }\n`,
        );
        expect(result.exitCode).toBe(52);
    });

    test("a base class's initialiser runs for a derived object", async () => {
        const result = await run(
            "class-init-inherited",
            `class A { a: i32 = 1; }
       class B extends A { b: i32 = 2; }

       export function main(): i32 {
         const b = new B();
         return b.a * 10 + b.b;
       }\n`,
        );
        expect(result.exitCode).toBe(12);
    });

    test("initialisers run in declaration order, and may read earlier fields", async () => {
        // Printed rather than returned: three fields do not fit in the eight bits
        // an exit code carries.
        const result = await run(
            "class-init-order",
            `class C {
         a: i32 = 2;
         b: i32 = this.a * 3;
         c: i32 = this.b + 1;
       }

       export function main(): i32 {
         const c = new C();
         console.log(\`\${c.a} \${c.b} \${c.c}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("2 6 7\n");
    });

    test("the constructor body runs after the initialisers, so it wins", async () => {
        // C++'s order exactly: a default member initialiser is not a fallback for
        // an unassigned field, it runs first and the body assigns over it.
        const result = await run(
            "class-init-then-body",
            `class C {
         x: i32 = 1;
         constructor() { this.x = 9; }
       }

       export function main(): i32 {
         const c = new C();
         return c.x;
       }\n`,
        );
        expect(result.exitCode).toBe(9);
    });

    test("a base constructor runs before a derived initialiser", async () => {
        // The ordering that says where the initialisers were put. Running them at
        // the `new` site instead would put B's ahead of A's constructor body, and
        // this prints the difference: A's body sets `shared` to 1, B's initialiser
        // then sets it to 2. In C++ the answer is 2.
        const result = await run(
            "class-init-base-first",
            `class A {
         shared: i32;
         constructor() { this.shared = 1; }
       }
       class B extends A {
         mine: i32 = this.take();
         take(): i32 { this.shared = 2; return 7; }
       }

       export function main(): i32 {
         const b = new B();
         return b.shared * 10 + b.mine;
       }\n`,
        );
        expect(result.exitCode).toBe(27);
    });

    test("an owning initialiser in a derived class is released once", async () => {
        const result = await run(
            "class-init-owning-inherited",
            `class A { a: string = "a" + "1"; }
       class B extends A { b: string = "b" + "2"; }

       export function main(): i32 {
         const value = new B();
         console.log(value.a + value.b);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("a1b2\n");
        expect(result.leaked).toBe(0);
    });

    test("initialisers in a loop do not accumulate", async () => {
        const result = await run(
            "class-init-loop",
            `class C { s: string = "x" + "y"; }

       export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) { const c = new C(); i = i + 1; }
         console.log("done");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("done\n");
        expect(result.leaked).toBe(0);
    });

    test("a three-deep chain runs every level's initialisers once", async () => {
        const result = await run(
            "class-init-three-deep",
            `class A { a: i32 = 1; }
       class B extends A { b: i32 = 2; }
       class C extends B { c: i32 = 3; }

       export function main(): i32 {
         const value = new C();
         return value.a * 100 + value.b * 10 + value.c;
       }\n`,
        );
        expect(result.exitCode).toBe(123);
    });

    test("a class with no initialisers and a base that has them still gets them", async () => {
        // `B` declares nothing at all, so it only has a constructor because `A`
        // needs one. Without that, `A`'s initialiser would never run for a `B`.
        const result = await run(
            "class-init-empty-derived",
            `class A { a: i32 = 4; }
       class B extends A { }

       export function main(): i32 {
         const b = new B();
         return b.a;
       }\n`,
        );
        expect(result.exitCode).toBe(4);
    });

    test("a field set in the constructor is stored, which is the working spelling", async () => {
        const result = await run(
            "class-ctor-assign",
            `class C {
         x: i32;
         constructor() { this.x = 5; }
       }

       export function main(): i32 {
         const c = new C();
         return c.x;
       }\n`,
        );
        expect(result.exitCode).toBe(5);
    });

    test("a class with no constructor and no initialisers is zeroed", async () => {
        const result = await run(
            "class-zeroed",
            `class C { x: i32; y: i32; }

       export function main(): i32 {
         const c = new C();
         return c.x + c.y;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
    });
});

describe("parameter properties", () => {
    test("`constructor(public x)` declares a field and assigns it", async () => {
        const result = await run(
            "class-pp-basic",
            `class Point {
         constructor(public x: i32, public y: i32) { }
         sum(): i32 { return this.x + this.y; }
       }

       export function main(): i32 {
         const p = new Point(3, 4);
         return p.sum() * 10 + p.x;
       }\n`,
        );
        expect(result.exitCode).toBe(73);
    });

    test("the field takes its layout position from where the constructor is written", async () => {
        // Fields are laid out in declaration order and never reordered, and a
        // parameter property is declared where its constructor is. The C++ oracle
        // has no equivalent syntax, so the check is the offsets themselves.
        const result = await run(
            "class-pp-layout",
            `class Mixed {
         a: u8 = 1;
         constructor(public b: i32) { }
         c: u8 = 3;
       }

       export function main(): i32 {
         const m = new Mixed(2);
         console.log(\`\${sizeOf<Mixed>()} \${m.a} \${m.b} \${m.c}\`);
         return 0;
       }\n`,
        );
        // vtable(8) + a(1) + pad(3) + b(4) + c(1) + pad(7) = 24.
        expect(result.stdout).toBe("24 1 2 3\n");
    });

    test("an owning parameter property is copied in, and the caller keeps its own", async () => {
        const result = await run(
            "class-pp-owning",
            `class Holder {
         constructor(public label: string) { }
       }

       export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) {
           const s: string = \`v\${i}\`;
           const h = new Holder(s);
           console.log(h.label);
           i = i + 1;
         }
         return 0;
       }\n`,
        );
        expect(result.stdout.split("\n").length).toBe(21);
        expect(result.leaked).toBe(0);
    });

    test("a field initialiser may read a parameter property", async () => {
        // The reason parameter properties are assigned *before* the initialisers:
        // this program only means anything in that order.
        const result = await run(
            "class-pp-before-initialisers",
            `class Scaled {
         doubled: i32 = this.base * 2;
         constructor(public base: i32) { }
       }

       export function main(): i32 {
         const s = new Scaled(21);
         return s.doubled;
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("the constructor body still sees the parameter, and may override the field", async () => {
        const result = await run(
            "class-pp-body",
            `class Clamped {
         constructor(public n: i32) {
           if (n > 10) { this.n = 10; }
         }
       }

       export function main(): i32 {
         return new Clamped(3).n + new Clamped(99).n;
       }\n`,
        );
        expect(result.exitCode).toBe(13);
    });

    test("a derived class gets its base's parameter property too", async () => {
        const result = await run(
            "class-pp-inherited",
            `class Base { constructor(public a: i32) { } }
       class Derived extends Base {
         constructor(a: i32, public b: i32) { super(a); }
       }

       export function main(): i32 {
         const d = new Derived(4, 5);
         return d.a * 10 + d.b;
       }\n`,
        );
        expect(result.exitCode).toBe(45);
    });

    test("`private` and `protected` are accepted and erased, as elsewhere", async () => {
        const result = await run(
            "class-pp-private",
            `class Counter {
         constructor(private n: i32) { }
         value(): i32 { return this.n; }
       }

       export function main(): i32 {
         return new Counter(9).value();
       }\n`,
        );
        expect(result.exitCode).toBe(9);
    });

    test("`readonly` alone makes one too, as it does in TypeScript", async () => {
        const result = await run(
            "class-pp-readonly",
            `class Tagged {
         constructor(readonly tag: i32) { }
       }

       export function main(): i32 {
         return new Tagged(6).tag;
       }\n`,
        );
        expect(result.exitCode).toBe(6);
    });

    test("a plain parameter is still just a parameter", async () => {
        const {result} = await compileSource(
            "class-pp-plain",
            `class A {
         constructor(x: i32) { }
       }

       export function main(): i32 {
         return new A(1).x;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
    });
});

describe("class members at the edges", () => {
    test("an implicit `super()` runs, so base fields are reachable", async () => {
        const result = await run(
            "class-implicit-super",
            `class A {
         a: i32;
         constructor() { this.a = 1; }
       }
       class B extends A {
         b: i32;
         constructor() { super(); this.b = 2; }
       }

       export function main(): i32 {
         const b = new B();
         return b.a + b.b;
       }\n`,
        );
        expect(result.exitCode).toBe(3);
    });

    test("a four-deep chain with a gap dispatches to the nearest overrider", async () => {
        const result = await run(
            "class-four-deep",
            `class A { f(): i32 { return 1; } }
       class B extends A { }
       class C extends B { override f(): i32 { return 3; } }
       class D extends C { }

       function through(x: Reference<A>): i32 { return x.f(); }

       export function main(): i32 {
         const d = new D();
         return through(d);
       }\n`,
        );
        expect(result.exitCode).toBe(3);
    });

    test("a `private` field is reachable from the class's own methods", async () => {
        const result = await run(
            "class-private",
            `class C {
         private x: i32;
         constructor(x: i32) { this.x = x; }
         get(): i32 { return this.x; }
       }

       export function main(): i32 {
         const c = new C(6);
         return c.get();
       }\n`,
        );
        expect(result.exitCode).toBe(6);
    });

    test("a `readonly` field is assignable in the constructor and nowhere else", async () => {
        const result = await run(
            "class-readonly-ok",
            `class C {
         readonly x: i32;
         constructor(x: i32) { this.x = x; }
       }

       export function main(): i32 {
         const c = new C(4);
         return c.x;
       }\n`,
        );
        expect(result.exitCode).toBe(4);

        const {result: bad} = await compileSource(
            "class-readonly-write",
            `class C {
         readonly x: i32;
         constructor(x: i32) { this.x = x; }
       }

       export function main(): i32 {
         const c = new C(4);
         c.x = 5;
         return c.x;
       }\n`,
        );
        expect(bad.ok).toBe(false);
        expect(errorCodes(bad).some((code) => code.startsWith("TS"))).toBe(true);
    });

    test("a field may be called `length` without colliding with a string's", async () => {
        const result = await run(
            "class-field-length",
            `class C {
         length: i32;
         constructor(n: i32) { this.length = n; }
       }

       export function main(): i32 {
         const c = new C(3);
         return c.length;
       }\n`,
        );
        expect(result.exitCode).toBe(3);
    });

    test("`this` may be returned as a reference and dispatched through", async () => {
        const result = await run(
            "class-return-this",
            `class C {
         x: i32;
         constructor(x: i32) { this.x = x; }
         self(): Reference<C> { return this; }
       }

       export function main(): i32 {
         const c = new C(9);
         return c.self().x;
       }\n`,
        );
        expect(result.exitCode).toBe(9);
    });

    test("a method taking more arguments than there are registers", async () => {
        const result = await run(
            "class-method-many-args",
            `class C {
         f(a: i32, b: i32, c: i32, d: i32, e: i32, g: i32, h: i32, i: i32): i32 {
           return a + b + c + d + e + g + h + i;
         }
       }

       export function main(): i32 {
         const c = new C();
         return c.f(1, 2, 3, 4, 5, 6, 7, 8);
       }\n`,
        );
        expect(result.exitCode).toBe(36);
    });

    test("a method may return a struct by value", async () => {
        const result = await run(
            "class-method-struct",
            `interface P { x: i32; y: i32; }
       class C { make(): P { return { x: 1, y: 2 }; } }

       export function main(): i32 {
         const c = new C();
         const p: P = c.make();
         return p.x + p.y;
       }\n`,
        );
        expect(result.exitCode).toBe(3);
    });

    test("an `override` without the keyword is tsc's business", async () => {
        const {result} = await compileSource(
            "class-no-override-keyword",
            `class A { f(): i32 { return 1; } }
       class B extends A { f(): i32 { return 2; } }

       export function main(): i32 {
         return new B().f();
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS4114");
    });
});

describe("names a class may not use", () => {
    // `Pointer<T>` is `T & CorePointer<T>`, so a class declaring one of the
    // pointer's own members has a member nothing can reach through a pointer to
    // it. tsc has no complaint — an intersection resolving to one side is what an
    // intersection *is* — so the compiler refuses it at the declaration.

    for (const reserved of RESERVED_ON_POINTER) {
        test(`\`${reserved}\` as a method is GF0002`, async () => {
            const diagnostic = await expectRejected(
                `class-reserved-${reserved}`,
                `class C { ${reserved}(): i32 { return 1; } }

         export function main(): i32 { return 0; }\n`,
                "GF0002",
            );
            expect(diagnostic.message).toContain("reserved");
        });
    }

    test("as a field, a getter and a setter too", async () => {
        for (const [what, member] of [
            ["field", "free: i32 = 0;"],
            ["getter", "get free(): i32 { return 0; }"],
            ["setter", "set free(v: i32) { }"],
        ] as const) {
            const {result} = await compileSource(
                `class-reserved-${what}`,
                `class C { ${member} }

         export function main(): i32 { return 0; }\n`,
            );
            expect({what, ok: result.ok}).toEqual({what, ok: false});
            expect({what, codes: errorCodes(result)}).toEqual({what, codes: ["GF0002"]});
        }
    });

    test("a `static` of the same name is fine — a pointer points at an instance", async () => {
        const result = await run(
            "class-reserved-static",
            `class C { static free(): i32 { return 7; } }

       export function main(): i32 { return C.free(); }\n`,
        );
        expect(result.exitCode).toBe(7);
    });

    test("the reserved list is exactly `CorePointer<T>`'s members", () => {
        // The anti-drift check. Adding a method to `CorePointer` without adding it
        // here would reintroduce the silent shadowing this rule exists to prevent,
        // and nothing else would notice.
        const prelude = readFileSync(
            join(dirname(dirname(fileURLToPath(import.meta.url))), "packages", "runtime", "global.d.ts"),
            "utf8",
        );
        const body = /interface CorePointer<T> \{([\s\S]*?)\n\}/.exec(prelude)?.[1] ?? "";
        const declared = [...body.matchAll(/^\s+(?:readonly\s+)?([A-Za-z_]\w*)\s*[(:<]/gm)].map(
            (match) => match[1]!,
        );
        expect([...new Set(declared)].sort()).toEqual([...RESERVED_ON_POINTER].sort());
    });
});

describe("class members the compiler does not have yet", () => {
    test("a `static` method is a namespaced free function", async () => {
        const result = await run(
            "class-static",
            `class C { static f(): i32 { return 1; } }

       export function main(): i32 {
         return C.f();
       }\n`,
        );
        expect(result.exitCode).toBe(1);
    });

    test("a `static` field is still GF0001", async () => {
        // A static *method* is a function with a qualified name and needs nowhere
        // to live. A static field is a global, and there are no globals yet — a
        // top-level `const` is `GF0001` too.
        await expectRejected(
            "class-static-field",
            `class C { static n: i32 = 1; }

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0001",
        );
    });

    test("an `abstract` method is GF0001, because it has no body", async () => {
        const diagnostic = await expectRejected(
            "class-abstract",
            `abstract class A { abstract f(): i32; }
       class B extends A { override f(): i32 { return 1; } }

       export function main(): i32 {
         return new B().f();
       }\n`,
            "GF0001",
        );
        expect(diagnostic.message).toContain("body");
    });
});
