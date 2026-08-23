/**
 * `std/linalg`'s quaternions, and the integer and boolean vectors.
 *
 * DECISIONS §22. Quaternions share four fifths of their arithmetic with a
 * `vec4` and it is the remaining fifth that needs testing: the Hamilton
 * product, which composes rotations, and `slerp`, which has to take the short
 * way round the sphere. Both produce a rotation when they are wrong — just not
 * the one that was asked for — so every case here checks a rotation by applying
 * it to a known vector rather than by reading its components.
 *
 * The integer vectors are the opposite: nothing about them is subtle, and what
 * is under test is that they exist, that they do *not* have the operations that
 * would need a square root, and that `min`/`max` — the one place they cost more
 * than floats, being a compare and a select — get the right answer.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("std/linalg quaternions", () => {
    test("a quaternion is four components, and identity does nothing", async () => {
        const result = await run(
            "quat-identity",
            `import { dquat, fquat, dvec3 } from "std/linalg";

export function main(): i32 {
  console.log(\`size \${sizeOf<dquat>()} \${sizeOf<fquat>()}\`);

  const i = dquat.identity();
  console.log(\`i \${i.x} \${i.y} \${i.z} \${i.w}\`);

  const v = i.rotateVec(new dvec3(3.0, 4.0, 5.0));
  console.log(\`v \${v.x} \${v.y} \${v.z}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(["size 32 16", "i 0 0 0 1", "v 3 4 5", ""].join("\n"));
        expect(result.leaked).toBe(0);
    });

    test("a rotation turns the axes the right way", async () => {
        const result = await run(
            "quat-rotate",
            `import { dquat, dvec3 } from "std/linalg";
import { dpi } from "std/math";

export function main(): i32 {
  // A quarter turn about +z takes +x to +y, right-handed.
  const q = dquat.fromAxisAngle(dvec3.unitZ(), dpi() / 2.0);
  const turned = q.rotateVec(dvec3.unitX());
  console.log(\`z \${near(turned.x)} \${near(turned.y)} \${near(turned.z)}\`);

  // About +x, +y goes to +z.
  const p = dquat.fromAxisAngle(dvec3.unitX(), dpi() / 2.0);
  const up = p.rotateVec(dvec3.unitY());
  console.log(\`x \${near(up.x)} \${near(up.y)} \${near(up.z)}\`);

  // A rotation preserves length, whatever the axis.
  const odd = dquat.fromAxisAngle(new dvec3(1.0, 2.0, 3.0), 0.9);
  const moved = odd.rotateVec(new dvec3(3.0, -4.0, 12.0));
  console.log(\`len \${near(moved.length() - 13.0)}\`);
  return 0;
}

function near(x: f64): i32 {
  if (x > 0.9999 && x < 1.0001) { return 1; }
  if (x > -1.0001 && x < -0.9999) { return -1; }
  if (x > -0.0001 && x < 0.0001) { return 0; }
  return 9;
}
`,
        );
        expect(result.stdout).toBe(["z 0 1 0", "x 0 0 1", "len 0", ""].join("\n"));
        expect(result.leaked).toBe(0);
    });

    test("multiplication composes rotations, right to left", async () => {
        // The Hamilton product is not elementwise, and `a.mul(b)` applies `b`
        // first — the same order a matrix `mul` means, which is the point of
        // spelling it the same way.
        const result = await run(
            "quat-compose",
            `import { dquat, dvec3 } from "std/linalg";
import { dpi } from "std/math";

export function main(): i32 {
  const quarter = dpi() / 2.0;
  const aboutZ = dquat.fromAxisAngle(dvec3.unitZ(), quarter);
  const aboutX = dquat.fromAxisAngle(dvec3.unitX(), quarter);

  // z applied after x: +y goes to +z (by x), then stays +z (z-rotation
  // leaves the z axis alone).
  const zThenX = aboutZ.mul(aboutX);
  const a = zThenX.rotateVec(dvec3.unitY());
  console.log(\`zx \${near(a.x)} \${near(a.y)} \${near(a.z)}\`);

  // The other order: +y goes to -x (by z), then -x is unmoved by the x
  // rotation.
  const xThenZ = aboutX.mul(aboutZ);
  const b = xThenZ.rotateVec(dvec3.unitY());
  console.log(\`xz \${near(b.x)} \${near(b.y)} \${near(b.z)}\`);

  // Two quarter turns about the same axis make a half turn.
  const half = aboutZ.mul(aboutZ);
  const c = half.rotateVec(dvec3.unitX());
  console.log(\`half \${near(c.x)} \${near(c.y)} \${near(c.z)}\`);

  // A rotation times its inverse is the identity.
  const back = aboutZ.mul(aboutZ.inverse());
  const d = back.rotateVec(new dvec3(1.0, 2.0, 3.0));
  console.log(\`inv \${near(d.x - 1.0)} \${near(d.y - 2.0)} \${near(d.z - 3.0)}\`);
  return 0;
}

function near(x: f64): i32 {
  if (x > 0.9999 && x < 1.0001) { return 1; }
  if (x > -1.0001 && x < -0.9999) { return -1; }
  if (x > -0.0001 && x < 0.0001) { return 0; }
  return 9;
}
`,
        );
        expect(result.stdout).toBe(
            ["zx 0 0 1", "xz -1 0 0", "half -1 0 0", "inv 0 0 0", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("slerp takes the short way round", async () => {
        // Two unit quaternions `q` and `-q` are the same rotation, so an
        // interpolation that ignores the sign of the dot product goes the long
        // way half the time. The check is that interpolating towards a negated
        // endpoint lands in the same place as towards the endpoint itself.
        const result = await run(
            "quat-slerp",
            `import { dquat, dvec3 } from "std/linalg";
import { dpi } from "std/math";

export function main(): i32 {
  const start = dquat.identity();
  const end = dquat.fromAxisAngle(dvec3.unitZ(), dpi() / 2.0);

  // Halfway is an eighth turn: +x lands at 45 degrees.
  const mid = start.slerp(end, 0.5);
  const v = mid.rotateVec(dvec3.unitX());
  console.log(\`mid \${close(v.x, 0.7071067811865476)} \${close(v.y, 0.7071067811865476)}\`);

  // The same rotation, spelled with every component negated. Slerping to it
  // must go the same way — not three-quarters of the way round the other side.
  const negated = end.scale(-1.0);
  const alsoMid = start.slerp(negated, 0.5);
  const w = alsoMid.rotateVec(dvec3.unitX());
  console.log(\`neg \${close(w.x, 0.7071067811865476)} \${close(w.y, 0.7071067811865476)}\`);

  // The endpoints are reached.
  const atStart = start.slerp(end, 0.0).rotateVec(dvec3.unitX());
  const atEnd = start.slerp(end, 1.0).rotateVec(dvec3.unitX());
  console.log(\`ends \${close(atStart.x, 1.0)} \${close(atEnd.y, 1.0)}\`);
  return 0;
}

function close(x: f64, target: f64): boolean {
  const d = x - target;
  return d > -0.0001 && d < 0.0001;
}
`,
        );
        expect(result.stdout).toBe(
            ["mid true true", "neg true true", "ends true true", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("a quaternion and a matrix agree about the same rotation", async () => {
        // The two representations are checked against each other rather than
        // against a table of numbers: if `toMat3` and `fromAxisAngle` disagree,
        // one of them is wrong and neither is obviously so from its components.
        const result = await run(
            "quat-matrix",
            `import { dquat, dmat3, dmat4, dvec3 } from "std/linalg";

export function main(): i32 {
  const axis = new dvec3(1.0, 2.0, 3.0);
  const angle: f64 = 0.8;
  const q = dquat.fromAxisAngle(axis, angle);
  const m = dmat3.fromAxisAngle(axis, angle);

  const v = new dvec3(4.0, -5.0, 6.0);
  const byQuat = q.rotateVec(v);
  const byMat = m.mulVec(v);
  console.log(\`agree \${close(byQuat.x, byMat.x)} \${close(byQuat.y, byMat.y)} \${close(byQuat.z, byMat.z)}\`);

  // And the quaternion's own matrix agrees too.
  const converted = q.toMat3();
  const byConverted = converted.mulVec(v);
  console.log(\`toMat3 \${close(byConverted.x, byMat.x)} \${close(byConverted.z, byMat.z)}\`);

  // The 4x4 form carries the same basis with an identity fourth row/column.
  const wide: dmat4 = q.toMat4();
  console.log(\`toMat4 \${close(wide.c0.x, converted.c0.x)} \${wide.c3.w} \${wide.c0.w}\`);

  // And back again.
  const round = dquat.fromRotation(converted);
  const byRound = round.rotateVec(v);
  console.log(\`round \${close(byRound.x, byMat.x)} \${close(byRound.y, byMat.y)}\`);
  return 0;
}

function close(a: f64, b: f64): boolean {
  const d = a - b;
  return d > -0.000001 && d < 0.000001;
}
`,
        );
        expect(result.stdout).toBe(
            [
                "agree true true true",
                "toMat3 true true",
                "toMat4 true 1 0",
                "round true true",
                "",
            ].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("`mul` on a quaternion is not the elementwise one", async () => {
        // A `dquat` is four numbers like a `dvec4`, and the whole reason it is
        // a separate type is that `mul` means something else. If a quaternion
        // were assignable to a `dvec4` this would silently be a Hadamard
        // product somewhere.
        await expectRejected(
            "quat-not-a-vec4",
            `import { dquat, dvec4 } from "std/linalg";

       export function main(): i32 {
         const q = dquat.identity();
         const v: dvec4 = q;
         return cast<i32>(v.x);
       }\n`,
            // tsc names the missing members rather than just the mismatch,
            // which is the more useful of the two errors it could give.
            "TS2740",
        );
    });
});

describe("std/linalg integer and boolean vectors", () => {
    test("integer vectors are packed and exact", async () => {
        const result = await run(
            "int-basics",
            `import { ivec2, ivec3, uvec4, lvec3, ulvec2, bvec3 } from "std/linalg";

export function main(): i32 {
  console.log(\`size \${sizeOf<ivec3>()} \${sizeOf<lvec3>()} \${sizeOf<bvec3>()} \${sizeOf<uvec4>()}\`);

  const a = new ivec3(1, 2, 3);
  const b = new ivec3(10, 20, 30);
  const sum = a.add(b);
  console.log(\`add \${sum.x} \${sum.y} \${sum.z}\`);
  console.log(\`dot \${a.dot(b)} \${a.lengthSq()}\`);

  const d = b.div(a);
  console.log(\`div \${d.x} \${d.y} \${d.z}\`);
  const r = b.rem(new ivec3(3, 7, 4));
  console.log(\`rem \${r.x} \${r.y} \${r.z}\`);

  // The one place integers cost more than floats: a compare and a select.
  const lo = a.min(b);
  const hi = a.max(b);
  console.log(\`minmax \${lo.x} \${lo.y} \${hi.z}\`);

  const neg = new ivec3(-4, 5, -6);
  console.log(\`abs \${neg.abs().x} \${neg.abs().z} \${neg.negate().y}\`);

  const bits = new uvec4(12, 10, 6, 3);
  console.log(\`bits \${bits.bitAnd(new uvec4(10, 12, 3, 6)).x} \${bits.shl(new uvec4(1, 1, 1, 1)).y}\`);

  const wide = new lvec3(1, 2, 3);
  console.log(\`wide \${wide.scale(1000000000).x}\`);
  const un = new ulvec2(7, 8);
  console.log(\`un \${un.mul(un).y}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            [
                "size 12 24 3 16",
                "add 11 22 33",
                "dot 140 14",
                "div 10 10 10",
                "rem 1 6 2",
                "minmax 1 2 30",
                "abs 4 6 -5",
                "bits 8 20",
                "wide 1000000000",
                "un 64",
                "",
            ].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("comparisons produce a bvec, which any and all reduce", async () => {
        const result = await run(
            "bool-compare",
            `import { dvec3, ivec3, bvec3 } from "std/linalg";

export function main(): i32 {
  const a = new dvec3(1.0, 5.0, 3.0);
  const b = new dvec3(2.0, 2.0, 3.0);

  const lt = a.lessThan(b);
  console.log(\`lt \${lt.x} \${lt.y} \${lt.z}\`);
  console.log(\`reduce \${lt.any()} \${lt.all()}\`);

  const ge = a.greaterThanEqual(b);
  console.log(\`ge \${ge.x} \${ge.y} \${ge.z}\`);
  console.log(\`all \${ge.any()} \${ge.all()}\`);

  // The same on integers, through the same lowering.
  const i = new ivec3(1, 5, 3);
  const j = new ivec3(2, 2, 3);
  console.log(\`int \${i.lessThan(j).x} \${i.equalTo(j).z}\`);

  // \`equals\` asks one question about the whole vector; \`equalTo\` asks it
  // per component. The names are deliberately far apart.
  console.log(\`equals \${a.equals(b)} \${a.equalTo(b).z}\`);

  const t = bvec3.splat(true);
  console.log(\`logic \${t.all()} \${t.not().any()} \${lt.or(ge).all()}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            [
                "lt true false false",
                "reduce true false",
                "ge false true true",
                "all true false",
                "int true true",
                "equals false true",
                "logic true false true",
                "",
            ].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("integers have no operation that would need a square root", async () => {
        // `length`, `normalize` and `lerp` are absent by design: each is a
        // question about a root or a fractional part, and an integer answer to
        // either is a different type wearing this one's name.
        await expectRejected(
            "int-no-length",
            `import { ivec3 } from "std/linalg";

       export function main(): i32 {
         return cast<i32>(new ivec3(3, 4, 0).length());
       }\n`,
            // tsc offers `lengthSq`, which is the right suggestion and a better
            // error than a bare "does not exist".
            "TS2551",
        );

        await expectRejected(
            "int-no-normalize",
            `import { ivec3 } from "std/linalg";

       export function main(): i32 {
         return new ivec3(3, 4, 0).normalize().x;
       }\n`,
            "TS2339",
        );
    });

    test("an unsigned vector cannot be negated", async () => {
        // `negate` on a `uvec3` would produce a value the width rules make
        // unwritable as a literal, so the type simply does not have it.
        await expectRejected(
            "uint-no-negate",
            `import { uvec3 } from "std/linalg";

       export function main(): i32 {
         return cast<i32>(new uvec3(1, 2, 3).negate().x);
       }\n`,
            "TS2339",
        );
    });

    test("integer vectors have no vector unit and no padded form", async () => {
        await expectRejected(
            "int-no-aligned",
            `import { aligned_ivec3 } from "std/linalg";

       export function main(): i32 {
         return 0;
       }\n`,
            // tsc points at `aligned_dvec3`, which is the type that does exist
            // and is exactly the right thing to suggest.
            "TS2724",
        );
    });
});
