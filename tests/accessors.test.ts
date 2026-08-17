/**
 * `get name()` and `set name(v)`.
 *
 * A method wearing property syntax. It gets a vtable slot like any other
 * method, which is the part that matters: `override get` has to reach the
 * derived body through a base reference, exactly as an overridden method does.
 *
 * A getter and a setter of the same name are **two functions with two slots**,
 * not one thing with two halves, and a class may declare either without the
 * other. That is also why they live in two tables rather than one.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

describe("getters", () => {
    test("a getter reads through a call", async () => {
        const result = await run(
            "acc-get",
            `class Box {
         private _v: i32;
         constructor(v: i32) { this._v = v; }
         get v(): i32 { return this._v * 2; }
       }

       export function main(): i32 {
         const b = new Box(21);
         return b.v;
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("the program that started this", async () => {
        // Reported from a work machine, and the reason accessors exist now. The
        // getter was the only real error; the four that followed were cascade,
        // because a class that fails to analyse takes everything naming it with it.
        const result = await run(
            "acc-report",
            `class Animal {
         protected _name: string;

         public constructor(name: string) {
           this._name = name;
         }

         public get name(): string {
           return this._name;
         }

         public speak(): void {
           console.log(\`Speaking \${this.name}\`);
         }
       }

       class Dog extends Animal {
         public constructor(name: string) {
           super(name);
         }

         public override speak(): void {
           console.log(\`\${this.name} barks!\`);
         }
       }

       export function main(): i32 {
         console.log("hello from goblin-forge");

         const dog = new Dog("Doggy");
         dog.speak();

         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("hello from goblin-forge\nDoggy barks!\n");
        expect(result.leaked).toBe(0);
    });

    test("a getter dispatches, so an override is reached through a base", async () => {
        const result = await run(
            "acc-override",
            `class A { get tag(): i32 { return 1; } }
       class B extends A { override get tag(): i32 { return 2; } }

       function read(x: Reference<A>): i32 { return x.tag; }

       export function main(): i32 {
         const b = new B();
         return read(b) * 10 + b.tag;
       }\n`,
        );
        expect(result.exitCode).toBe(22);
    });

    test("a getter returning an owning value copies it out", async () => {
        const result = await run(
            "acc-owning",
            `class Holder {
         private _s: string;
         constructor(s: string) { this._s = s; }
         get s(): string { return this._s; }
       }

       export function main(): i32 {
         const h = new Holder("a" + "b");
         console.log(h.s + h.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("abab\n");
        expect(result.leaked).toBe(0);
    });

    test("a getter may read other members, including another accessor", async () => {
        const result = await run(
            "acc-chained",
            `class C {
         private _v: i32 = 3;
         get doubled(): i32 { return this._v * 2; }
         get quadrupled(): i32 { return this.doubled * 2; }
       }

       export function main(): i32 {
         return new C().quadrupled;
       }\n`,
        );
        expect(result.exitCode).toBe(12);
    });

    test("assigning to a getter with no setter is tsc's business", async () => {
        // Read-only in TypeScript's type system, so the user meets this while
        // typing rather than at build time.
        const {result} = await compileSource(
            "acc-readonly",
            `class A { get tag(): i32 { return 1; } }

       export function main(): i32 {
         const a = new A();
         a.tag = 2;
         return 0;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2540");
    });
});

describe("setters", () => {
    test("a setter writes through a call", async () => {
        const result = await run(
            "acc-set",
            `class Box {
         private _v: i32 = 0;
         get v(): i32 { return this._v; }
         set v(next: i32) { this._v = next * 2; }
       }

       export function main(): i32 {
         const b = new Box();
         b.v = 21;
         return b.v;
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("a setter dispatches too", async () => {
        const result = await run(
            "acc-set-override",
            `class A {
         seen: i32 = 0;
         set v(next: i32) { this.seen = next; }
       }
       class B extends A {
         override set v(next: i32) { this.seen = next * 10; }
       }

       function write(x: Reference<A>): void { x.v = 4; }

       export function main(): i32 {
         const b = new B();
         write(b);
         return b.seen;
       }\n`,
        );
        expect(result.exitCode).toBe(40);
    });

    test("a setter taking an owning value releases what it replaces", async () => {
        const result = await run(
            "acc-set-owning",
            `class Holder {
         private _s: string = "";
         get s(): string { return this._s; }
         set s(next: string) { this._s = next; }
       }

       export function main(): i32 {
         const h = new Holder();
         let i: i32 = 0;
         while (i < 20) { h.s = \`v\${i}\`; i = i + 1; }
         console.log(h.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("v19\n");
        expect(result.leaked).toBe(0);
    });

    test("a setter without a getter is write-only, and reading one is GF0002", async () => {
        // The mirror of assigning to a getter that has none. tsc permits this —
        // reading a write-only accessor gives back `undefined`, which is not a type
        // this language has — so the compiler is what refuses it.
        const diagnostic = await expectRejected(
            "acc-writeonly",
            `class A { set v(next: i32) { } }

       export function main(): i32 {
         const a = new A();
         return a.v;
       }\n`,
            "GF0002",
        );
        expect(diagnostic.message).toContain("written and not read");
    });
});

describe("static accessors", () => {
    test("a static getter is a static method with property syntax", async () => {
        const result = await run(
            "acc-static-get",
            `class Limits {
         static get max(): i32 { return 42; }
       }

       export function main(): i32 {
         return Limits.max;
       }\n`,
        );
        expect(result.exitCode).toBe(42);
    });

    test("a static getter may compute, and may call another static", async () => {
        const result = await run(
            "acc-static-get-computed",
            `class Config {
         static base(): i32 { return 20; }
         static get doubled(): i32 { return Config.base() * 2; }
         // Not \`name\`: tsc reserves it on a constructor function (TS2699).
         static get label(): string { return "cfg" + "g"; }
       }

       export function main(): i32 {
         console.log(Config.label);
         return Config.doubled;
       }\n`,
        );
        expect(result.stdout).toBe("cfgg\n");
        expect(result.exitCode).toBe(40);
        expect(result.leaked).toBe(0);
    });

    test("a static setter is called by assignment", async () => {
        // With no static *fields* yet there is nowhere for one to keep a value, so
        // what this pins is the call: the right-hand side arrives as the argument.
        const result = await run(
            "acc-static-set",
            `class Log {
         static set line(value: string) { console.log(value); }
       }

       export function main(): i32 {
         Log.line = "a" + "b";
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\n");
        expect(result.leaked).toBe(0);
    });

    test("a static accessor is inherited by name, and emitted once", async () => {
        const result = await run(
            "acc-static-inherited",
            `class Base { static get tag(): i32 { return 7; } }
       class Derived extends Base { }

       export function main(): i32 {
         return Base.tag + Derived.tag;
       }\n`,
        );
        expect(result.exitCode).toBe(14);
    });

    test("a static accessor and an instance one of the same name do not collide", async () => {
        // Two symbols, `C$get$x` and `C$static$get$x`, because they are two
        // functions — one takes a receiver and the other does not.
        const result = await run(
            "acc-static-and-instance",
            `class Both {
         get x(): i32 { return 1; }
         static get x(): i32 { return 2; }
       }

       export function main(): i32 {
         const b = new Both();
         return b.x * 10 + Both.x;
       }\n`,
        );
        expect(result.exitCode).toBe(12);
    });

    test("reading a static setter that has no getter is refused", async () => {
        const diagnostic = await expectRejected(
            "acc-static-set-only",
            `class Log {
         static set line(value: i32) { }
       }

       export function main(): i32 {
         return Log.line;
       }\n`,
            "GF0002",
        );
        expect(diagnostic.message).toContain("static setter");
    });

    test("writing a static getter that has no setter is tsc's error", async () => {
        // Better than the compiler's own: a read-only property is a thing
        // TypeScript understands, so the editor underlines it while you type. The
        // compiler keeps its check anyway, per REWRITE-PLAN §8 — it is simply not
        // reachable from a program tsc accepts.
        const {result} = await compileSource(
            "acc-static-get-only",
            `class Limits {
         static get max(): i32 { return 1; }
       }

       export function main(): i32 {
         Limits.max = 2;
         return 0;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2540");
    });
});

describe("what an accessor is not", () => {
    test("a name is a field or an accessor, and tsc refuses both", async () => {
        // The compiler refuses it too — the field would be unreachable and every
        // read of it would call the accessor — but tsc gets there first, which is
        // better: the user meets it while typing.
        const {result} = await compileSource(
            "acc-and-field",
            `class A {
         v: i32 = 1;
         get v(): i32 { return 2; }
       }

       export function main(): i32 { return 0; }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result)).toContain("TS2300");
    });

    test("an accessor cannot be taken as a function pointer", async () => {
        // A getter is reached by *naming* it, so there is no expression that means
        // "the function" — `C.x` already calls it. Taking its address would need a
        // syntax the language does not have, and tsc agrees: `C.x` has the
        // accessor's return type, not a function type.
        const {result} = await compileSource(
            "acc-as-fnptr",
            `class A { static get tag(): i32 { return 1; } }

       export function main(): i32 {
         const f: () => i32 = A.tag;
         return f();
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result).length).toBeGreaterThan(0);
    });
});
