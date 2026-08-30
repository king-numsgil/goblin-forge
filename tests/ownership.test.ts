/**
 * The value model, at the places drops are hardest to place.
 *
 * REWRITE-PLAN §9 calls the automatic live-allocation check the assertion that
 * "found more real bugs than every deliberate assertion combined", and every
 * test here runs through {@link run}, so it gets that check for free. What this
 * file adds is *reaching* the awkward places: temporaries born inside a loop
 * condition, inside a `for` update clause, inside the operand of a `&&` that
 * short-circuits; values returned out of a parameter; values moved and then
 * assigned over.
 *
 * Two things worth knowing before reading the failures below:
 *
 * * A leak count of zero is not a clean bill of health. The runtime prints its
 *   count from an exit hook, so a program that dies before exiting prints
 *   nothing — and {@link run} reads a missing report as zero, because a program
 *   that never allocated never registers one either. The tests that matter
 *   assert the **exit code** as well.
 * * On Windows a heap corruption abort is `0xC0000374`, and the low eight bits
 *   of that are 116. That number appearing as an exit code below is not a
 *   value the program computed.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("the leak check itself", () => {
    test("a program that returns from `main` always reports, even allocating nothing", async () => {
        // `gf_runtime_init` runs at the top of every `bin`'s `main` and registers
        // the reporter whether or not anything is ever allocated. That is what
        // makes a *missing* report mean something.
        const result = await run(
            "leakcheck-no-allocation",
            `export function main(): i32 {
         const n: i32 = 2;
         return n;
       }\n`,
        );
        expect(result.exitCode).toBe(2);
        expect(result.leaked).toBe(0);
    });

    test("a program that dies before exiting is a failure, not a clean run", async () => {
        // The check that the check works. `abort` is the C runtime's, and it
        // terminates without running `atexit` handlers — which is exactly what a
        // heap corruption does, so this is the same observation a double free
        // produces without needing a compiler bug to produce it.
        //
        // Before the reporter moved to `main`, this scored `leaked: 0` and an exit
        // code that looked like a value the program had computed.
        let message = "";
        try {
            await run(
                "leakcheck-abort",
                `declare function abort(): void;

         export function main(): i32 {
           console.log("before");
           abort();
           return 0;
         }\n`,
            );
        } catch (error) {
            message = String((error as Error).message);
        }
        expect(message).toContain("did not exit normally");
        expect(message).toContain("before");
    });
});

describe("temporaries", () => {
    test("one made inside an `if` condition is released at the end of it", async () => {
        const result = await run(
            "own-temp-if",
            `export function main(): i32 {
         if (("a" + "b").length === 2) { console.log("y"); }
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("y\n");
        expect(result.leaked).toBe(0);
    });

    test("one made inside a `while` condition is released on every test of it", async () => {
        // The condition block is re-entered, so a drop placed in the loop *body*
        // would miss the last evaluation and one placed outside would run twice.
        const result = await run(
            "own-temp-while",
            `export function main(): i32 {
         let i: i32 = 0;
         while ((\`x\${i}\`).length < 4) { i = i + 1; }
         console.log("done");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("done\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("one made inside a `for` update clause is released on every iteration", async () => {
        const result = await run(
            "own-temp-for-update",
            `export function main(): i32 {
         let n: usize = 0;
         for (let i: i32 = 0; i < 20; i = i + 1) { n = n + (\`y\${i}\`).length; }
         console.log(\`\${n}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("50\n");
        expect(result.leaked).toBe(0);
    });

    test("one passed as an argument outlives the call and dies with the statement", async () => {
        const result = await run(
            "own-temp-arg",
            `function take(s: string): usize { return s.length; }

       export function main(): i32 {
         console.log(\`\${take("a" + "b")}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("2\n");
        expect(result.leaked).toBe(0);
    });

    test("one in a short-circuited operand is not created, and the other is released", async () => {
        const result = await run(
            "own-temp-shortcircuit",
            `export function main(): i32 {
         const yes: boolean = ("a" + "b").length === 2 && ("c" + "d").length === 2;
         const no: boolean = ("e" + "f").length === 9 && ("g" + "h").length === 2;
         if (yes && !no) { console.log("ok"); }
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ok\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("the untaken arm of a conditional allocates nothing, and the taken one is owned", async () => {
        const result = await run(
            "own-temp-ternary",
            `export function main(): i32 {
         const c: boolean = false;
         const s: string = c ? "a" + "b" : (c ? "c" + "d" : "e" + "f");
         console.log(s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ef\n");
        expect(result.leaked).toBe(0);
    });

    test("temporaries in a loop do not accumulate across twenty iterations", async () => {
        const result = await run(
            "own-temp-loop",
            `function id(s: string): usize { return s.length; }

       export function main(): i32 {
         let total: usize = 0;
         let i: i32 = 0;
         while (i < 20) {
           total = total + id(\`item \${i}\` + "!");
           i = i + 1;
         }
         console.log(\`\${total}\`);
         return 0;
       }\n`,
        );
        expect(result.leaked).toBe(0);
        expect(result.exitCode).toBe(0);
    });
});

describe("aggregates that own", () => {
    test("a class built in a loop releases its fields every iteration", async () => {
        const result = await run(
            "own-class-loop",
            `class C {
         s: string;
         constructor(s: string) { this.s = s; }
       }

       export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) { const c = new C(\`v\${i}\`); i = i + 1; }
         console.log("done");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("done\n");
        expect(result.leaked).toBe(0);
    });

    test("a struct built in a loop does too", async () => {
        const result = await run(
            "own-struct-loop",
            `interface S { s: string; }

       export function main(): i32 {
         let i: i32 = 0;
         while (i < 20) { const s: S = { s: \`v\${i}\` }; i = i + 1; }
         console.log("done");
         return 0;
       }\n`,
        );
        expect(result.leaked).toBe(0);
    });

    test("an early return out of a scope holding a class releases it", async () => {
        const result = await run(
            "own-class-early-return",
            `class C {
         s: string;
         constructor(s: string) { this.s = s; }
       }

       export function main(): i32 {
         const c = new C("a" + "b");
         if (c.s.length === 2) { return 0; }
         return 1;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("slicing a derived class releases only what the base has room for", async () => {
        const result = await run(
            "own-slice",
            `class A {
         a: string;
         constructor(a: string) { this.a = a; }
       }
       class B extends A {
         b: string;
         constructor(a: string, b: string) { super(a); this.b = b; }
       }

       export function main(): i32 {
         const d = new B("a" + "1", "b" + "2");
         const sliced: A = d;
         console.log(sliced.a);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("a1\n");
        expect(result.leaked).toBe(0);
    });

    test("a fixed array of owning elements releases each of them", async () => {
        const result = await run(
            "own-array-elements",
            `export function main(): i32 {
         const a: FixedArray<string, 4> = fixedArray(4, "x" + "y");
         console.log(a[0] + a[3]);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("xyxy\n");
        expect(result.leaked).toBe(0);
    });
});

describe("borrowing without copying", () => {
    test("reading a field of a by-value parameter does not take it", async () => {
        const result = await run(
            "own-read-param-field",
            `interface S { s: string; }
       function get(v: S): string { return v.s; }

       export function main(): i32 {
         const a: S = { s: "a" + "b" };
         console.log(get(a));
         console.log(a.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\nab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("returning `this.field` copies rather than taking", async () => {
        const result = await run(
            "own-return-this-field",
            `class C {
         s: string;
         constructor(s: string) { this.s = s; }
         get(): string { return this.s; }
       }

       export function main(): i32 {
         const c = new C("a" + "b");
         console.log(c.get());
         console.log(c.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\nab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("a string handed on to a second function is still the caller's", async () => {
        const result = await run(
            "own-forward-arg",
            `function inner(s: string): usize { return s.length; }
       function outer(s: string): usize { return inner(s); }

       export function main(): i32 {
         const a: string = "a" + "b";
         console.log(\`\${outer(a)}\`);
         console.log(a);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("2\nab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });
});

describe("returning an owning value", () => {
    test("a local is moved out, not copied", async () => {
        const result = await run(
            "own-return-local",
            `function f(): string {
         const a: string = "a" + "b";
         return a;
       }

       export function main(): i32 {
         console.log(f());
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("a local returned from inside a branch, with another path returning a literal", async () => {
        const result = await run(
            "own-return-branch",
            `function f(c: boolean): string {
         const a: string = "a" + "b";
         if (c) { return a; }
         return "z";
       }

       export function main(): i32 {
         console.log(f(true));
         console.log(f(false));
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\nz\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("an explicit copy of a parameter may be returned", async () => {
        const result = await run(
            "own-return-param-copy",
            `function id(s: string): string {
         const t: string = s;
         return t;
       }

       export function main(): i32 {
         console.log(id("a" + "b"));
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("`return move(param)` is GF0236, and the message says why", async () => {
        const diagnostic = await expectRejected(
            "own-return-param-move",
            `function id(s: string): string {
         return move(s);
       }

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0236",
        );
        expect(diagnostic.message).toContain("by-value parameter");
    });

    test("`return param` is a copy, where `return move(param)` is an error", async () => {
        // The two spellings lower to the same implicit move (REWRITE-PLAN §4.4), so
        // GF0236's rule has to hold for both — the caller releases a by-value
        // argument, and an owning value travels as a handle, so handing the buffer
        // out of the callee leaves the caller's release still to come. It used to
        // do exactly that, and the program aborted on a corrupted heap.
        //
        // The written `move` stays an error, because it asks for something that
        // cannot be done. The unwritten one is a copy: `return s` is the same read
        // of an owning value that copies everywhere else, and it is what C++
        // produces once its own implicit move is unavailable. Same answer, one
        // extra allocation.
        const result = await run(
            "own-return-param-implicit",
            `function id(s: string): string {
         return s;
       }

       export function main(): i32 {
         const v: string = id("a" + "b");
         console.log(v);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("the caller's argument survives the callee returning it", async () => {
        const result = await run(
            "own-return-param-caller-keeps",
            `function id(s: string): string {
         return s;
       }

       export function main(): i32 {
         const original: string = "a" + "b";
         const returned: string = id(original);
         console.log(original + returned);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("abab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("a struct parameter with an owning field, returned", async () => {
        const result = await run(
            "own-return-param-struct",
            `interface S { s: string; }
       function id(v: S): S { return v; }

       export function main(): i32 {
         const a: S = { s: "a" + "b" };
         const b: S = id(a);
         console.log(b.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("a class parameter with an owning field, returned", async () => {
        const result = await run(
            "own-return-param-class",
            `class C {
         s: string;
         constructor(s: string) { this.s = s; }
       }
       function id(v: C): C { return v; }

       export function main(): i32 {
         const a = new C("a" + "b");
         const b: C = id(a);
         console.log(b.s);
         return 0;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
    });

    test("a parameter of a trivial type may of course be returned", async () => {
        const result = await run(
            "own-return-param-scalar",
            `function id(n: i32): i32 { return n; }

       export function main(): i32 {
         return id(7);
       }\n`,
        );
        expect(result.exitCode).toBe(7);
    });
});

describe("the moved-from check", () => {
    test("a move in a sibling block does not poison the following one", async () => {
        const result = await run(
            "own-move-sibling",
            `export function main(): i32 {
         const s: string = "a" + "b";
         { const t: string = move(s); console.log(t); }
         { console.log("ok"); }
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\nok\n");
        expect(result.leaked).toBe(0);
    });

    test("a move followed by a read in the same block is GF0235", async () => {
        await expectRejected(
            "own-move-read",
            `export function main(): i32 {
         const s: string = "a" + "b";
         const t: string = move(s);
         console.log(s);
         return 0;
       }\n`,
            "GF0235",
        );
    });

    test("a branch that moves and does not refill still poisons the binding", async () => {
        // The conservative half of the rule, and the reason the check is not
        // flow-sensitive: the compiler does not know whether the branch ran, so it
        // assumes it did. Rejecting here costs a program that might have been fine;
        // accepting would read an empty string with no warning at all.
        await expectRejected(
            "own-move-branch-no-refill",
            `function take(s: string): void { console.log(s); }

       export function main(): i32 {
         let s: string = "a" + "b";
         const c: boolean = true;
         if (c) { take(move(s)); }
         console.log(s);
         return 0;
       }\n`,
            "GF0235",
        );
    });

    test("the right-hand side is read before the assignment clears the mark", async () => {
        // `s = f(move(s))` still sees its own move, so clearing on assignment does
        // not open a hole in the statement that does the clearing.
        await expectRejected(
            "own-move-self-feed",
            `export function main(): i32 {
         let s: string = "a" + "b";
         const t: string = move(s);
         s = s + "!";
         console.log(s);
         return 0;
       }\n`,
            "GF0235",
        );
    });

    test("assigning to a moved-from binding gives it a value again", async () => {
        // `move` leaves the source empty; `s = …` puts something back. That is
        // C++'s rule for a moved-from object — valid but unspecified, and an
        // assignment is how you return it to a known state — and without it a
        // `let` could never be reused after being moved out of, which is the
        // ordinary way to hand a buffer on from inside a loop.
        const result = await run(
            "own-move-reassign",
            `export function main(): i32 {
         let s: string = "a" + "b";
         const t: string = move(s);
         s = "c" + "d";
         console.log(s + t);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("cdab\n");
    });

    test("a move inside a loop, with the binding refilled before the next pass", async () => {
        const result = await run(
            "own-move-loop-refill",
            `function take(s: string): void { console.log(s); }

       export function main(): i32 {
         let s: string = "a" + "b";
         let i: i32 = 0;
         while (i < 2) {
           take(move(s));
           s = "c" + "d";
           i = i + 1;
         }
         console.log(s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\ncd\ncd\n");
    });

    test("a move under an `if`, with the binding refilled before the `if` ends", async () => {
        // The move is recorded for the rest of the function rather than the rest
        // of the block, so this is *not* the flow-sensitive answer — it works
        // because the assignment inside the branch clears the mark, on the one
        // path that took it. A branch that moves and does not refill still poisons
        // the binding afterwards, which is the conservative half and is checked
        // below.
        const result = await run(
            "own-move-under-if",
            `function take(s: string): void { console.log(s); }

       export function main(): i32 {
         let s: string = "a" + "b";
         const c: boolean = true;
         if (c) { take(move(s)); s = "c" + "d"; }
         console.log(s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\ncd\n");
    });

    test("moving a scalar is allowed and is just a copy", async () => {
        const result = await run(
            "own-move-scalar",
            `export function main(): i32 {
         const a: i32 = 7;
         const b: i32 = move(a);
         return b;
       }\n`,
        );
        expect(result.exitCode).toBe(7);
    });

    test("a whole struct may be moved", async () => {
        const result = await run(
            "own-move-struct",
            `interface S { s: string; }

       export function main(): i32 {
         const a: S = { s: "x" + "y" };
         const b: S = move(a);
         console.log(b.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("xy\n");
        expect(result.leaked).toBe(0);
    });

    test("moving out of a field is GF0001, not a silent partial move", async () => {
        await expectRejected(
            "own-move-field",
            `interface S { s: string; }

       export function main(): i32 {
         const a: S = { s: "x" + "y" };
         const t: string = move(a.s);
         console.log(t);
         return 0;
       }\n`,
            "GF0001",
        );
    });

    test("a move under an `if` lowers the drop flag, so the value is not destroyed twice", async () => {
        // A local that is moved on *some* paths gets a drop flag, and the flag
        // has to come back down where the move happens. It did not: it was raised
        // where the local was written and lowered only at its `StorageLive` and
        // `StorageDead`, so the conditional path moved the value into the array
        // **and** destroyed it. A double free, and one that showed up only for a
        // conditional move — an unconditional one leaves the local uninitialised
        // on every path, so it gets no flag and no second drop.
        //
        // The count is what catches it: two of the four iterations move, so a
        // flag that never comes down is two extra frees.
        const result = await run(
            "own-conditional-move",
            `interface E { key: string }

       export function main(): i32 {
         const xs: E[] = [{key: "a"}, {key: "b"}];
         for (let i: i32 = 0; i < 4; i = i + 1) {
           const e: E = {key: \`value \${i}\`};
           if (i % 2 === 0) { xs[0] = move(e); }
         }
         console.log(\`\${xs[0].key} \${xs[1].key}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("value 2 b\n");
        expect(result.leaked).toBe(0);
    });

    test("the same, moved into a call rather than into an element", async () => {
        const result = await run(
            "own-conditional-move-call",
            `function take(s: string): void { console.log(s); }

       export function main(): i32 {
         for (let i: i32 = 0; i < 4; i = i + 1) {
           const s = \`value \${i}\`;
           if (i % 2 === 0) { take(move(s)); }
         }
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("value 0\nvalue 2\n");
        expect(result.leaked).toBe(0);
    });

    test("a move on one arm and none on the other, with the value read after", async () => {
        // The shape a swap-remove has: the move happens only when there is
        // somewhere to move to, and the local is live either way.
        const result = await run(
            "own-conditional-move-arms",
            `export function main(): i32 {
         const xs: string[] = ["a", "b", "c"];
         let kept = "";
         for (let i: i32 = 0; i < 3; i = i + 1) {
           const taken = xs.pop();
           if (i === 1) { xs[0] = move(taken); } else { kept = kept + "."; }
         }
         console.log(\`\${xs.length} \${kept}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("0 ..\n");
        expect(result.leaked).toBe(0);
    });
});
