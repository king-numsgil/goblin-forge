/**
 * `std/linalg`'s matrices.
 *
 * DECISIONS §22. Two things are being pinned down here and they fail
 * differently.
 *
 * **The conventions**, which have no right answer a compiler is entitled to
 * pick: column-major storage, column vectors, `A.mul(B)` applying `B` first,
 * and a clip space of `[0, 1]` depth with `+Y` up. Every one of those is
 * asserted against a hand-computed number, because getting one wrong produces a
 * matrix — a plausible, invertible, entirely wrong matrix — rather than an
 * error. A projection that disagrees with its consumer is a black screen.
 *
 * **The arithmetic**, run rather than read. `inverse` is cofactor expansion
 * over a memoised sub-determinant, and the check that matters is that
 * `M * M⁻¹` is the identity for a matrix with no special structure.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("std/linalg matrices", () => {
    test("a matrix is its columns, packed and inline", async () => {
        const result = await run(
            "matrix-layout",
            `import { dmat2, dmat3, dmat4, aligned_dmat3, fmat4 } from "std/linalg";

export function main(): i32 {
  console.log(\`dmat2 \${sizeOf<dmat2>()}\`);
  console.log(\`dmat3 \${sizeOf<dmat3>()}\`);
  console.log(\`dmat4 \${sizeOf<dmat4>()}\`);
  console.log(\`aligned_dmat3 \${sizeOf<aligned_dmat3>()}\`);
  console.log(\`fmat4 \${sizeOf<fmat4>()}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            [
                "dmat2 32",
                "dmat3 72",
                "dmat4 128",
                "aligned_dmat3 96",
                "fmat4 64",
                "",
            ].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("columns are fields, and storage is column-major", async () => {
        // The convention, asserted where it is visible: `c0` is the first
        // *column*, so `m.c0.y` is row 1 of column 0 — not row 0 of column 1.
        const result = await run(
            "matrix-columns",
            `import { dmat3, dvec3 } from "std/linalg";

export function main(): i32 {
  const m = dmat3.fromColumns(
    new dvec3(1.0, 2.0, 3.0),
    new dvec3(4.0, 5.0, 6.0),
    new dvec3(7.0, 8.0, 9.0),
  );
  console.log(\`c0 \${m.c0.x} \${m.c0.y} \${m.c0.z}\`);
  console.log(\`c1 \${m.c1.x} \${m.c1.y} \${m.c1.z}\`);
  console.log(\`entry \${m.c2.y}\`);

  const t = m.transpose();
  console.log(\`t.c0 \${t.c0.x} \${t.c0.y} \${t.c0.z}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            ["c0 1 2 3", "c1 4 5 6", "entry 8", "t.c0 1 4 7", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("identity is the multiplicative unit, both ways round", async () => {
        const result = await run(
            "matrix-identity",
            `import { dmat4, dvec4 } from "std/linalg";

export function main(): i32 {
  const i = dmat4.identity();
  const m = dmat4.fromColumns(
    new dvec4(1.0, 2.0, 3.0, 4.0),
    new dvec4(5.0, 6.0, 7.0, 8.0),
    new dvec4(9.0, 10.0, 11.0, 12.0),
    new dvec4(13.0, 14.0, 15.0, 16.0),
  );
  console.log(\`left \${i.mul(m).equals(m)}\`);
  console.log(\`right \${m.mul(i).equals(m)}\`);

  const v = new dvec4(2.0, 3.0, 5.0, 1.0);
  const same = i.mulVec(v);
  console.log(\`vec \${same.x} \${same.y} \${same.z} \${same.w}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(["left true", "right true", "vec 2 3 5 1", ""].join("\n"));
        expect(result.leaked).toBe(0);
    });

    test("`a.mul(b)` applies b first, which is what makes it non-commutative", async () => {
        // The convention that decides whether a transform chain works. A
        // translate-then-rotate and a rotate-then-translate differ, and the
        // order `mul` means is the whole question.
        const result = await run(
            "matrix-order",
            `import { dmat4, dvec3, dvec4 } from "std/linalg";
import { dpi } from "std/math";

export function main(): i32 {
  const translate = dmat4.fromTranslation(new dvec3(10.0, 0.0, 0.0));
  const rotate = dmat4.fromRotationZ(dpi() / 2.0);
  const point = new dvec4(1.0, 0.0, 0.0, 1.0);

  // \`translate.mul(rotate)\` applies the rotation first: (1,0,0) turns to
  // (0,1,0), then shifts to (10,1,0).
  const rotateThenMove = translate.mul(rotate).mulVec(point);
  console.log(\`rt \${dround(rotateThenMove.x)} \${dround(rotateThenMove.y)}\`);

  // The other way round: shift to (11,0,0), then rotate to (0,11,0).
  const moveThenRotate = rotate.mul(translate).mulVec(point);
  console.log(\`tr \${dround(moveThenRotate.x)} \${dround(moveThenRotate.y)}\`);
  return 0;
}

function dround(x: f64): f64 {
  // Rounded, because a quarter turn goes through \`dsin\`/\`dcos\` and lands a
  // few ulps from the exact answer. What is under test is which transform ran
  // first, not the last bit of a cosine.
  return (x < 0.0 ? -1.0 : 1.0) * cast<f64>(cast<i64>(dabs(x) * 1000.0 + 0.5)) / 1000.0;
}

function dabs(x: f64): f64 {
  return x < 0.0 ? -x : x;
}
`,
        );
        expect(result.stdout).toBe(["rt 10 1", "tr 0 11", ""].join("\n"));
        expect(result.leaked).toBe(0);
    });

    test("determinant and inverse, on a matrix with no special structure", async () => {
        const result = await run(
            "matrix-inverse",
            `import { dmat2, dmat3, dmat4, dvec2, dvec3, dvec4 } from "std/linalg";

export function main(): i32 {
  // det [[1,2],[3,4]] = 1*4 - 2*3 = -2. Column-major: c0 = (1,3), c1 = (2,4).
  const m2 = dmat2.fromColumns(new dvec2(1.0, 3.0), new dvec2(2.0, 4.0));
  console.log(\`det2 \${m2.determinant()}\`);

  // A 3x3 whose determinant is a round number: det = 1.
  const m3 = dmat3.fromColumns(
    new dvec3(2.0, 0.0, 0.0),
    new dvec3(0.0, 3.0, 0.0),
    new dvec3(0.0, 0.0, 4.0),
  );
  console.log(\`det3 \${m3.determinant()}\`);

  const inv3 = m3.inverse();
  console.log(\`inv3 \${inv3.c0.x} \${inv3.c1.y} \${inv3.c2.z}\`);

  // The real check: a 4x4 with nothing special about it, times its inverse.
  const m4 = dmat4.fromColumns(
    new dvec4(4.0, 0.0, 2.0, 1.0),
    new dvec4(3.0, 1.0, 0.0, 2.0),
    new dvec4(0.0, 5.0, 1.0, 0.0),
    new dvec4(1.0, 2.0, 3.0, 4.0),
  );
  const product = m4.mul(m4.inverse());
  console.log(\`det4 \${m4.determinant()}\`);
  console.log(\`round \${near(product.c0.x)} \${near(product.c1.y)} \${near(product.c2.z)} \${near(product.c3.w)}\`);
  console.log(\`off \${near(product.c1.x)} \${near(product.c0.y)} \${near(product.c3.z)}\`);
  return 0;
}

/** 1 when a value is within a whisker of 1, 0 when within a whisker of 0. */
function near(x: f64): i32 {
  if (x > 0.999 && x < 1.001) { return 1; }
  if (x > -0.001 && x < 0.001) { return 0; }
  return 9;
}
`,
        );
        expect(result.stdout).toBe(
            [
                "det2 -2",
                "det3 24",
                "inv3 0.5 0.3333333333333333 0.25",
                // 180, expanded along the first row by hand:
                // 4*30 - 3*(-27) + 0*… - 1*21.
                "det4 180",
                "round 1 1 1 1",
                "off 0 0 0",
                "",
            ].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("elementwise operations run column by column", async () => {
        const result = await run(
            "matrix-elementwise",
            `import { dmat2, dvec2 } from "std/linalg";

export function main(): i32 {
  const a = dmat2.fromColumns(new dvec2(1.0, 2.0), new dvec2(3.0, 4.0));
  const b = dmat2.fromColumns(new dvec2(10.0, 20.0), new dvec2(30.0, 40.0));

  const sum = a.add(b);
  console.log(\`add \${sum.c0.x} \${sum.c0.y} \${sum.c1.x} \${sum.c1.y}\`);

  const scaled = a.scale(2.0);
  console.log(\`scale \${scaled.c0.x} \${scaled.c1.y}\`);

  const negated = a.negate();
  console.log(\`neg \${negated.c0.x} \${negated.c1.y}\`);

  let acc = dmat2.zero();
  acc.addMut(a).addMut(b);
  console.log(\`mut \${acc.c0.x} \${acc.c1.y}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            ["add 11 22 33 44", "scale 2 8", "neg -1 -4", "mut 11 44", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("a rotation is a rotation: orthonormal, and it turns the axes", async () => {
        const result = await run(
            "matrix-rotation",
            `import { dmat3, dvec3 } from "std/linalg";
import { dpi } from "std/math";

export function main(): i32 {
  // A quarter turn about z takes +x to +y.
  const rz = dmat3.fromRotationZ(dpi() / 2.0);
  const turned = rz.mulVec(dvec3.unitX());
  console.log(\`z \${near(turned.x)} \${near(turned.y)} \${near(turned.z)}\`);

  // About x, +y goes to +z.
  const rx = dmat3.fromRotationX(dpi() / 2.0);
  const up = rx.mulVec(dvec3.unitY());
  console.log(\`x \${near(up.x)} \${near(up.y)} \${near(up.z)}\`);

  // About y, +z goes to +x.
  const ry = dmat3.fromRotationY(dpi() / 2.0);
  const front = ry.mulVec(dvec3.unitZ());
  console.log(\`y \${near(front.x)} \${near(front.y)} \${near(front.z)}\`);

  // A rotation preserves length and has determinant 1.
  const arbitrary = dmat3.fromAxisAngle(new dvec3(1.0, 2.0, 3.0), 0.7);
  const v = new dvec3(3.0, -4.0, 12.0);
  const moved = arbitrary.mulVec(v);
  console.log(\`len \${near(moved.length() - v.length())}\`);
  console.log(\`det \${near(arbitrary.determinant())}\`);
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
            ["z 0 1 0", "x 0 0 1", "y 1 0 0", "len 0", "det 1", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("perspective maps near to 0 and far to 1, with +Y up", async () => {
        // The convention that has no defensible default and was settled by the
        // target: SDL3's GPU API on Vulkan. Near maps to depth 0, far to 1, and
        // there is no Y flip — a point above the axis stays above it.
        const result = await run(
            "matrix-perspective",
            `import { dmat4, dvec4 } from "std/linalg";
import { dpi } from "std/math";

export function main(): i32 {
  const p = dmat4.perspective(dpi() / 2.0, 1.0, 1.0, 101.0);

  // A point on the near plane: depth 0 after the perspective divide.
  const atNear = p.mulVec(new dvec4(0.0, 0.0, -1.0, 1.0));
  console.log(\`near \${near(atNear.z / atNear.w)}\`);

  // On the far plane: depth 1.
  const atFar = p.mulVec(new dvec4(0.0, 0.0, -101.0, 1.0));
  console.log(\`far \${near(atFar.z / atFar.w)}\`);

  // +Y stays up: a point above the axis has positive y in NDC.
  const above = p.mulVec(new dvec4(0.0, 1.0, -1.0, 1.0));
  console.log(\`up \${above.y > 0.0}\`);

  // The w it divides by is the negated view-space z, which is what makes
  // things further away smaller.
  console.log(\`w \${near(atFar.w - 101.0)}\`);
  return 0;
}

function near(x: f64): i32 {
  if (x > 0.9999 && x < 1.0001) { return 1; }
  if (x > -0.0001 && x < 0.0001) { return 0; }
  return 9;
}
`,
        );
        expect(result.stdout).toBe(["near 0", "far 1", "up true", "w 0", ""].join("\n"));
        expect(result.leaked).toBe(0);
    });

    test("ortho maps the box corners to the clip cube", async () => {
        const result = await run(
            "matrix-ortho",
            `import { dmat4, dvec4 } from "std/linalg";

export function main(): i32 {
  const o = dmat4.ortho(-2.0, 2.0, -1.0, 1.0, 1.0, 11.0);

  const lowNear = o.mulVec(new dvec4(-2.0, -1.0, -1.0, 1.0));
  console.log(\`lo \${lowNear.x} \${lowNear.y} \${lowNear.z}\`);

  const highFar = o.mulVec(new dvec4(2.0, 1.0, -11.0, 1.0));
  console.log(\`hi \${highFar.x} \${highFar.y} \${highFar.z}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(["lo -1 -1 0", "hi 1 1 1", ""].join("\n"));
        expect(result.leaked).toBe(0);
    });

    test("lookAt puts the eye at the origin looking down -z", async () => {
        const result = await run(
            "matrix-lookat",
            `import { dmat4, dvec3, dvec4 } from "std/linalg";

export function main(): i32 {
  const eye = new dvec3(0.0, 0.0, 5.0);
  const view = dmat4.lookAt(eye, dvec3.zero(), dvec3.unitY());

  // The eye maps to the origin.
  const atEye = view.mulVec(new dvec4(0.0, 0.0, 5.0, 1.0));
  console.log(\`eye \${near(atEye.x)} \${near(atEye.y)} \${near(atEye.z)}\`);

  // The target sits down the -z axis, five away.
  const atTarget = view.mulVec(new dvec4(0.0, 0.0, 0.0, 1.0));
  console.log(\`target \${near(atTarget.z + 5.0)}\`);

  // A view matrix is rigid, so its determinant is 1.
  console.log(\`det \${near(view.determinant())}\`);
  return 0;
}

function near(x: f64): i32 {
  if (x > 0.9999 && x < 1.0001) { return 1; }
  if (x > -0.0001 && x < 0.0001) { return 0; }
  return 9;
}
`,
        );
        expect(result.stdout).toBe(["eye 0 0 0", "target 0", "det 1", ""].join("\n"));
        expect(result.leaked).toBe(0);
    });

    test("a padded matrix answers as its packed twin does", async () => {
        const result = await run(
            "matrix-padded",
            `import { dmat3, aligned_dmat3, dvec3, aligned_dvec3 } from "std/linalg";

export function main(): i32 {
  const packed = dmat3.fromColumns(
    new dvec3(2.0, 0.0, 1.0),
    new dvec3(0.0, 3.0, 0.0),
    new dvec3(1.0, 0.0, 4.0),
  );
  const padded = aligned_dmat3.fromColumns(
    new aligned_dvec3(2.0, 0.0, 1.0),
    new aligned_dvec3(0.0, 3.0, 0.0),
    new aligned_dvec3(1.0, 0.0, 4.0),
  );
  console.log(\`det \${packed.determinant()} \${padded.determinant()}\`);

  const a = packed.mulVec(new dvec3(1.0, 1.0, 1.0));
  const b = padded.mulVec(new aligned_dvec3(1.0, 1.0, 1.0));
  console.log(\`mulVec \${a.x} \${a.y} \${a.z}\`);
  console.log(\`padded \${b.x} \${b.y} \${b.z}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(
            ["det 21 21", "mulVec 3 3 5", "padded 3 3 5", ""].join("\n"),
        );
        expect(result.leaked).toBe(0);
    });

    test("a literal index reaches a column or a component", async () => {
        // `m[0]` is `m.c0` and `v[1]` is `v.y` — the spelling a shader uses,
        // and a field projection rather than an element at a stride.
        const result = await run(
            "linalg-index",
            `import { dmat3, dvec3 } from "std/linalg";

export function main(): i32 {
  const v = new dvec3(1.0, 2.0, 3.0);
  console.log(\`v \${v[0]} \${v[1]} \${v[2]}\`);

  const m = dmat3.fromColumns(
    new dvec3(1.0, 2.0, 3.0),
    new dvec3(4.0, 5.0, 6.0),
    new dvec3(7.0, 8.0, 9.0),
  );
  // Column first, then component — the same order the storage has.
  console.log(\`m \${m[0].x} \${m[1][2]} \${m[2][0]}\`);

  let w = new dvec3(0.0, 0.0, 0.0);
  w[0] = 5.0;
  w[2] = 7.0;
  console.log(\`w \${w.x} \${w.y} \${w.z}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(["v 1 2 3", "m 1 6 7", "w 5 0 7", ""].join("\n"));
        expect(result.leaked).toBe(0);
    });

    test("an index has to be a literal, and inside the type", async () => {
        // A computed index is refused rather than lowered: the components are
        // fields, and a padded type's are not even evenly spaced.
        await expectRejected(
            "linalg-index-computed",
            `import { dvec3 } from "std/linalg";

       export function main(): i32 {
         const v = new dvec3(1.0, 2.0, 3.0);
         let i: usize = 1;
         return cast<i32>(v[i]);
       }\n`,
            "GF0002",
        );

        await expectRejected(
            "linalg-index-range",
            `import { dvec3 } from "std/linalg";

       export function main(): i32 {
         const v = new dvec3(1.0, 2.0, 3.0);
         return cast<i32>(v[3]);
       }\n`,
            "GF0164",
        );

        // A padded type's fourth lane is padding, not a component, and saying
        // so is the whole reason the range check reads `components` rather than
        // `fields`.
        await expectRejected(
            "linalg-index-padding",
            `import { aligned_dvec3 } from "std/linalg";

       export function main(): i32 {
         const v = new aligned_dvec3(1.0, 2.0, 3.0);
         return cast<i32>(v[3]);
       }\n`,
            "GF0164",
        );
    });

    test("matrices and vectors of different shapes stay apart", async () => {
        await expectRejected(
            "matrix-shape-mismatch",
            `import { dmat4, dvec3 } from "std/linalg";

       export function main(): i32 {
         const m = dmat4.identity();
         return cast<i32>(m.mulVec(new dvec3(1.0, 2.0, 3.0)).x);
       }\n`,
            "TS2345",
        );
    });

    test("a projection exists on mat4 and nowhere else", async () => {
        await expectRejected(
            "matrix-no-projection-on-mat3",
            `import { dmat3 } from "std/linalg";

       export function main(): i32 {
         return cast<i32>(dmat3.perspective(1.0, 1.0, 1.0, 10.0).c0.x);
       }\n`,
            "TS2339",
        );
    });

    test("matrices live in arrays and structs like any other plain data", async () => {
        const result = await run(
            "matrix-aggregate",
            `import { dmat4, dvec3 } from "std/linalg";

interface Node {
  local: dmat4;
  world: dmat4;
}

export function main(): i32 {
  const stack: dmat4[] = [];
  stack.push(dmat4.fromTranslation(new dvec3(1.0, 0.0, 0.0)));
  stack.push(dmat4.fromTranslation(new dvec3(0.0, 2.0, 0.0)));

  let combined = dmat4.identity();
  for (let i: usize = 0; i < stack.length; i = i + 1) {
    combined = combined.mul(stack[i]);
  }
  console.log(\`combined \${combined.c3.x} \${combined.c3.y} \${combined.c3.z}\`);

  const n: Node = {local: dmat4.identity(), world: combined};
  console.log(\`node \${n.world.c3.y} \${sizeOf<Node>()}\`);
  return 0;
}
`,
        );
        expect(result.stdout).toBe(["combined 1 2 0", "node 2 256", ""].join("\n"));
        expect(result.leaked).toBe(0);
    });
});
