/**
 * Layout, differentially against a C compiler.
 *
 * REWRITE-PLAN §6: **differential-test the layout, do not assert it.** v1's
 * struct-ABI suite asks the C compiler for `size_of` and `offset_of` and
 * compares, and that pattern is the reason its layout code is the best-tested
 * part of the project.
 *
 * `tests/oracle/layout/layout.cpp` declares each shape in C++ and prints what
 * the C compiler decided. The same shapes are built here as MIR, and the
 * backend's layout engine is asked directly — the same computation code
 * generation uses, not a reimplementation of it.
 *
 * The nested cases are the ones that matter most. A nested aggregate is
 * **inline**: it occupies its own layout inside the parent rather than a
 * pointer to itself. That is what C interop depends on, and v1 had to be
 * retrofitted for it.
 */

import { Backend, encodeModule, type LayoutReport, ModuleBuilder, type TyId } from "@goblin-forge/backend";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, "oracle", "build");

/** What the C compiler said, keyed by shape name. */
interface CLayout {
    readonly size: number;
    readonly align: number;
    readonly offsets: readonly number[];
}

function cLayouts(): Map<string, CLayout> {
    const configure = spawnSync("cmake", ["-S", join(HERE, "oracle"), "-B", BUILD], {
        encoding: "utf8",
    });
    if (configure.status !== 0) {
        throw new Error(`cmake configure failed:\n${configure.stdout}${configure.stderr}`);
    }
    const build = spawnSync("cmake", ["--build", BUILD, "--config", "Release"], {
        encoding: "utf8",
    });
    if (build.status !== 0) {
        throw new Error(`cmake build failed:\n${build.stdout}${build.stderr}`);
    }

    const executable = [
        join(BUILD, "bin", "layout.exe"),
        join(BUILD, "bin", "layout"),
    ].find((candidate) => existsSync(candidate));
    if (executable === undefined) {
        throw new Error(`the layout oracle was not built into ${BUILD}`);
    }

    const run = spawnSync(executable, [], {encoding: "utf8"});
    if (run.status !== 0) {
        throw new Error(`the layout oracle exited ${run.status}`);
    }

    const out = new Map<string, CLayout>();
    for (const line of (run.stdout ?? "").split(/\r?\n/)) {
        if (line.trim().length === 0) {
            continue;
        }
        const [name, size, align, offsets] = line.split("|");
        out.set(name!, {
            size: Number(size),
            align: Number(align),
            offsets: (offsets ?? "")
                .split(",")
                .filter((piece) => piece.length > 0)
                .map(Number),
        });
    }
    return out;
}

/**
 * The same shapes, as MIR.
 *
 * Declared in the same order and with the same field order as the C++ file:
 * fields are laid out in declaration order and never reordered, so the order
 * here is part of what is being tested.
 */
function goblinLayouts(): Map<string, LayoutReport> {
    const m = new ModuleBuilder("layout");
    const t = {
        i8: m.ty({kind: "Int", value: "I8"}),
        i16: m.ty({kind: "Int", value: "I16"}),
        i32: m.ty({kind: "Int", value: "I32"}),
        i64: m.ty({kind: "Int", value: "I64"}),
        u8: m.ty({kind: "Int", value: "U8"}),
        u16: m.ty({kind: "Int", value: "U16"}),
        u32: m.ty({kind: "Int", value: "U32"}),
        u64: m.ty({kind: "Int", value: "U64"}),
        f32: m.ty({kind: "Float", value: "F32"}),
        f64: m.ty({kind: "Float", value: "F64"}),
        bool: m.ty({kind: "Bool"}),
        str: m.ty({kind: "Str"}),
    };

    // Named `shape` rather than `declare`: a statement beginning with `declare`
    // is parsed as an ambient declaration and erased, so `shape("Scalars", …)`
    // compiles to nothing at all and the shape silently stops being tested.
    const shape = (name: string, fields: [string, TyId][]): TyId => {
        const id = m.struct({name, fields: fields.map(([n, ty]) => ({name: n, ty}))});
        return m.ty({kind: "Struct", value: id});
    };

    shape("Scalars", [
        ["a", t.i32],
        ["b", t.i32],
    ]);
    shape("Padded", [
        ["a", t.i8],
        ["b", t.i32],
        ["c", t.i8],
    ]);
    shape("WideThenNarrow", [
        ["a", t.f64],
        ["b", t.i8],
    ]);
    const inner = shape("Inner", [
        ["a", t.i16],
        ["b", t.i16],
    ]);
    const nested = shape("Nested", [
        ["before", t.i8],
        ["inner", inner],
        ["after", t.i8],
    ]);
    shape("DeeplyNested", [
        ["outer", nested],
        ["tail", t.f64],
    ]);
    // A `string` is one machine word, exactly as `const char*` is.
    shape("WithHandles", [
        ["text", t.str],
        ["n", t.i32],
    ]);
    shape("AllTheWidths", [
        ["i8", t.i8],
        ["i16", t.i16],
        ["i32", t.i32],
        ["i64", t.i64],
        ["u8", t.u8],
        ["u16", t.u16],
        ["u32", t.u32],
        ["u64", t.u64],
        ["f32", t.f32],
        ["f64", t.f64],
    ]);
    shape("BoolAndFloat", [
        ["flag", t.bool],
        ["value", t.f32],
    ]);
    shape("OneField", [["only", t.i64]]);

    const backend = new Backend({
        optLevel: "none",
        debugInfo: false,
        checked: false,
        strictInternalErrors: true,
    });
    const reports = backend.describeLayouts(encodeModule(m.finish()));

    const out = new Map<string, LayoutReport>();
    for (const report of reports) {
        out.set(report.name, report);
    }
    return out;
}

const fromC = cLayouts();
const fromGoblin = goblinLayouts();

describe("layout agrees with the C compiler", () => {
    for (const [name, expected] of fromC) {
        test(name, () => {
            const actual = fromGoblin.get(name);
            expect(actual).toBeDefined();
            expect({
                name,
                size: actual!.size,
                align: actual!.align,
                offsets: actual!.fieldOffsets,
            }).toEqual({
                name,
                size: expected.size,
                align: expected.align,
                offsets: [...expected.offsets],
            });
        });
    }

    test("every C shape has a Goblin counterpart", () => {
        // A shape added to the C++ file and not here would otherwise reduce
        // coverage silently.
        expect([...fromC.keys()].filter((name) => !fromGoblin.has(name))).toEqual([]);
    });
});

describe("stride", () => {
    test("is the size rounded up to the alignment", () => {
        // An array of structs allocated with one number and indexed with another
        // overlaps its own elements, and prints plausible values for a while
        // (REWRITE-PLAN §10). `Padded` is 12 bytes with 4-byte alignment, so its
        // stride is 12 — but the trailing padding is what makes that true.
        const padded = fromGoblin.get("Padded")!;
        expect(padded.stride).toBe(padded.size);
        expect(padded.size % padded.align).toBe(0);

        for (const report of fromGoblin.values()) {
            expect({name: report.name, ok: report.stride >= report.size}).toEqual({
                name: report.name,
                ok: true,
            });
        }
    });
});
