/**
 * Vertex blobs across the C boundary.
 *
 * The question this file exists to answer: **can a run of structs containing
 * `std/linalg` types be handed to C as a pointer, a count and a stride?** That
 * is what a vertex buffer and a uniform buffer are, and if the answer is no
 * then the whole module is a toy.
 *
 * The check is deliberately not "does `sizeOf` return 24". `tests/oracle/cabi`
 * is compiled by the *platform's* C++ compiler and declares its own `Vertex`
 * as `float pos[3]; float uv[2]; uint32_t mat;` — nothing about the Goblin
 * declaration reaches it. So every assertion here is agreement between two
 * compilers that have never seen each other's types, which is the only kind of
 * layout assertion worth making.
 *
 * `float pos[3]` on the C side is the point: what a `fvec3` has to *be*, for
 * this to work, is three floats and no padding. An `aligned_fvec3` would be
 * four and would silently misalign every vertex after the first — which is
 * why the padded types are also tested here, against a stride that says so.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORACLE = join(HERE, "oracle");
const BUILD = join(ORACLE, "build");

let library = "";

beforeAll(() => {
    const configure = spawnSync("cmake", ["-S", ORACLE, "-B", BUILD], {encoding: "utf8"});
    if (configure.status !== 0) {
        throw new Error(`cmake configure failed:\n${configure.stdout}${configure.stderr}`);
    }
    const built = spawnSync(
        "cmake",
        ["--build", BUILD, "--config", "Release", "--target", "gfcabi"],
        {encoding: "utf8"},
    );
    if (built.status !== 0) {
        throw new Error(`cmake build failed:\n${built.stdout}${built.stderr}`);
    }
    const found = [
        join(BUILD, "lib", "gfcabi.lib"),
        join(BUILD, "lib", "libgfcabi.a"),
        join(BUILD, "lib", "Release", "gfcabi.lib"),
    ].find((candidate) => existsSync(candidate));
    if (found === undefined) {
        throw new Error(`the C ABI library was not built into ${BUILD}`);
    }
    library = found;
});

const DECLARATIONS = `import { fvec2, fvec3, fmat4, aligned_fvec3, dvec3 } from "std/linalg";

declare function gf_c_vertex_size(): i32;
declare function gf_c_vertex_align(): i32;
declare function gf_c_vertex_offset_uv(): i32;
declare function gf_c_vertex_offset_mat(): i32;
declare function gf_c_vertex_read(
  data: Pointer<unknown>, index: i32, stride: i32, field: i32,
): f64;
declare function gf_c_vertex_write(
  data: Pointer<unknown>, index: i32, stride: i32,
  x: f32, y: f32, z: f32, u: f32, v: f32, mat: u32,
): void;
declare function gf_c_vertex_sum_mat(
  data: Pointer<unknown>, count: i32, stride: i32,
): u32;
declare function gf_c_mat4_element(data: Pointer<unknown>, index: i32): f64;
declare function gf_c_mat4_size(): i32;

interface Vertex {
  pos: fvec3;
  uv: fvec2;
  mat: u32;
}

function f(x: f64): f32 { return cast<f32>(x); }
`;

async function acrossTheBoundary(name: string, body: string): Promise<string> {
    const result = await run(
        name,
        `${DECLARATIONS}
export function main(): i32 {
${body}
  return 0;
}
`,
        {nativeLibs: [library]},
    );
    expect(result.stderr).toBe("");
    expect(result.leaked).toBe(0);
    return result.stdout;
}

describe("vertex blobs reach C", () => {
    test("two compilers agree on the layout of a struct of vectors", async () => {
        // Neither side was told the other's answer. `sizeOf<Vertex>()` comes
        // from `layout.rs`; `sizeof(Vertex)` comes from MSVC or GCC.
        const out = await acrossTheBoundary(
            "blob-agree",
            `  console.log(\`size \${sizeOf<Vertex>()} \${gf_c_vertex_size()}\`);
  console.log(\`align \${alignOf<Vertex>()} \${gf_c_vertex_align()}\`);
  console.log(\`uv \${gf_c_vertex_offset_uv()} mat \${gf_c_vertex_offset_mat()}\`);
  console.log(\`parts \${sizeOf<fvec3>()} \${sizeOf<fvec2>()}\`);`,
        );
        expect(out).toBe(
            ["size 24 24", "align 4 4", "uv 12 mat 20", "parts 12 8", ""].join("\n"),
        );
    });

    test("a fixed array of vertices is a blob C can stride through", async () => {
        // The shape a vertex buffer is: inline storage, no allocation, handed
        // over as an address and a stride.
        const out = await acrossTheBoundary(
            "blob-fixed",
            `  const mesh: FixedArray<Vertex, 100> = fixedArray(100, zeroed<Vertex>());
  mesh[50] = {
    pos: new fvec3(f(1.0), f(2.0), f(3.0)),
    uv: new fvec2(f(4.0), f(5.0)),
    mat: 123,
  };
  mesh[99] = {
    pos: new fvec3(f(-1.0), f(-2.0), f(-3.0)),
    uv: new fvec2(f(0.5), f(0.25)),
    mat: 7,
  };

  const stride = cast<i32>(sizeOf<Vertex>());
  console.log(\`v50 \${gf_c_vertex_read(mesh, 50, stride, 0)} \${gf_c_vertex_read(mesh, 50, stride, 2)} \${gf_c_vertex_read(mesh, 50, stride, 4)} \${gf_c_vertex_read(mesh, 50, stride, 5)}\`);
  console.log(\`v99 \${gf_c_vertex_read(mesh, 99, stride, 0)} \${gf_c_vertex_read(mesh, 99, stride, 3)} \${gf_c_vertex_read(mesh, 99, stride, 5)}\`);
  console.log(\`v0 \${gf_c_vertex_read(mesh, 0, stride, 0)} \${gf_c_vertex_read(mesh, 0, stride, 5)}\`);
  console.log(\`sum \${gf_c_vertex_sum_mat(mesh, 100, stride)}\`);`,
        );
        expect(out).toBe(
            [
                "v50 1 3 5 123",
                "v99 -1 0.5 7",
                // `zeroed` really did zero the whole array, not just its head.
                "v0 0 0",
                "sum 130",
                "",
            ].join("\n"),
        );
    });

    test("C writes into the blob and Goblin reads it back", async () => {
        // The other direction, which is what a mapped GPU buffer or a loader
        // does. If the two disagreed about `uv`'s offset this would read a
        // component of `pos`.
        const out = await acrossTheBoundary(
            "blob-writeback",
            `  const mesh: FixedArray<Vertex, 8> = fixedArray(8, zeroed<Vertex>());
  const stride = cast<i32>(sizeOf<Vertex>());
  gf_c_vertex_write(mesh, 3, stride, f(9.0), f(8.0), f(7.0), f(0.5), f(0.25), 42);

  const v = mesh[3];
  console.log(\`pos \${v.pos.x} \${v.pos.y} \${v.pos.z}\`);
  console.log(\`uv \${v.uv.x} \${v.uv.y} mat \${v.mat}\`);

  // And the vector arithmetic works on what C wrote.
  console.log(\`len \${v.pos.lengthSq()}\`);
  console.log(\`untouched \${mesh[2].mat} \${mesh[4].mat}\`);`,
        );
        expect(out).toBe(
            ["pos 9 8 7", "uv 0.5 0.25 mat 42", "len 194", "untouched 0 0", ""].join("\n"),
        );
    });

    test("a heap array of vertices works the same way", async () => {
        // The other shape a mesh takes: sized at run time, freed by hand.
        const out = await acrossTheBoundary(
            "blob-heap",
            `  const count: usize = 64;
  const mesh = allocArray<Vertex>(count);
  mesh[10] = {
    pos: new fvec3(f(1.5), f(2.5), f(3.5)),
    uv: new fvec2(f(6.0), f(7.0)),
    mat: 5,
  };
  const stride = cast<i32>(sizeOf<Vertex>());
  console.log(\`heap \${gf_c_vertex_read(mesh.erase(), 10, stride, 0)} \${gf_c_vertex_read(mesh.erase(), 10, stride, 3)} \${gf_c_vertex_read(mesh.erase(), 10, stride, 5)}\`);
  mesh.freeArray();`,
        );
        expect(out).toBe(["heap 1.5 6 5", ""].join("\n"));
    });

    test("a matrix is column-major bytes a shader can consume", async () => {
        // A uniform buffer. The translation of an affine `mat4` sits at
        // elements 12, 13, 14 in column-major order — which is exactly what
        // every shader indexes, and would be at 3, 7, 11 if the storage were
        // row-major.
        // A one-element `FixedArray` is how a value gets an address here:
        // there is no address-of for a local, so a uniform block is storage
        // that was always addressable rather than a local that becomes so.
        const out = await acrossTheBoundary(
            "blob-mat4",
            `  const block: FixedArray<fmat4, 1> = fixedArray(1, fmat4.identity());
  block[0] = fmat4.fromTranslation(new fvec3(f(10.0), f(20.0), f(30.0)));

  console.log(\`size \${sizeOf<fmat4>()} \${gf_c_mat4_size()}\`);
  console.log(\`diag \${gf_c_mat4_element(block, 0)} \${gf_c_mat4_element(block, 5)} \${gf_c_mat4_element(block, 10)} \${gf_c_mat4_element(block, 15)}\`);
  console.log(\`translate \${gf_c_mat4_element(block, 12)} \${gf_c_mat4_element(block, 13)} \${gf_c_mat4_element(block, 14)}\`);
  console.log(\`offdiag \${gf_c_mat4_element(block, 1)} \${gf_c_mat4_element(block, 3)}\`);`,
        );
        expect(out).toBe(
            ["size 64 64", "diag 1 1 1 1", "translate 10 20 30", "offdiag 0 0", ""].join("\n"),
        );
    });

    test("a padded vector is a different stride, and says so", async () => {
        // The trap the `aligned_` prefix exists to make visible. A vertex laid
        // out with `aligned_fvec3` is 16 bytes wider per vertex than the packed
        // one, and handing a GPU the packed stride for a padded buffer reads
        // every vertex after the first from the wrong place.
        const out = await acrossTheBoundary(
            "blob-padded",
            `  console.log(\`packed \${sizeOf<fvec3>()} padded \${sizeOf<aligned_fvec3>()}\`);
  console.log(\`double \${sizeOf<dvec3>()}\`);

  // The C side's \`Vertex\` is the packed one, so reading a padded buffer with
  // the packed stride is exactly the mistake — and the numbers differ, which
  // is what makes it catchable.
  const stride = cast<i32>(sizeOf<Vertex>());
  const mesh: FixedArray<Vertex, 4> = fixedArray(4, zeroed<Vertex>());
  mesh[1] = {pos: new fvec3(f(1.0), f(0.0), f(0.0)), uv: new fvec2(f(0.0), f(0.0)), mat: 1};
  console.log(\`right \${gf_c_vertex_read(mesh, 1, stride, 0)}\`);
  console.log(\`wrong \${gf_c_vertex_read(mesh, 1, stride + 4, 0)}\`);`,
        );
        expect(out).toBe(
            ["packed 12 padded 16", "double 24", "right 1", "wrong 0", ""].join("\n"),
        );
    });
});
