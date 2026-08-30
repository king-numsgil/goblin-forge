/**
 * `std/collection`, and the two intrinsics that make a key.
 *
 * Three things are being tested here and they are worth telling apart.
 *
 * **`hashOf` and `equalsOf`** are *language* surface — global intrinsics that
 * resolve from a type, usable with no container in sight. They are here rather
 * than beside the other intrinsics because the reason they exist is the
 * container, and the rules that matter (a float is not a key; a class says how)
 * only bite through one.
 *
 * **`std/collection` is the first std module that is real Goblin source.** So
 * these tests are also the test of that mechanism: the `paths` entry that
 * resolves the specifier, the module reaching the lowerer as ordinary source, a
 * generic class crossing from it into a consumer's compilation, and the symbol
 * tag that keeps two checkouts producing the same names.
 *
 * **The containers themselves.** Every `run` test here carries the harness's
 * automatic live-allocation check, which is the load-bearing assertion for a
 * container: a map that loses a key, frees one twice, or leaks its slot table
 * fails without anybody writing an assertion about memory. Where a test holds
 * `string` keys or values, that check is most of the point of the test.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

/** Every program here imports from the module under test. */
function withImport(names: string, body: string): string {
    return `import { ${names} } from "std/collection";\n\n${body}`;
}

describe("hashOf", () => {
    test("equal values hash equally, at every width", async () => {
        const result = await run(
            "hash-widths",
            `export function main(): i32 {
         console.log(\`\${hashOf<i8>(-3) === hashOf<i8>(-3)}\`);
         console.log(\`\${hashOf<u8>(250) === hashOf<u8>(250)}\`);
         console.log(\`\${hashOf<i16>(-300) === hashOf<i16>(-300)}\`);
         console.log(\`\${hashOf<u32>(70000) === hashOf<u32>(70000)}\`);
         console.log(\`\${hashOf<i64>(-1) === hashOf<i64>(-1)}\`);
         console.log(\`\${hashOf<u64>(18446744073709551615) === hashOf<u64>(18446744073709551615)}\`);
         console.log(\`\${hashOf<usize>(9) === hashOf<usize>(9)}\`);
         console.log(\`\${hashOf<isize>(-9) === hashOf<isize>(-9)}\`);
         console.log(\`\${hashOf<boolean>(true) === hashOf<boolean>(true)}\`);
         console.log(\`\${hashOf<boolean>(true) === hashOf<boolean>(false)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe(`${"true\n".repeat(9)}false\n`);
    });

    test("consecutive integers do not land in consecutive buckets", async () => {
        // The property a table depends on and an identity hash does not have.
        // Masking to 16 buckets, an unmixed hash puts key `i` in bucket `i` every
        // time; a mixer puts almost none of them there.
        const result = await run(
            "hash-avalanche",
            `export function main(): i32 {
         let identity: i32 = 0;
         for (let i: u64 = 0; i < 256; i = i + 1) {
           if ((hashOf<u64>(i) & 255) === i) { identity = identity + 1; }
         }
         console.log(\`\${identity}\`);
         return 0;
       }\n`,
        );
        expect(Number(result.stdout.trim())).toBeLessThan(8);
    });

    test("a string hashes by its bytes, not by its buffer", async () => {
        // Two different allocations with the same contents. Hashing the pointer
        // would pass every other test in this file and fail this one.
        const result = await run(
            "hash-string",
            `export function main(): i32 {
         const built = "go" + "blin";
         console.log(\`\${hashOf<string>("goblin") === hashOf<string>(built)}\`);
         console.log(\`\${hashOf<string>("goblin") === hashOf<string>("goblins")}\`);
         console.log(\`\${hashOf<string>("ab") === hashOf<string>("ba")}\`);
         console.log(\`\${hashOf<string>("") === hashOf<string>("")}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true\nfalse\nfalse\ntrue\n");
    });

    test("the hash is the same number on every platform and every run", async () => {
        // A golden value. It pins the algorithm — FNV-1a over the bytes, then
        // SplitMix64's finalizer — so that changing it is a deliberate act, and
        // it catches the platform divergence that a `usize`-width accumulator or
        // a signed shift would introduce. Iteration order is a function of this,
        // and this suite asserts on iteration order.
        const result = await run(
            "hash-golden",
            `export function main(): i32 {
         console.log(\`\${hashOf<string>("goblin")}\`);
         console.log(\`\${hashOf<u64>(0)}\`);
         console.log(\`\${hashOf<u64>(1)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toMatchSnapshot();
    });

    test("a struct hashes field by field, and the order matters", async () => {
        const result = await run(
            "hash-struct",
            `interface Cell { x: i32; y: i32 }
       interface Deep { cell: Cell; name: string; live: boolean }

       export function main(): i32 {
         const a: Cell = {x: 1, y: 2};
         const b: Cell = {x: 1, y: 2};
         const swapped: Cell = {x: 2, y: 1};
         console.log(\`\${hashOf<Cell>(a) === hashOf<Cell>(b)}\`);
         console.log(\`\${hashOf<Cell>(a) === hashOf<Cell>(swapped)}\`);

         const p: Deep = {cell: a, name: "one", live: true};
         const q: Deep = {cell: b, name: "one", live: true};
         const r: Deep = {cell: b, name: "one", live: false};
         console.log(\`\${hashOf<Deep>(p) === hashOf<Deep>(q)}\`);
         console.log(\`\${hashOf<Deep>(p) === hashOf<Deep>(r)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true\nfalse\ntrue\nfalse\n");
    });

    test("a fixed array hashes element by element", async () => {
        const result = await run(
            "hash-fixed-array",
            `export function main(): i32 {
         const a: FixedArray<i32, 3> = fixedArray(3, 7);
         const b: FixedArray<i32, 3> = fixedArray(3, 7);
         const c: FixedArray<i32, 3> = fixedArray(3, 7);
         c[1] = 8;
         console.log(\`\${hashOf(a) === hashOf(b)} \${hashOf(a) === hashOf(c)}\`);
         console.log(\`\${equalsOf(a, b)} \${equalsOf(a, c)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true false\ntrue false\n");
    });

    test("an enum hashes as its underlying integer", async () => {
        const result = await run(
            "hash-enum",
            `enum Phase { Idle, Burning, Coasting }

       export function main(): i32 {
         console.log(\`\${hashOf<Phase>(Phase.Idle) === hashOf<Phase>(Phase.Idle)}\`);
         console.log(\`\${hashOf<Phase>(Phase.Idle) === hashOf<Phase>(Phase.Coasting)}\`);
         console.log(\`\${equalsOf<Phase>(Phase.Burning, Phase.Burning)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true\nfalse\ntrue\n");
    });

    test("a pointer hashes as its address", async () => {
        const result = await run(
            "hash-pointer",
            `export function main(): i32 {
         const a = alloc<i32>();
         const b = alloc<i32>();
         console.log(\`\${hashOf(a) === hashOf(a)} \${hashOf(a) === hashOf(b)}\`);
         console.log(\`\${equalsOf(a, a)} \${equalsOf(a, b)}\`);
         a.free();
         b.free();
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true false\ntrue false\n");
    });

    test("the type argument may be left out when the argument says it", async () => {
        const result = await run(
            "hash-inferred",
            `interface Cell { x: i32; y: i32 }

       export function main(): i32 {
         const c: Cell = {x: 4, y: 5};
         const n: u32 = 11;
         console.log(\`\${hashOf(c) === hashOf<Cell>(c)}\`);
         console.log(\`\${hashOf(n) === hashOf<u32>(11)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true\ntrue\n");
    });

    test("both work under a substitution, on a type parameter", async () => {
        // The case that matters, because it is the only one the containers use:
        // `hashOf<K>(key)` inside a generic, resolved at the instantiation.
        const result = await run(
            "hash-generic",
            `interface Cell { x: i32; y: i32 }

       function bucket<K>(key: K, count: u64): u64 { return hashOf<K>(key) % count; }
       function same<K>(a: K, b: K): boolean { return equalsOf<K>(a, b); }

       export function main(): i32 {
         console.log(\`\${bucket<i32>(7, 16) < 16}\`);
         console.log(\`\${bucket<string>("sol", 16) < 16}\`);
         console.log(\`\${bucket<Cell>({x: 1, y: 2}, 16) < 16}\`);
         console.log(\`\${same<string>("a", "a")} \${same<string>("a", "b")}\`);
         console.log(\`\${same<Cell>({x: 1, y: 2}, {x: 1, y: 2})}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true\ntrue\ntrue\ntrue false\ntrue\n");
    });
});

describe("a class answers for itself", () => {
    test("`hash` and `equals` are what get called", async () => {
        // The extension point. `hash` here is deliberately *not* what a
        // structural hash would produce — it ignores a field — so a compiler
        // that fell back to walking the fields would disagree with it.
        const result = await run(
            "hash-class-hook",
            `class Body {
         id: u32;
         name: string;
         constructor(id: u32, name: string) { this.id = id; this.name = name; }
         hash(): u64 { return hashOf<u32>(this.id); }
         equals(other: Reference<Body>): boolean { return this.id === other.id; }
       }

       export function main(): i32 {
         const a = new Body(1, "earth");
         const b = new Body(1, "terra");
         const c = new Body(2, "mars");
         console.log(\`\${hashOf<Body>(a) === hashOf<Body>(b)}\`);
         console.log(\`\${hashOf<Body>(a) === hashOf<Body>(c)}\`);
         console.log(\`\${equalsOf<Body>(a, b)} \${equalsOf<Body>(a, c)}\`);
         console.log(\`\${hashOf<Body>(a) === hashOf<u32>(1)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true\nfalse\ntrue false\ntrue\n");
    });

    test("an override is reached through a reference, and a copy still slices", async () => {
        // Both halves matter. Through a `Reference<Base>` the dynamic type
        // survives and the override answers, because the call goes through the
        // vtable slot like every other method call. Copying a `Derived` *into* a
        // `Base` slices it, as it does in C++ — so the base's answer there is the
        // language working, not the dispatch failing, and asserting it keeps the
        // first half from being read as proof of something it is not.
        const result = await run(
            "hash-class-override",
            `class Base {
         tag: i32;
         constructor(tag: i32) { this.tag = tag; }
         hash(): u64 { return 1; }
         equals(other: Reference<Base>): boolean { return false; }
       }

       class Derived extends Base {
         constructor(tag: i32) { super(tag); }
         override hash(): u64 { return hashOf<i32>(this.tag); }
         override equals(other: Reference<Base>): boolean { return this.tag === other.tag; }
       }

       function hashThrough(b: Reference<Base>): u64 { return hashOf(b); }
       function equalThrough(a: Reference<Base>, b: Reference<Base>): boolean {
         return equalsOf(a, b);
       }

       export function main(): i32 {
         const d = new Derived(5);
         const e = new Derived(5);
         console.log(\`\${hashThrough(d) === hashOf<i32>(5)}\`);
         console.log(\`\${equalThrough(d, e)}\`);

         const sliced: Base = d;
         console.log(\`\${hashOf<Base>(sliced) === hashOf<i32>(5)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true\ntrue\nfalse\n");
    });

    test("a reference hashes as what it borrows, not as an address", async () => {
        // A `Reference<T>` is one machine word, so hashing the reference itself
        // gives a plausible number that is simply not the value's — and a
        // borrowed key would then never find the entry an owned one inserted.
        const result = await run(
            "hash-reference",
            `interface Cell { x: i32; y: i32 }

       function borrowed(c: Reference<Cell>): u64 { return hashOf(c); }
       function same(a: Reference<Cell>, b: Reference<Cell>): boolean { return equalsOf(a, b); }

       export function main(): i32 {
         const a: Cell = {x: 1, y: 2};
         const b: Cell = {x: 1, y: 2};
         console.log(\`\${borrowed(a) === hashOf<Cell>(a)}\`);
         console.log(\`\${borrowed(a) === borrowed(b)}\`);
         console.log(\`\${same(a, b)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true\ntrue\ntrue\n");
    });

    test("a class with no `hash` is refused, and says what to write", async () => {
        const diagnostic = await expectRejected(
            "hash-class-missing",
            `class Plain { x: i32; constructor(x: i32) { this.x = x; } }

       export function main(): i32 {
         return cast<i32>(hashOf<Plain>(new Plain(1)));
       }\n`,
            "GF0405",
        );
        expect(diagnostic.message).toContain("hash(): u64");
        expect(diagnostic.message).toContain("equals(other: Reference<Plain>)");
    });

    test("a class with `hash` and no `equals` is refused at the second question", async () => {
        // The shape a half-finished key has, and the reason `GF0405`'s text
        // names both methods rather than only the one that was asked for.
        await expectRejected(
            "hash-class-half",
            `class Half {
         x: i32;
         constructor(x: i32) { this.x = x; }
         hash(): u64 { return hashOf<i32>(this.x); }
       }

       export function main(): i32 {
         return equalsOf<Half>(new Half(1), new Half(1)) ? 1 : 0;
       }\n`,
            "GF0406",
        );
    });

    test("a `hash` that does not return `u64` is refused", async () => {
        await expectRejected(
            "hash-class-wrong-return",
            `class Wrong {
         x: i32;
         constructor(x: i32) { this.x = x; }
         hash(): i32 { return this.x; }
         equals(other: Reference<Wrong>): boolean { return this.x === other.x; }
       }

       export function main(): i32 {
         return cast<i32>(hashOf<Wrong>(new Wrong(1)));
       }\n`,
            "GF0405",
        );
    });
});

describe("what cannot be a key", () => {
    test("a float, because equal values have different bits", async () => {
        for (const width of ["f32", "f64"]) {
            const diagnostic = await expectRejected(
                `hash-float-${width}`,
                `export function main(): i32 {
         const x: ${width} = 1.5;
         return cast<i32>(hashOf<${width}>(x));
       }\n`,
                "GF0407",
            );
            expect(diagnostic.message).toContain("NaN");
        }
    });

    test("a struct containing a float, for the same reason one level down", async () => {
        await expectRejected(
            "hash-float-struct",
            `interface Point { x: f64; y: f64 }

       export function main(): i32 {
         const p: Point = {x: 1.0, y: 2.0};
         return cast<i32>(hashOf<Point>(p));
       }\n`,
            "GF0407",
        );
    });

    test("`equalsOf` accepts a float, because `===` does", async () => {
        // The asymmetry is deliberate: comparing two floats is well defined, and
        // it is only the *pairing* with a hash that is not.
        const result = await run(
            "equals-float",
            `export function main(): i32 {
         const a: f64 = 1.5;
         const b: f64 = 1.5;
         console.log(\`\${equalsOf<f64>(a, b)} \${equalsOf<f64>(a, 2.5)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true false\n");
    });

    test("a `T[]`, which would need a loop over a run-time length", async () => {
        const diagnostic = await expectRejected(
            "hash-array",
            `export function main(): i32 {
         const xs: i32[] = [1, 2, 3];
         return cast<i32>(hashOf(xs));
       }\n`,
            "GF0405",
        );
        expect(diagnostic.message).toContain("run time");
    });
});

describe("HashMap", () => {
    test("set, get, has, size", async () => {
        const result = await run(
            "map-basics",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<string, i32>();
         console.log(\`\${m.size} \${m.has("a")}\`);
         m.set("a", 1);
         m.set("b", 2);
         console.log(\`\${m.size} \${m.has("a")} \${m.has("z")}\`);
         console.log(\`\${m.getOr("a", -1)} \${m.getOr("b", -1)} \${m.getOr("z", -1)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0 false\n2 true false\n1 2 -1\n");
    });

    test("setting an existing key overwrites the value and keeps the first key", async () => {
        // `std::unordered_map::operator[]`'s rule. It matters when two equal keys
        // are distinguishable in a way the equality does not look at — which is
        // exactly what the class hook above makes possible.
        const result = await run(
            "map-overwrite",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<string, i32>();
         m.set("k", 1);
         m.set("k", 2);
         m.set("k", 3);
         console.log(\`\${m.size} \${m.getOr("k", 0)} \${m.keyAt(0)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("1 3 k\n");
    });

    test("indexOf answers -1 rather than a value that could be real", async () => {
        const result = await run(
            "map-index-of",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<i32, i32>();
         m.set(10, 0);
         const there = m.indexOf(10);
         const absent = m.indexOf(11);
         console.log(\`\${there} \${absent}\`);
         // The value really is zero, which is why the fallback cannot answer this.
         console.log(\`\${m.valueAt(cast<usize>(there))} \${m.getOr(11, 0)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0 -1\n0 0\n");
    });

    test("setAt updates in place without a second probe", async () => {
        const result = await run(
            "map-set-at",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const counts = new HashMap<string, i32>();
         const words: string[] = ["a", "b", "a", "c", "a", "b"];
         for (let i: usize = 0; i < words.length; i = i + 1) {
           const at = counts.indexOf(words[i]);
           if (at < 0) {
             counts.set(words[i], 1);
           } else {
             const j = cast<usize>(at);
             counts.setAt(j, counts.valueAt(j) + 1);
           }
         }
         console.log(\`\${counts.getOr("a", 0)} \${counts.getOr("b", 0)} \${counts.getOr("c", 0)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("3 2 1\n");
    });

    test("five thousand entries survive every rehash on the way", async () => {
        // The growth path, walked about nine times. Every key is checked back,
        // which is what catches a rehash that drops or duplicates one.
        const result = await run(
            "map-rehash",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<i64, i64>();
         for (let i: i64 = 0; i < 5000; i = i + 1) { m.set(i, i * 7); }
         console.log(\`\${m.size}\`);
         let wrong: i32 = 0;
         for (let i: i64 = 0; i < 5000; i = i + 1) {
           if (m.getOr(i, -1) !== i * 7) { wrong = wrong + 1; }
         }
         console.log(\`wrong \${wrong}\`);
         console.log(\`absent \${m.has(5000)} \${m.has(-1)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("5000\nwrong 0\nabsent false false\n");
    });

    test("keys that all hash to one bucket still work", async () => {
        // Every probe chain is the whole table. It is the worst case for a linear
        // probe and the one where an off-by-one in the wrap, or a bound that is
        // one too small, stops being invisible.
        const result = await run(
            "map-collisions",
            withImport(
                "HashMap",
                `class Same {
         id: i32;
         constructor(id: i32) { this.id = id; }
         hash(): u64 { return 1; }
         equals(other: Reference<Same>): boolean { return this.id === other.id; }
       }

       export function main(): i32 {
         const m = new HashMap<Same, i32>();
         for (let i: i32 = 0; i < 200; i = i + 1) { m.set(new Same(i), i * 2); }
         console.log(\`\${m.size}\`);
         let wrong: i32 = 0;
         for (let i: i32 = 0; i < 200; i = i + 1) {
           if (m.getOr(new Same(i), -1) !== i * 2) { wrong = wrong + 1; }
         }
         console.log(\`wrong \${wrong} absent \${m.has(new Same(200))}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("200\nwrong 0 absent false\n");
    });

    test("remove takes the key out and leaves the rest findable", async () => {
        const result = await run(
            "map-remove",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<i32, i32>();
         for (let i: i32 = 0; i < 500; i = i + 1) { m.set(i, i); }
         for (let i: i32 = 0; i < 500; i = i + 2) { m.remove(i); }
         console.log(\`\${m.size}\`);

         let wrong: i32 = 0;
         for (let i: i32 = 0; i < 500; i = i + 1) {
           const present = m.has(i);
           if (present !== (i % 2 === 1)) { wrong = wrong + 1; }
           if (present && m.getOr(i, -1) !== i) { wrong = wrong + 1; }
         }
         console.log(\`wrong \${wrong}\`);
         console.log(\`again \${m.remove(1)} \${m.remove(1)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("250\nwrong 0\nagain true false\n");
    });

    test("removing and reinserting the same keys does not grow the table forever", async () => {
        // Tombstones are reused rather than accumulating, which is what stops a
        // map used as a working set from rehashing on every insert. The size
        // settling back is the assertion; the leak check is the other half.
        const result = await run(
            "map-churn",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<i32, string>();
         for (let round: i32 = 0; round < 50; round = round + 1) {
           for (let i: i32 = 0; i < 40; i = i + 1) { m.set(i, \`v\${i}\`); }
           for (let i: i32 = 0; i < 40; i = i + 1) { m.remove(i); }
         }
         console.log(\`\${m.size}\`);
         m.set(1, "back");
         console.log(\`\${m.size} \${m.getOr(1, "none")}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0\n1 back\n");
        expect(result.leaked).toBe(0);
    });

    test("iteration is insertion order until the first remove", async () => {
        const result = await run(
            "map-order",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<string, i32>();
         m.set("first", 1);
         m.set("second", 2);
         m.set("third", 3);
         let out = "";
         for (let i: usize = 0; i < m.size; i = i + 1) {
           out = out + \`\${m.keyAt(i)}=\${m.valueAt(i)} \`;
         }
         console.log(out);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("first=1 second=2 third=3 \n");
    });

    test("removing swaps the last entry into the hole, and it stays findable", async () => {
        // The documented reorder, asserted rather than left as prose — and the
        // part that would silently break is the moved entry's slot, so the test
        // looks the moved key up again afterwards.
        const result = await run(
            "map-swap-remove",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<string, i32>();
         m.set("a", 1);
         m.set("b", 2);
         m.set("c", 3);
         m.remove("a");
         console.log(\`\${m.size} \${m.keyAt(0)} \${m.valueAt(0)}\`);
         console.log(\`\${m.getOr("c", 0)} \${m.getOr("b", 0)} \${m.has("a")}\`);
         return 0;
       }\n`,
            ),
        );
        // "c" was last, so it lands where "a" was.
        expect(result.stdout).toBe("2 c 3\n3 2 false\n");
    });

    test("clear empties it and it is usable again", async () => {
        const result = await run(
            "map-clear",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<string, string>();
         for (let i: i32 = 0; i < 100; i = i + 1) { m.set(\`k\${i}\`, \`v\${i}\`); }
         m.clear();
         console.log(\`\${m.size} \${m.has("k1")}\`);
         m.set("after", "yes");
         console.log(\`\${m.size} \${m.getOr("after", "no")}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0 false\n1 yes\n");
        expect(result.leaked).toBe(0);
    });

    test("reserve makes room without inserting", async () => {
        const result = await run(
            "map-reserve",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<i32, i32>();
         m.reserve(1000);
         console.log(\`\${m.size}\`);
         for (let i: i32 = 0; i < 700; i = i + 1) { m.set(i, i); }
         console.log(\`\${m.size} \${m.getOr(699, -1)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0\n700 699\n");
    });

    test("forEach sees every entry, and can write through a capture", async () => {
        const result = await run(
            "map-foreach",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<i32, i32>();
         for (let i: i32 = 1; i <= 10; i = i + 1) { m.set(i, i * i); }
         let keys: i32 = 0;
         let values: i32 = 0;
         m.forEach((k, v) => { keys = keys + k; values = values + v; });
         console.log(\`\${keys} \${values}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("55 385\n");
    });

    test("a map is a value: copying one gives a second table", async () => {
        const result = await run(
            "map-value-semantics",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const a = new HashMap<string, i32>();
         a.set("x", 1);
         const b = a;
         b.set("x", 2);
         b.set("y", 3);
         console.log(\`\${a.getOr("x", 0)} \${a.size}\`);
         console.log(\`\${b.getOr("x", 0)} \${b.size}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("1 1\n2 2\n");
        expect(result.leaked).toBe(0);
    });

    test("a map passed by value is the callee's copy; by reference it is not", async () => {
        const result = await run(
            "map-parameters",
            withImport(
                "HashMap",
                `function byValue(m: HashMap<string, i32>): void { m.set("added", 1); }
       function byReference(m: Reference<HashMap<string, i32>>): void { m.set("added", 1); }

       export function main(): i32 {
         const a = new HashMap<string, i32>();
         byValue(a);
         console.log(\`\${a.size}\`);
         byReference(a);
         console.log(\`\${a.size} \${a.has("added")}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0\n1 true\n");
        expect(result.leaked).toBe(0);
    });

    test("owning keys and owning values are released exactly once", async () => {
        // The whole reason `std/collection` is source rather than an ambient
        // declaration: the destructor the compiler generates for this class has
        // to reach every string in both arrays. The automatic leak check is the
        // assertion, and it is not written down anywhere in the program.
        const result = await run(
            "map-owning",
            withImport(
                "HashMap",
                `function build(): HashMap<string, string> {
         const m = new HashMap<string, string>();
         for (let i: i32 = 0; i < 300; i = i + 1) { m.set(\`key \${i}\`, \`value \${i}\`); }
         return m;
       }

       export function main(): i32 {
         const m = build();
         console.log(\`\${m.size} \${m.getOr("key 299", "none")}\`);
         const copy = m;
         console.log(\`\${copy.getOr("key 0", "none")}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("300 value 299\nvalue 0\n");
        expect(result.leaked).toBe(0);
    });

    test("a value that owns a buffer of its own", async () => {
        const result = await run(
            "map-array-values",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<i32, string[]>();
         for (let i: i32 = 0; i < 20; i = i + 1) {
           const xs: string[] = [];
           xs.push(\`a\${i}\`);
           xs.push(\`b\${i}\`);
           m.set(i, xs);
         }
         const got = m.getOr(7, []);
         console.log(\`\${m.size} \${got.length} \${got[0]} \${got[1]}\`);
         m.remove(7);
         console.log(\`\${m.size}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("20 2 a7 b7\n19\n");
        expect(result.leaked).toBe(0);
    });

    test("a struct key, which is what a spatial index wants", async () => {
        const result = await run(
            "map-struct-keys",
            withImport(
                "HashMap",
                `interface Cell { x: i64; y: i64; z: i64 }

       export function main(): i32 {
         const grid = new HashMap<Cell, i32>();
         for (let x: i64 = 0; x < 20; x = x + 1) {
           for (let y: i64 = 0; y < 20; y = y + 1) {
             grid.set({x: x, y: y, z: 0}, cast<i32>(x * 100 + y));
           }
         }
         console.log(\`\${grid.size}\`);
         console.log(\`\${grid.getOr({x: 3, y: 4, z: 0}, -1)}\`);
         console.log(\`\${grid.getOr({x: 3, y: 4, z: 1}, -1)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("400\n304\n-1\n");
    });

    test("a small key domain, where nearly everything collides", async () => {
        const result = await run(
            "map-u8-keys",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<u8, u8>();
         for (let i: u8 = 0; i < 255; i = i + 1) { m.set(i, cast<u8>(255 - cast<u32>(i))); }
         console.log(\`\${m.size} \${m.getOr(0, 0)} \${m.getOr(254, 0)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("255 255 1\n");
    });

    test("a map as a field of a class", async () => {
        const result = await run(
            "map-as-field",
            withImport(
                "HashMap",
                `class Registry {
         private byName: HashMap<string, i32> = new HashMap<string, i32>();

         put(name: string, id: i32): void { this.byName.set(name, id); }
         find(name: string): i32 { return this.byName.getOr(name, -1); }
         get size(): usize { return this.byName.size; }
       }

       export function main(): i32 {
         const r = new Registry();
         r.put("earth", 3);
         r.put("mars", 4);
         console.log(\`\${r.size} \${r.find("mars")} \${r.find("pluto")}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("2 4 -1\n");
        expect(result.leaked).toBe(0);
    });

    test("a map crossing a module boundary", async () => {
        // The generic instantiated in one module and used in another, which is
        // the arrangement `std/collection` itself relies on.
        const result = await run(
            "map-cross-module",
            `import { tally } from "./counter.ts";

       export function main(): i32 {
         console.log(\`\${tally()}\`);
         return 0;
       }\n`,
            {
                files: {
                    "counter.ts": withImport(
                        "HashMap",
                        `export function tally(): i32 {
         const m = new HashMap<string, i32>();
         m.set("a", 2);
         m.set("b", 5);
         return m.getOr("a", 0) + m.getOr("b", 0);
       }\n`,
                    ),
                },
            },
        );
        expect(result.stdout).toBe("7\n");
    });

    test("an empty map allocates nothing", async () => {
        // Both arrays are empty `T[]`, which hold no buffer — the same property
        // an empty `std::vector` has, and the reason a map that is declared and
        // never used costs nothing.
        const result = await run(
            "map-empty",
            withImport(
                "HashMap",
                `export function main(): i32 {
         const m = new HashMap<string, string>();
         console.log(\`\${m.size} \${m.has("anything")} \${m.indexOf("anything")}\`);
         console.log(\`\${m.remove("anything")} \${m.getOr("anything", "fallback")}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0 false -1\nfalse fallback\n");
        expect(result.leaked).toBe(0);
    });
});

describe("HashSet", () => {
    test("add says whether it was new", async () => {
        const result = await run(
            "set-add",
            withImport(
                "HashSet",
                `export function main(): i32 {
         const s = new HashSet<u64>();
         console.log(\`\${s.add(7)} \${s.add(7)} \${s.add(8)} \${s.size}\`);
         console.log(\`\${s.has(7)} \${s.has(9)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("true false true 2\ntrue false\n");
    });

    test("remove, at, clear and reserve", async () => {
        const result = await run(
            "set-surface",
            withImport(
                "HashSet",
                `export function main(): i32 {
         const s = new HashSet<i32>();
         s.reserve(64);
         for (let i: i32 = 0; i < 10; i = i + 1) { s.add(i); }
         console.log(\`\${s.size} \${s.at(0)} \${s.at(9)}\`);
         console.log(\`\${s.remove(0)} \${s.remove(0)} \${s.size}\`);
         s.clear();
         console.log(\`\${s.size} \${s.has(5)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("10 0 9\ntrue false 9\n0 false\n");
    });

    test("deduplicating a list, which is what a set is for", async () => {
        const result = await run(
            "set-dedupe",
            withImport(
                "HashSet",
                `export function main(): i32 {
         const words: string[] = ["b", "a", "b", "c", "a", "a"];
         const seen = new HashSet<string>();
         let unique = "";
         for (let i: usize = 0; i < words.length; i = i + 1) {
           if (seen.add(words[i])) { unique = unique + words[i]; }
         }
         console.log(\`\${unique} \${seen.size}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("bac 3\n");
        expect(result.leaked).toBe(0);
    });

    test("forEach, with a capture written through", async () => {
        const result = await run(
            "set-foreach",
            withImport(
                "HashSet",
                `export function main(): i32 {
         const s = new HashSet<i32>();
         for (let i: i32 = 1; i <= 5; i = i + 1) { s.add(i); }
         let total: i32 = 0;
         s.forEach((v) => { total = total + v; });
         console.log(\`\${total}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("15\n");
    });

    test("owning members are released once", async () => {
        const result = await run(
            "set-owning",
            withImport(
                "HashSet",
                `export function main(): i32 {
         const s = new HashSet<string>();
         for (let i: i32 = 0; i < 400; i = i + 1) { s.add(\`member \${i}\`); }
         for (let i: i32 = 0; i < 400; i = i + 3) { s.remove(\`member \${i}\`); }
         console.log(\`\${s.size} \${s.has("member 1")} \${s.has("member 0")}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("266 true false\n");
        expect(result.leaked).toBe(0);
    });
});

describe("BinaryHeap", () => {
    test("a min-heap hands back the smallest, in order", async () => {
        const result = await run(
            "heap-min",
            withImport(
                "BinaryHeap",
                `function ascending(a: i32, b: i32): boolean { return a < b; }

       export function main(): i32 {
         const h = new BinaryHeap<i32>(ascending);
         const values: i32[] = [5, 3, 9, 1, 7, 3, 8, 2];
         for (let i: usize = 0; i < values.length; i = i + 1) { h.push(values[i]); }
         let out = "";
         while (h.size !== 0) { out = out + \`\${h.pop()} \`; }
         console.log(out);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("1 2 3 3 5 7 8 9 \n");
    });

    test("the comparison is the whole of the order, so reversing it is a max-heap", async () => {
        const result = await run(
            "heap-max",
            withImport(
                "BinaryHeap",
                `function descending(a: i32, b: i32): boolean { return a > b; }

       export function main(): i32 {
         const h = new BinaryHeap<i32>(descending);
         const values: i32[] = [5, 3, 9, 1, 7];
         for (let i: usize = 0; i < values.length; i = i + 1) { h.push(values[i]); }
         let out = "";
         while (h.size !== 0) { out = out + \`\${h.pop()} \`; }
         console.log(out);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("9 7 5 3 1 \n");
    });

    test("a thousand values come out sorted", async () => {
        // Enough depth that a wrong child index or a sift that stops one level
        // early shows up. The values are from a linear congruential generator so
        // the order is a real jumble and the test is still deterministic.
        const result = await run(
            "heap-sorted",
            withImport(
                "BinaryHeap",
                `function ascending(a: u32, b: u32): boolean { return a < b; }

       export function main(): i32 {
         const h = new BinaryHeap<u32>(ascending);
         let seed: u32 = 12345;
         for (let i: i32 = 0; i < 1000; i = i + 1) {
           seed = seed * 1664525 + 1013904223;
           h.push(seed);
         }
         console.log(\`\${h.size}\`);
         let previous: u32 = 0;
         let inversions: i32 = 0;
         let count: i32 = 0;
         while (h.size !== 0) {
           const next = h.pop();
           if (next < previous) { inversions = inversions + 1; }
           previous = next;
           count = count + 1;
         }
         console.log(\`\${count} \${inversions}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("1000\n1000 0\n");
    });

    test("ordering by a field, which is what an event queue does", async () => {
        const result = await run(
            "heap-by-field",
            withImport(
                "BinaryHeap",
                `interface Event { time: f64; tag: i32 }

       function sooner(a: Event, b: Event): boolean { return a.time < b.time; }

       export function main(): i32 {
         const queue = new BinaryHeap<Event>(sooner);
         queue.push({time: 3.5, tag: 3});
         queue.push({time: 0.5, tag: 1});
         queue.push({time: 9.0, tag: 4});
         queue.push({time: 1.5, tag: 2});
         let out = "";
         while (queue.size !== 0) { out = out + \`\${queue.pop().tag}\`; }
         console.log(out);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("1234\n");
    });

    test("peek looks without taking", async () => {
        const result = await run(
            "heap-peek",
            withImport(
                "BinaryHeap",
                `function ascending(a: i32, b: i32): boolean { return a < b; }

       export function main(): i32 {
         const h = new BinaryHeap<i32>(ascending);
         h.push(4);
         h.push(2);
         console.log(\`\${h.peek()} \${h.size} \${h.peek()} \${h.size}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("2 2 2 2\n");
    });

    test("one element, then none", async () => {
        // The `last === 0` arm of `pop`, which is the one that does not sift.
        const result = await run(
            "heap-single",
            withImport(
                "BinaryHeap",
                `function ascending(a: i32, b: i32): boolean { return a < b; }

       export function main(): i32 {
         const h = new BinaryHeap<i32>(ascending);
         h.push(42);
         console.log(\`\${h.size} \${h.pop()} \${h.size}\`);
         h.push(1);
         h.push(2);
         console.log(\`\${h.pop()} \${h.pop()} \${h.size}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("1 42 0\n1 2 0\n");
    });

    test("clear, reserve, and owning elements", async () => {
        const result = await run(
            "heap-owning",
            withImport(
                "BinaryHeap",
                `function ascending(a: string, b: string): boolean {
         return a.length < b.length;
       }

       export function main(): i32 {
         const h = new BinaryHeap<string>(ascending);
         h.reserve(64);
         h.push("cccc");
         h.push("a");
         h.push("bb");
         h.push("ddddd");
         console.log(\`\${h.pop()} \${h.pop()}\`);
         h.clear();
         console.log(\`\${h.size}\`);
         h.push("again");
         console.log(h.pop());
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("a bb\n0\nagain\n");
        expect(result.leaked).toBe(0);
    });
});

describe("RingBuffer", () => {
    test("first in, first out", async () => {
        const result = await run(
            "ring-fifo",
            withImport(
                "RingBuffer",
                `export function main(): i32 {
         const r = new RingBuffer<i32>(4);
         r.push(1);
         r.push(2);
         r.push(3);
         console.log(\`\${r.size} \${r.capacity} \${r.isEmpty} \${r.isFull}\`);
         console.log(\`\${r.pop()} \${r.pop()} \${r.pop()} \${r.isEmpty}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("3 4 false false\n1 2 3 true\n");
    });

    test("a full ring refuses rather than growing or overwriting", async () => {
        const result = await run(
            "ring-full",
            withImport(
                "RingBuffer",
                `export function main(): i32 {
         const r = new RingBuffer<i32>(2);
         console.log(\`\${r.push(1)} \${r.push(2)} \${r.push(3)}\`);
         console.log(\`\${r.size} \${r.isFull} \${r.at(0)} \${r.at(1)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("true true false\n2 true 1 2\n");
    });

    test("indices wrap, over many more cycles than the capacity", async () => {
        // The whole point of a ring, and where an off-by-one in `wrap` hides: it
        // only shows up once the write index has passed the end.
        const result = await run(
            "ring-wrap",
            withImport(
                "RingBuffer",
                `export function main(): i32 {
         const r = new RingBuffer<i32>(3);
         let wrong: i32 = 0;
         for (let i: i32 = 0; i < 1000; i = i + 1) {
           if (!r.push(i)) { wrong = wrong + 1; }
           if (r.pop() !== i) { wrong = wrong + 1; }
         }
         console.log(\`\${wrong} \${r.size}\`);

         // And half-full, so the front and the back are on opposite sides.
         r.push(1);
         r.push(2);
         for (let i: i32 = 3; i < 100; i = i + 1) {
           if (r.pop() !== i - 2) { wrong = wrong + 1; }
           r.push(i);
         }
         console.log(\`\${wrong} \${r.size} \${r.at(0)} \${r.at(1)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0 0\n0 2 98 99\n");
    });

    test("a capacity of one", async () => {
        const result = await run(
            "ring-one",
            withImport(
                "RingBuffer",
                `export function main(): i32 {
         const r = new RingBuffer<i32>(1);
         console.log(\`\${r.push(1)} \${r.push(2)} \${r.isFull}\`);
         console.log(\`\${r.pop()} \${r.isEmpty} \${r.push(3)} \${r.pop()}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("true false true\n1 true true 3\n");
    });

    test("owning elements are released exactly once, empty slots included", async () => {
        // The delicate part of this container: a free slot holds a real `T` — a
        // zeroed one — so both the elements *and* the holes are destroyed when
        // the ring goes away, and a `pop` that forgot to put a zeroed value back
        // would release the same string twice.
        const result = await run(
            "ring-owning",
            withImport(
                "RingBuffer",
                `export function main(): i32 {
         const r = new RingBuffer<string>(8);
         for (let round: i32 = 0; round < 50; round = round + 1) {
           for (let i: i32 = 0; i < 8; i = i + 1) { r.push(\`item \${round}-\${i}\`); }
           for (let i: i32 = 0; i < 6; i = i + 1) { r.pop(); }
           for (let i: i32 = 0; i < 6; i = i + 1) { r.push(\`extra \${round}-\${i}\`); }
           for (let i: i32 = 0; i < 8; i = i + 1) { r.pop(); }
         }
         console.log(\`\${r.size} \${r.isEmpty}\`);
         r.push("last");
         console.log(\`\${r.at(0)}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0 true\nlast\n");
        expect(result.leaked).toBe(0);
    });

    test("clear releases what is in it and leaves the ring usable", async () => {
        const result = await run(
            "ring-clear",
            withImport(
                "RingBuffer",
                `export function main(): i32 {
         const r = new RingBuffer<string>(4);
         r.push("a");
         r.push("b");
         r.clear();
         console.log(\`\${r.size} \${r.isEmpty}\`);
         r.push("c");
         console.log(\`\${r.pop()} \${r.size}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0 true\nc 0\n");
        expect(result.leaked).toBe(0);
    });

    test("a struct element, which is what a ring usually holds", async () => {
        const result = await run(
            "ring-struct",
            withImport(
                "RingBuffer",
                `interface Sample { t: f64; value: f64 }

       export function main(): i32 {
         const r = new RingBuffer<Sample>(4);
         for (let i: i32 = 0; i < 4; i = i + 1) {
           r.push({t: cast<f64>(i), value: cast<f64>(i) * 0.5});
         }
         console.log(\`\${r.at(0).t} \${r.at(3).value} \${r.size}\`);
         const first = r.pop();
         console.log(\`\${first.t} \${first.value} \${r.size}\`);
         return 0;
       }\n`,
            ),
        );
        expect(result.stdout).toBe("0 1.5 4\n0 0 3\n");
    });

    test("a class element is refused, because a free slot has to hold a value", async () => {
        // `zeroed<T>()` refuses a class — it would produce one whose constructor
        // never ran — and a ring needs one for every slot it is not using. The
        // refusal arrives at the instantiation, which is where the class was
        // named.
        await expectRejected(
            "ring-class",
            withImport(
                "RingBuffer",
                `class Body { id: i32; constructor(id: i32) { this.id = id; } }

       export function main(): i32 {
         const r = new RingBuffer<Body>(4);
         return 0;
       }\n`,
            ),
            "GF0002",
        );
    });
});

/**
 * The README's own examples, compiled and run.
 *
 * Documentation that does not compile is documentation that is wrong, and the
 * collection section of the README is where a reader meets all of this for the
 * first time. Two of these snippets were wrong when they were written — a lambda
 * where a function pointer is required, and a numeric separator — and this is
 * what found them.
 *
 * Keep this in step with `README.md` by hand: nothing extracts it, because a
 * fenced block in prose is allowed to elide things a program cannot.
 */
describe("the README compiles", () => {
    test("the collection section", async () => {
        const result = await run(
            "readme-collections",
            `import { BinaryHeap, HashMap, HashSet, RingBuffer } from "std/collection";

       interface Event { time: f64; tag: i32 }
       interface Sample { t: f64 }
       interface Body { id: u64 }

       class Cell {
         x: i32;
         y: i32;
         constructor(x: i32, y: i32) { this.x = x; this.y = y; }
         hash(): u64 { return hashOf<i32>(this.x) ^ hashOf<i32>(this.y); }
         equals(other: Reference<Cell>): boolean {
           return this.x === other.x && this.y === other.y;
         }
       }

       function sooner(a: Event, b: Event): boolean { return a.time < b.time; }

       export function main(): i32 {
         const orbits = new HashMap<string, f64>();
         orbits.set("earth", 1.0);
         orbits.set("mars", 1.524);
         console.log(\`\${orbits.getOr("mars", 0.0)} \${orbits.has("venus")}\`);

         const body: Body = {id: 7};
         const seen = new HashSet<u64>();
         console.log(\`\${seen.add(body.id)} \${seen.add(body.id)}\`);

         const queue = new BinaryHeap<Event>(sooner);
         queue.push({time: 2.0, tag: 2});
         queue.push({time: 1.0, tag: 1});
         console.log(\`\${queue.pop().tag}\`);

         const recent = new RingBuffer<Sample>(256);
         recent.push({t: 1.0});
         console.log(\`\${recent.size}\`);

         const grid = new HashMap<Cell, Body>();
         grid.set(new Cell(3, 4), body);
         console.log(\`\${grid.getOr(new Cell(3, 4), {id: 0}).id}\`);

         for (let i: usize = 0; i < orbits.size; i = i + 1) {
           console.log(\`\${orbits.keyAt(i)} \${orbits.valueAt(i)}\`);
         }
         let names = "";
         orbits.forEach((name, au) => { names = names + name; });
         console.log(names);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe(
            "1.524 false\ntrue false\n1\n1\n7\nearth 1\nmars 1.524\nearthmars\n",
        );
        expect(result.leaked).toBe(0);
    });

    test("the reserve snippets", async () => {
        const result = await run(
            "readme-reserve",
            `interface Body { id: u64 }

       export function main(): i32 {
         const bodies: Body[] = [];
         bodies.reserve(50000);

         const step: usize = 4096;
         const b: Body = {id: 1};
         if (bodies.length === bodies.capacity) {
           bodies.reserve(bodies.capacity + step);
         }
         bodies.push(b);
         console.log(\`\${bodies.length} \${bodies.capacity}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("1 50000\n");
    });
});
