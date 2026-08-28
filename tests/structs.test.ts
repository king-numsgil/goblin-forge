/**
 * Structs, and the value semantics they make visible.
 *
 * REWRITE-PLAN §4.7 lists "objects are values" as the largest semantic
 * difference the language has from TypeScript, and the one tsc cannot warn
 * about. This is where it becomes observable:
 *
 *     const b = a;  b.x = 5;   // `a` is untouched
 *
 * Layout itself is tested differentially against a C compiler in
 * `layout.test.ts`; these test what the language does with it.
 */

import { describe, expect, test } from "bun:test";

import { compileSource, errorCodes, expectRejected, run } from "./harness.ts";

const POINT = `interface Point { x: i32; y: i32; }\n`;

describe("structs", () => {
    test("an object literal builds a value, and its fields read back", async () => {
        const result = await run(
            "struct-literal",
            `${POINT}
       export function main(): i32 {
         const p: Point = { x: 3, y: 4 };
         console.log(\`(\${p.x}, \${p.y})\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("(3, 4)\n");
    });

    test("objects are values: binding copies", async () => {
        // The line REWRITE-PLAN §4.7 says has to be on the README's first page.
        const result = await run(
            "struct-value-semantics",
            `${POINT}
       export function main(): i32 {
         const a: Point = { x: 1, y: 2 };
         const b: Point = a;
         b.x = 5;
         console.log(\`a.x=\${a.x} b.x=\${b.x}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("a.x=1 b.x=5\n");
    });

    test("a by-value parameter is a copy the callee cannot write back through", async () => {
        const result = await run(
            "struct-by-value",
            `${POINT}
       function moveIt(p: Point): i32 {
         p.x = 99;
         return p.x;
       }

       export function main(): i32 {
         const original: Point = { x: 1, y: 2 };
         const inside: i32 = moveIt(original);
         console.log(\`inside=\${inside} outside=\${original.x}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("inside=99 outside=1\n");
    });

    test("a struct is returned into storage the caller designates", async () => {
        const result = await run(
            "struct-return",
            `${POINT}
       function shifted(p: Point, by: i32): Point {
         return { x: p.x + by, y: p.y };
       }

       export function main(): i32 {
         const start: Point = { x: 10, y: 20 };
         const moved: Point = shifted(start, 5);
         console.log(\`(\${moved.x}, \${moved.y}) from (\${start.x}, \${start.y})\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("(15, 20) from (10, 20)\n");
    });
});

describe("nested aggregates are inline", () => {
    test("a struct field occupies its own layout, not a pointer to it", async () => {
        // Not negotiable if C interop is a goal, and v1 had to be retrofitted for
        // it (REWRITE-PLAN §5.2). Observable here as the inner value being copied
        // with the outer one rather than shared with it.
        const result = await run(
            "struct-nested",
            `${POINT}
       interface Line { from: Point; to: Point; }

       export function main(): i32 {
         const a: Line = { from: { x: 0, y: 0 }, to: { x: 3, y: 4 } };
         const b: Line = a;
         b.to.x = 100;
         console.log(\`a.to.x=\${a.to.x} b.to.x=\${b.to.x}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("a.to.x=3 b.to.x=100\n");
    });

    test("three levels deep still copies the whole thing", async () => {
        const result = await run(
            "struct-deep",
            `interface Inner { v: i32; }
       interface Middle { inner: Inner; }
       interface Outer { middle: Middle; tag: i32; }

       export function main(): i32 {
         const a: Outer = { middle: { inner: { v: 1 } }, tag: 7 };
         const b: Outer = a;
         b.middle.inner.v = 42;
         console.log(\`\${a.middle.inner.v} \${b.middle.inner.v} \${b.tag}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 42 7\n");
    });

    test("a struct holding a string releases it", async () => {
        // The category comes from the type: a struct with an owning field is
        // owning, and there is no default copy operation to fall back on
        // (REWRITE-PLAN §4.1, §10).
        const result = await run(
            "struct-owning-field",
            `interface Named { name: string; id: i32; }

       export function main(): i32 {
         const a: Named = { name: "x" + "y", id: 1 };
         console.log(\`\${a.name} \${a.id}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("xy 1\n");
        expect(result.leaked).toBe(0);
    });
});

describe("what structs are not", () => {
    test("an optional field is rejected", async () => {
        // There is no `undefined` for it to be, and no space in the layout for it
        // not to be.
        await expectRejected(
            "struct-optional",
            `interface Loose { x?: i32; }

       export function main(): i32 {
         const a: Loose = { x: 1 };
         return 0;
       }\n`,
            "GF0002",
        );
    });

    test("an interface mixing a method and a data member", async () => {
        // An interface is a *shape* (data only, a struct) or a *contract* (methods
        // only, dispatched). One that is both would have to be a layout and a
        // dispatch table at once, so it is rejected rather than guessed at.
        const diagnostic = await expectRejected(
            "struct-method",
            `interface WithMethod { x: i32; go(): i32; }

       export function main(): i32 {
         const a: WithMethod = { x: 1, go: () => 1 };
         return 0;
       }\n`,
            "GF0002",
        );
        expect(diagnostic.message).toContain("both methods and the data member");
    });

    test("a missing field is tsc's business", async () => {
        const {result} = await compileSource(
            "struct-missing-field",
            `${POINT}
       export function main(): i32 {
         const p: Point = { x: 1 };
         return 0;
       }\n`,
        );
        expect(result.ok).toBe(false);
        expect(errorCodes(result).some((code) => code.startsWith("TS"))).toBe(true);
    });
});

describe("struct edges", () => {
    test("an interface with no fields has no machine representation", async () => {
        // A zero-sized struct is a real design question — C++ gives it size 1 so
        // that two objects have different addresses, C forbids it outright — and
        // the compiler declines to answer it rather than picking silently.
        const diagnostic = await expectRejected(
            "struct-empty",
            `interface E { }

       export function main(): i32 {
         const e: E = { };
         return 0;
       }\n`,
            "GF0001",
        );
        expect(diagnostic.message).toContain("no fields");
    });

    test("a literal's field order does not have to match the declaration's", async () => {
        // Layout comes from the *declaration*; the literal is just a set of
        // initialisers. Reading `b` back proves the store went to the right slot.
        const result = await run(
            "struct-literal-order",
            `interface S { b: i32; a: i32; }

       export function main(): i32 {
         const s: S = { a: 1, b: 2 };
         return s.b * 10 + s.a;
       }\n`,
        );
        expect(result.exitCode).toBe(21);
    });

    test("a nested field is mutable through the outer value", async () => {
        const result = await run(
            "struct-nested-mutate",
            `interface In { a: i32; }
       interface Out { i: In; b: i32; }

       export function main(): i32 {
         const o: Out = { i: { a: 1 }, b: 2 };
         o.i.a = 5;
         return o.i.a * 10 + o.b;
       }\n`,
        );
        expect(result.exitCode).toBe(52);
    });

    test("assigning a struct to itself is not a self-destruction", async () => {
        // The copy-assignment corner every value-semantics language has to answer:
        // release-then-copy on the same storage reads freed memory.
        const result = await run(
            "struct-self-assign",
            `interface S { s: string; }

       export function main(): i32 {
         let s: S = { s: "a" + "b" };
         s = s;
         console.log(s.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("assigning an owning field from itself is not a self-destruction", async () => {
        // The same corner one projection down. The destination is `s.s` rather
        // than `s`, so a check that only compared whole locals would miss it —
        // which is why the overlap test is by local and not by place.
        const result = await run(
            "struct-field-self-assign",
            `interface S { s: string; t: string; }

       export function main(): i32 {
         let s: S = { s: "a" + "b", t: "c" + "d" };
         s.s = s.s;
         s.t = s.s;
         console.log(\`\${s.s} \${s.t}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("ab ab\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("a field may be read straight off a returned temporary", async () => {
        const result = await run(
            "struct-temp-field",
            `interface S { a: i32; }
       function make(): S { return { a: 4 }; }

       export function main(): i32 {
         return make().a;
       }\n`,
        );
        expect(result.exitCode).toBe(4);
    });

    test("a `readonly` field is written by the literal and not afterwards", async () => {
        const result = await run(
            "struct-readonly",
            `interface S { readonly a: i32; }

       export function main(): i32 {
         const s: S = { a: 3 };
         return s.a;
       }\n`,
        );
        expect(result.exitCode).toBe(3);

        const {result: bad} = await compileSource(
            "struct-readonly-write",
            `interface S { readonly a: i32; }

       export function main(): i32 {
         const s: S = { a: 3 };
         s.a = 4;
         return s.a;
       }\n`,
        );
        expect(bad.ok).toBe(false);
        expect(errorCodes(bad).some((code) => code.startsWith("TS"))).toBe(true);
    });

    test("a `boolean` field sits beside an integer one", async () => {
        const result = await run(
            "struct-bool-field",
            `interface S { flag: boolean; n: i32; }

       export function main(): i32 {
         const s: S = { flag: true, n: 7 };
         if (s.flag) { return s.n; }
         return 0;
       }\n`,
        );
        expect(result.exitCode).toBe(7);
    });

    test("an interface may extend another, and the fields flatten", async () => {
        const result = await run(
            "struct-extends",
            `interface A { a: i32; }
       interface B extends A { b: i32; }

       export function main(): i32 {
         const v: B = { a: 1, b: 2 };
         return v.a * 10 + v.b;
       }\n`,
        );
        expect(result.exitCode).toBe(12);
    });

    test("copying a struct with an owning field copies the buffer too", async () => {
        const result = await run(
            "struct-owning-copy",
            `interface S { s: string; }

       export function main(): i32 {
         const a: S = { s: "x" + "y" };
         const b: S = a;
         console.log(a.s + b.s);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("xyxy\n");
        expect(result.leaked).toBe(0);
    });
});

/**
 * `struct Node { struct Node *next; }` — the shape every C linked list has.
 *
 * A cycle through a pointer is a *type* with no finite spelling as a tree, and
 * both halves of the compiler used to walk one until the stack ran out: the
 * eraser building a `MachineType`, and the lowerer interning a `TyId`. Neither
 * produced a diagnostic, because neither got as far as having one.
 */
describe("a type that points at itself", () => {
    test("a declaration that mentions one compiles", async () => {
        // The narrowest form of the original report: nothing builds a node, and
        // an `extern`'s signature is the whole of what drives the eraser in.
        const result = await run(
            "struct-cyclic-declared",
            `interface Node {
         value: i32;
         next: Pointer<Node> | null;
       }

       declare function c_head(): Pointer<Node> | null;

       export function main(): i32 {
         return 0;
       }\n`,
        );
        expect(result.exitCode).toBe(0);
    });

    test("a list is built, walked and released", async () => {
        const result = await run(
            "struct-cyclic-list",
            `interface Node {
         value: i32;
         next: Pointer<Node> | null;
       }

       export function main(): i32 {
         const head = alloc<Node>();
         const tail = alloc<Node>();
         head.value = 1;
         head.next = tail;
         tail.value = 2;
         tail.next = null;

         let total: i32 = 0;
         let at: Pointer<Node> | null = head;
         while (at !== null) {
           total = total + at.value;
           at = at.next;
         }
         // Two levels in one expression, which is what a truncated pointee
         // would have refused: the field's own type has to be the whole shape.
         console.log(\`\${total} \${head.next.value}\`);

         head.free();
         tail.free();
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("3 2\n");
        expect(result.leaked).toBe(0);
    });

    test("two types that point at each other", async () => {
        const result = await run(
            "struct-cyclic-mutual",
            `interface A { tag: i32; b: Pointer<B> | null; }
       interface B { tag: i32; a: Pointer<A> | null; }

       export function main(): i32 {
         const a = alloc<A>();
         const b = alloc<B>();
         a.tag = 1;
         a.b = b;
         b.tag = 2;
         b.a = a;
         const back = a.b.a;
         const round: i32 = back === null ? 0 : back.tag;
         a.free();
         b.free();
         return round * 10 + 1;
       }\n`,
        );
        expect(result.exitCode).toBe(11);
    });

    test("an owning field beside the pointer is still released", async () => {
        // The category of a struct is a function of its fields, and the id for a
        // recursive one is reserved *before* those fields exist — so a `Trivial`
        // computed in that window would leave the string unreleased, which the
        // live-allocation check catches whether or not anything else does.
        const result = await run(
            "struct-cyclic-owning",
            `interface Node { name: string; next: Pointer<Node> | null; }

       export function main(): i32 {
         const a: Node = { name: "x" + "y", next: null };
         const b: Node = a;
         console.log(\`\${a.name}\${b.name}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("xyxy\n");
        expect(result.leaked).toBe(0);
    });

    test("a value that contains itself is refused", async () => {
        const diagnostic = await expectRejected(
            "struct-cyclic-by-value",
            `interface Node { value: i32; self: Node; }

       declare function c_take(node: Node): i32;

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0307",
        );
        expect(diagnostic.message).toContain("Pointer<Node>");
    });

    test("a fixed array of itself is refused, being inline too", async () => {
        await expectRejected(
            "struct-cyclic-fixed",
            `interface Node { value: i32; kids: FixedArray<Node, 2>; }

       declare function c_take(node: Node): i32;

       export function main(): i32 {
         return 0;
       }\n`,
            "GF0307",
        );
    });

    test("an array of itself is a gap, and says so", async () => {
        // `T[]` owns a buffer elsewhere, so the *layout* is fine — one machine
        // word, the same reason C++ allows `std::vector<T>` in `T` and refuses
        // `T[4]`. What is missing is out-of-line copy and drop glue: the backend
        // writes both inline today, so the code for the drop would contain the
        // code for the drop. `GF0001`, because it is meant to work eventually.
        const diagnostic = await expectRejected(
            "struct-cyclic-array",
            `interface Node { value: i32; kids: Node[]; }

       export function main(): i32 {
         const leaf: Node = { value: 2, kids: [] };
         const root: Node = { value: 1, kids: [leaf] };
         return root.value * 10 + root.kids[0].value;
       }\n`,
            "GF0001",
        );
        expect(diagnostic.message).toContain("no end to it");
    });

    test("an array of pointers to itself is not that gap", async () => {
        // One indirection more, and it is the one that matters: releasing the
        // buffer releases pointers, which own nothing, so nothing recurses.
        const result = await run(
            "struct-cyclic-array-of-pointers",
            `interface Node { value: i32; kids: (Pointer<Node> | null)[]; }

       export function main(): i32 {
         const leaf = alloc<Node>();
         leaf.value = 2;
         leaf.kids = [];
         const root: Node = { value: 1, kids: [leaf] };
         const first = root.kids[0];
         const seen: i32 = first === null ? 0 : first.value;
         leaf.free();
         return root.value * 10 + seen;
       }\n`,
        );
        expect(result.exitCode).toBe(12);
        expect(result.leaked).toBe(0);
    });

    /**
     * A struct is its **name and its layout**, and neither half alone.
     *
     * Interning by the name alone was a silent miscompile: the second `Pair`
     * found the first's `TyId` and took its layout, with nothing ill-formed
     * anywhere and so nothing reported. Interning by the layout alone would
     * merge a `Point` with a `Vec2` that happens to have the same fields, and
     * the generated header would then declare one of the two names.
     *
     * The last test here is the one that keeps the fix from over-shooting: two
     * files declaring the *same* struct still declare one struct, and a value
     * passes between them. See `layoutKey` in `packages/checker/src/types.ts`.
     */
    describe("a struct is its name and its layout", () => {
        test("across two files, with different widths", async () => {
            const result = await run(
                "struct-same-name-two-files",
                `import { unsigned } from "./other.ts";

       interface Pair { a: i32; b: i32; }

       export function main(): i32 {
         const signed: Pair = { a: -1, b: 0 };
         console.log(signed.a < signed.b ? "signed: less" : "signed: not less");
         console.log(unsigned());
         return 0;
       }\n`,
                {
                    files: {
                        "other.ts": `interface Pair { a: u32; b: u32; }

       export function unsigned(): string {
         const p: Pair = { a: 4294967295, b: 0 };
         return p.a < p.b ? "unsigned: less" : "unsigned: not less";
       }\n`,
                    },
                },
            );
            // `-1 < 0` is true; `4294967295 < 0` is false. The two fields hold
            // the same 32 bits, so only the type decides — which makes this the
            // sharpest available check that the layouts did not merge.
            expect(result.stdout).toBe("signed: less\nunsigned: not less\n");
        });

        test("across two files, with the same field names in the other order", async () => {
            // Field *order* is layout, which the interning comment has always
            // said — so two same-named shapes that put an `f64` and an `i32` in
            // opposite slots are two structs. Merging them puts a float in an
            // integer's slot, which is loud rather than wrong; the point is that
            // the frontend never lets it get that far.
            const result = await run(
                "struct-same-name-reordered",
                `import { fromOther } from "./other.ts";

       interface Boxed { a: i32; b: f64; }

       export function main(): i32 {
         const here: Boxed = { a: 1, b: 2.5 };
         console.log(\`here \${here.a} \${here.b}\`);
         console.log(fromOther());
         return 0;
       }\n`,
                {
                    files: {
                        "other.ts": `interface Boxed { a: f64; b: i32; }

       export function fromOther(): string {
         const there: Boxed = { a: 3.5, b: 4 };
         return \`there \${there.a} \${there.b}\`;
       }\n`,
                    },
                },
            );
            expect(result.stdout).toBe("here 1 2.5\nthere 3.5 4\n");
        });

        test("one class, two same-named contracts, two itables", async () => {
            // The interface half of the rule, and the shape that makes it
            // observable: the *same* class converted to two different contracts
            // that happen to share a name. The itab is built per (class,
            // contract), so keying that on the name gives the second conversion
            // the first one's slots — and `shout` sorts before `speak`, so the
            // two disagree about which slot `speak` is in.
            const result = await run(
                "interface-same-name-two-contracts",
                `import { Cat, loudly } from "./other.ts";

       interface Speaker { speak(): i32; }

       export function main(): i32 {
         const cat = new Cat();
         const quietly: Reference<Speaker> = cat;
         return loudly() * 10 + quietly.speak();
       }\n`,
                {
                    files: {
                        "other.ts": `export interface Speaker { shout(): i32; speak(): i32; }

       export class Cat implements Speaker {
         shout(): i32 { return 9; }
         speak(): i32 { return 2; }
       }

       export function loudly(): i32 {
         const cat = new Cat();
         const both: Reference<Speaker> = cat;
         return both.shout();
       }\n`,
                    },
                },
            );
            expect(result.exitCode).toBe(92);
        });

        test("two files declaring the *same* struct declare one struct", async () => {
            // The other direction, and the one the first attempt at this fix
            // got wrong: keying a struct by where it was declared made these
            // two different types, and passing one to the other came back as
            // "this is a `Point`, which does not convert to `Point`".
            const result = await run(
                "struct-same-name-identical",
                `import { lengthSquared } from "./other.ts";

       interface Point { x: i32; y: i32; }

       export function main(): i32 {
         const p: Point = { x: 3, y: 4 };
         return lengthSquared(p);
       }\n`,
                {
                    files: {
                        "other.ts": `interface Point { x: i32; y: i32; }

       export function lengthSquared(p: Point): i32 {
         return p.x * p.x + p.y * p.y;
       }\n`,
                    },
                },
            );
            expect(result.exitCode).toBe(25);
        });
    });
});
