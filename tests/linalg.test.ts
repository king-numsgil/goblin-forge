/**
 * `std/linalg` — GLM's shape, on the vector unit.
 *
 * DECISIONS §22. What is actually under test here is **arithmetic**, computed
 * by a real program and printed, because every one of these operations is
 * composed by the lowerer out of loads, shuffles and elementwise instructions,
 * and a composition that is off by a lane produces a plausible number rather
 * than a crash. `cross` is the example that matters: get the two shuffle masks
 * the wrong way round and you get the negated result, which is still a vector
 * perpendicular to both inputs.
 *
 * The other half is the layout. A `dvec3` is 24 bytes and an `aligned_dvec3` is
 * 32, and that difference is the entire user-facing reason the two exist — so
 * it is asserted with `sizeOf` rather than trusted.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("std/linalg", () => {
    test("a vector is a struct: packed, sized, and laid out in order", async () => {
        // The claim the whole module rests on. If a `dvec3` is not 24 bytes
        // then it is not the thing a vertex buffer holds, and the `aligned_`
        // distinction means nothing.
        const result = await run(
            "linalg-layout",
            `import { dvec2, dvec3, dvec4, aligned_dvec3, fvec3, aligned_fvec3 } from "std/linalg";

export function main(): i32 {
  console.log(\`dvec2 \${sizeOf<dvec2>()}\`);
  console.log(\`dvec3 \${sizeOf<dvec3>()}\`);
  console.log(\`dvec4 \${sizeOf<dvec4>()}\`);
  console.log(\`aligned_dvec3 \${sizeOf<aligned_dvec3>()}\`);
  console.log(\`fvec3 \${sizeOf<fvec3>()}\`);
  console.log(\`aligned_fvec3 \${sizeOf<aligned_fvec3>()}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            [
                "dvec2 16",
                "dvec3 24",
                "dvec4 32",
                "aligned_dvec3 32",
                "fvec3 12",
                "aligned_fvec3 16",
                "",
            ].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("components are ordinary fields, readable and writable", async () => {
        const result = await run(
            "linalg-components",
            `import { dvec3 } from "std/linalg";

export function main(): i32 {
  const v = new dvec3(1.0, 2.0, 3.0);
  console.log(\`\${v.x} \${v.y} \${v.z}\`);
  let w = new dvec3(0.0, 0.0, 0.0);
  w.x = 7.0;
  w.z = 9.0;
  console.log(\`\${w.x} \${w.y} \${w.z}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe("1 2 3\n7 0 9\n");
        expect(result.leaked).toBe(0);
    });

    test("the three spellings agree, and the mutating one chains", async () => {
        const result = await run(
            "linalg-spellings",
            `import { dvec3 } from "std/linalg";

export function main(): i32 {
  const a = new dvec3(1.0, 2.0, 3.0);
  const b = new dvec3(10.0, 20.0, 30.0);

  const viaStatic = dvec3.add(a, b);
  const viaMethod = a.add(b);
  console.log(\`\${viaStatic.x} \${viaStatic.y} \${viaStatic.z}\`);
  console.log(\`\${viaMethod.x} \${viaMethod.y} \${viaMethod.z}\`);

  // The mutating form writes through the receiver and hands back a
  // reference, so a second mutation applies to the same value.
  let c = new dvec3(1.0, 2.0, 3.0);
  c.addMut(b).scaleMut(2.0);
  console.log(\`\${c.x} \${c.y} \${c.z}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe("11 22 33\n11 22 33\n22 44 66\n");
        expect(result.leaked).toBe(0);
    });

    test("dot, length and normalize compute the right numbers", async () => {
        const result = await run(
            "linalg-geometry",
            `import { dvec3 } from "std/linalg";

export function main(): i32 {
  const a = new dvec3(1.0, 2.0, 3.0);
  const b = new dvec3(10.0, 20.0, 30.0);
  console.log(\`dot \${a.dot(b)}\`);

  // 3-4-5, so the length is exact in binary and can be compared as one.
  const right = new dvec3(3.0, 4.0, 0.0);
  console.log(\`len \${right.length()}\`);
  console.log(\`lenSq \${right.lengthSq()}\`);

  const unit = right.normalize();
  console.log(\`unit \${unit.x} \${unit.y} \${unit.z}\`);
  console.log(\`unitLen \${unit.length()}\`);

  const from = new dvec3(1.0, 1.0, 0.0);
  const to = new dvec3(4.0, 5.0, 0.0);
  console.log(\`dist \${from.distance(to)}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            [
                "dot 140",
                "len 5",
                "lenSq 25",
                "unit 0.6 0.8 0",
                "unitLen 1",
                "dist 5",
                "",
            ].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("cross follows the right-hand rule, in both directions", async () => {
        // The operation whose two shuffle masks are easiest to swap, and whose
        // wrong answer is still perpendicular to both inputs — so it is checked
        // against a case where the sign is the whole answer.
        const result = await run(
            "linalg-cross",
            `import { dvec3 } from "std/linalg";

export function main(): i32 {
  const x = dvec3.unitX();
  const y = dvec3.unitY();
  const z = x.cross(y);
  console.log(\`x*y \${z.x} \${z.y} \${z.z}\`);

  const back = y.cross(x);
  console.log(\`y*x \${back.x} \${back.y} \${back.z}\`);

  const a = new dvec3(2.0, 3.0, 4.0);
  const b = new dvec3(5.0, 6.0, 7.0);
  const c = a.cross(b);
  console.log(\`general \${c.x} \${c.y} \${c.z}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            ["x*y 0 0 1", "y*x 0 0 -1", "general -3 6 -3", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("a padded vector answers exactly as its packed twin does", async () => {
        // The point of `aligned_`: it is the same arithmetic, with a lane of
        // padding. If a reduction ever read that lane the two would disagree —
        // and `div` is in here on purpose, because it is the operation that
        // turns an untouched padding lane into a NaN.
        const result = await run(
            "linalg-padded",
            `import { dvec3, aligned_dvec3 } from "std/linalg";

export function main(): i32 {
  const packed = new dvec3(3.0, 4.0, 0.0);
  const padded = new aligned_dvec3(3.0, 4.0, 0.0);
  console.log(\`len \${packed.length()} \${padded.length()}\`);
  console.log(\`dot \${packed.dot(packed)} \${padded.dot(padded)}\`);

  // Division leaves the padding lane a NaN. A length taken afterwards must
  // still be finite, which is what masking at the reduction buys.
  const ones = new aligned_dvec3(1.0, 1.0, 1.0);
  const divided = padded.div(ones);
  console.log(\`divLen \${divided.length()}\`);

  const cross = padded.cross(ones);
  console.log(\`cross \${cross.x} \${cross.y} \${cross.z}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            ["len 5 5", "dot 25 25", "divLen 5", "cross 4 -3 -1", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("the element types stay apart, and convert only when asked", async () => {
        const result = await run(
            "linalg-convert",
            `import { dvec3, fvec3, aligned_dvec3 } from "std/linalg";

export function main(): i32 {
  const wide = new dvec3(1.5, 2.5, 3.5);
  const narrow = fvec3.from(wide);
  console.log(\`narrow \${narrow.x} \${narrow.y} \${narrow.z}\`);

  // Packed to padded is a conversion too: same element, different shape.
  const padded = aligned_dvec3.from(wide);
  console.log(\`padded \${padded.x} \${padded.y} \${padded.z}\`);
  console.log(\`paddedLen \${padded.lengthSq()}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            ["narrow 1.5 2.5 3.5", "padded 1.5 2.5 3.5", "paddedLen 20.75", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("nothing converts implicitly", async () => {
        // The rule `std/math`'s prefix exists for, in the other half of the
        // library: an `fvec3` is not a narrower `dvec3`, and tsc is what says
        // so — not a rule of this compiler's.
        await expectRejected(
            "linalg-no-implicit",
            `import { dvec3, fvec3 } from "std/linalg";

       export function main(): i32 {
         const wide = new dvec3(1.0, 2.0, 3.0);
         const narrow = new fvec3(cast<f32>(1.0), cast<f32>(2.0), cast<f32>(3.0));
         const bad = wide.add(narrow);
         return cast<i32>(bad.x);
       }\n`,
            "TS2345",
        );
    });

    test("a packed and a padded vector are different types", async () => {
        await expectRejected(
            "linalg-packed-vs-padded",
            `import { dvec3, aligned_dvec3 } from "std/linalg";

       export function main(): i32 {
         const packed = new dvec3(1.0, 2.0, 3.0);
         const padded = new aligned_dvec3(1.0, 2.0, 3.0);
         return cast<i32>(packed.add(padded).x);
       }\n`,
            "TS2345",
        );
    });

    test("cross exists on three components and nowhere else", async () => {
        await expectRejected(
            "linalg-cross-arity",
            `import { dvec2 } from "std/linalg";

       export function main(): i32 {
         const a = new dvec2(1.0, 2.0);
         return cast<i32>(a.cross(a).x);
       }\n`,
            "TS2339",
        );
    });

    test("vectors live in arrays and structs like any other plain data", async () => {
        const result = await run(
            "linalg-aggregate",
            `import { dvec3 } from "std/linalg";

interface Vertex {
  position: dvec3;
  normal: dvec3;
}

export function main(): i32 {
  const points: dvec3[] = [];
  points.push(new dvec3(1.0, 0.0, 0.0));
  points.push(new dvec3(0.0, 2.0, 0.0));
  points.push(new dvec3(0.0, 0.0, 3.0));

  let total = dvec3.zero();
  for (let i: usize = 0; i < points.length; i = i + 1) {
    total.addMut(points[i]);
  }
  console.log(\`total \${total.x} \${total.y} \${total.z}\`);

  const v: Vertex = {
    position: new dvec3(1.0, 2.0, 3.0),
    normal: dvec3.unitY(),
  };
  console.log(\`vertex \${v.position.x} \${v.normal.y}\`);
  console.log(\`stride \${sizeOf<Vertex>()}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            ["total 1 2 3", "vertex 1 1", "stride 48", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });
});
