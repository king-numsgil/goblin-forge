/**
 * The struct-ABI differential suite.
 *
 * REWRITE-PLAN §9 asks for this "from day one, against a real `extern "C"`
 * library, checking layout agreement, by-value copy semantics, register
 * assignment around structs, and return ownership. In v1 this suite did not
 * exist and the by-value path was silently broken the whole time."
 *
 * `tests/oracle/cabi/cabi.cpp` is that library. The C compiler decides the
 * register assignment; this compiler has to agree, and every case here is a
 * branch of the classification:
 *
 * * **Win64** passes a struct of 1, 2, 4 or 8 bytes in one integer register and
 *   everything else by address.
 * * **System V** splits up to sixteen bytes into eightbytes, each INTEGER or
 *   SSE. `struct { float x, y; }` goes to one SSE register and
 *   `struct { int; float; }` to one integer register — getting that backwards
 *   is silent corruption rather than a crash (§6).
 *
 * The System V half is the reason this runs on Linux in CI. v1's was written
 * from the psABI and never executed; §6 is blunt that "the classification is
 * the part of a compiler where 'looks right' is worth nothing".
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
    const build = spawnSync(
        "cmake",
        ["--build", BUILD, "--config", "Release", "--target", "gfcabi"],
        {encoding: "utf8"},
    );
    if (build.status !== 0) {
        throw new Error(`cmake build failed:\n${build.stdout}${build.stderr}`);
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

/** The Goblin declarations of everything the C library exports. */
const DECLARATIONS = `
interface One { a: i8; }
interface Two { a: i8; b: i8; }
interface Four { a: i16; b: i16; }
interface Pair { x: i32; y: i32; }
interface TwoFloats { x: f32; y: f32; }
interface IntFloat { a: i32; b: f32; }
interface Twelve { a: i32; b: i32; c: i32; }
interface TwoDoubles { x: f64; y: f64; }
interface Big { a: i64; b: i64; c: i64; }
interface Nested { inner: Pair; tail: i32; }

declare function gf_c_add(a: i32, b: i32): i32;
declare function gf_c_add_narrow(a: i8, b: u8, c: i16, d: u16): i32;
declare function gf_c_scale(value: f64, by: f32): f64;

declare function gf_c_ret_i8(v: i32): i8;
declare function gf_c_ret_u8(v: i32): u8;
declare function gf_c_ret_i16(v: i32): i16;
declare function gf_c_ret_u16(v: i32): u16;
declare function gf_c_ret_bool(v: i32): boolean;

declare function gf_c_one(v: One): i32;
declare function gf_c_two(v: Two): i32;
declare function gf_c_four(v: Four): i32;
declare function gf_c_pair(v: Pair): i32;
declare function gf_c_two_floats(v: TwoFloats): f64;
declare function gf_c_int_float(v: IntFloat): f64;

declare function gf_c_make_one(a: i8): One;
declare function gf_c_make_pair(x: i32, y: i32): Pair;
declare function gf_c_make_two_floats(x: f32, y: f32): TwoFloats;
declare function gf_c_make_int_float(a: i32, b: f32): IntFloat;

declare function gf_c_twelve(v: Twelve): i32;
declare function gf_c_two_doubles(v: TwoDoubles): f64;
declare function gf_c_big(v: Big): i64;
declare function gf_c_nested(v: Nested): i32;

declare function gf_c_make_twelve(a: i32, b: i32, c: i32): Twelve;
declare function gf_c_make_two_doubles(x: f64, y: f64): TwoDoubles;
declare function gf_c_make_big(a: i64, b: i64, c: i64): Big;
declare function gf_c_make_nested(x: i32, y: i32, tail: i32): Nested;

declare function gf_c_clobber(v: Pair): i32;
declare function gf_c_many(a: Pair, b: Pair, c: Pair, d: Pair, e: Pair): i32;
declare function gf_c_mixed(a: i32, b: i32, c: i32, d: i32, e: Pair, f: i32): i32;

interface Vec3 { x: f64; y: f64; z: f64; }
interface Body { id: i32; position: Vec3; velocity: Vec3; }

declare function gf_c_vec3_length_sq(v: Pointer<Vec3>): f64;
declare function gf_c_vec3_set(v: Pointer<Vec3>, x: f64, y: f64, z: f64): void;
declare function gf_c_body_id(b: Pointer<Body>): i32;
declare function gf_c_body_step(b: Pointer<Body>, dt: f64): void;
declare function gf_c_body_position(b: Pointer<Body>): Pointer<Vec3>;
declare function gf_c_make_body(id: i32, x: f64, y: f64): Body;

declare function gf_c_try_divide(a: i32, b: i32, out: Pointer<i32>): boolean;
declare function gf_c_try_make_pair(x: i32, y: i32, out: Pointer<Pair>): boolean;

declare function gf_c_strlen(s: CString): i32;
declare function gf_c_str_equal(a: CString, b: CString): i32;
declare function gf_c_greeting(): CString;
declare function gf_c_copy_into(src: CString, dest: Pointer<u8>, cap: i32): i32;

declare function gf_c_apply(op: (a: i32, b: i32) => i32, a: i32, b: i32): i32;
declare function gf_c_fold(op: (a: i32, b: i32) => i32, values: Pointer<i32>, count: i32): i32;
declare function gf_c_apply_pair(op: (v: Pair) => Pair, x: i32, y: i32): i32;
`;

/**
 * Compile and run a body against the C library, returning its stdout.
 *
 * `prelude` goes above `main`, for the cases where C is the caller and this
 * side has to define the function it calls.
 */
async function acrossTheBoundary(
    name: string,
    body: string,
    prelude = "",
): Promise<string> {
    const result = await run(
        name,
        `${DECLARATIONS}
     ${prelude}
     export function main(): i32 {
       ${body}
       return 0;
     }\n`,
        {nativeLibs: [library]},
    );
    expect(result.stderr).toBe("");
    return result.stdout;
}

describe("scalars cross intact", () => {
    test("plain integers", async () => {
        expect(await acrossTheBoundary("abi-add", `console.log(\`\${gf_c_add(40, 2)}\`);`)).toBe(
            "42\n",
        );
    });

    test("sub-register widths carry their extension", async () => {
        // A callee compiled by a C compiler may use the whole register without
        // masking, so the caller has to sign- or zero-extend. Cranelift defaults to
        // neither, which is why this is asserted rather than assumed (§6).
        expect(
            await acrossTheBoundary(
                "abi-narrow",
                `console.log(\`\${gf_c_add_narrow(-1, 255, -1000, 60000)}\`);`,
            ),
        ).toBe(`${-1 + 255 - 1000 + 60000}\n`);
    });

    /**
     * The same question in the other direction, and the direction that was
     * wrong.
     *
     * A narrow *return* carries its extension on the result, not on a
     * parameter. The attribute is part of the call, not part of the type — and
     * the LLVM backend spelled the produced value with the attribute glued on,
     * so `store zeroext i8 %v, ptr %p` reached clang and was a parse error.
     * Nothing in this suite imported a C function with a narrow return, so
     * nothing caught it; an SDL3 program did, on `SDL_SubmitGPUCommandBuffer`,
     * which returns `bool`.
     *
     * Storing the result is what matters — a call whose value is used only as
     * an argument would have gone on working.
     */
    test("a narrow return carries its extension, and its value is still storable", async () => {
        expect(
            await acrossTheBoundary(
                "abi-narrow-return",
                `const a: i8 = gf_c_ret_i8(-1);
         const b: u8 = gf_c_ret_u8(200);
         const c: i16 = gf_c_ret_i16(-1000);
         const d: u16 = gf_c_ret_u16(60000);
         console.log(\`\${a} \${b} \${c} \${d}\`);`,
            ),
        ).toBe("-1 200 -1000 60000\n");
    });

    test("a C `bool` return round-trips and branches", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ret-bool",
                `const yes: boolean = gf_c_ret_bool(1);
         const no: boolean = gf_c_ret_bool(0);
         if (yes) { console.log("yes"); }
         if (!no) { console.log("no"); }`,
            ),
        ).toBe("yes\nno\n");
    });

    test("floats land in the float registers", async () => {
        expect(
            await acrossTheBoundary("abi-scale", `console.log(\`\${gf_c_scale(2.5, 4)}\`);`),
        ).toBe("10\n");
    });
});

describe("small structs travel in registers", () => {
    test("one byte", async () => {
        expect(
            await acrossTheBoundary("abi-one", `console.log(\`\${gf_c_one({ a: 7 })}\`);`),
        ).toBe("7\n");
    });

    test("two bytes", async () => {
        expect(
            await acrossTheBoundary("abi-two", `console.log(\`\${gf_c_two({ a: 3, b: 4 })}\`);`),
        ).toBe("304\n");
    });

    test("four bytes", async () => {
        expect(
            await acrossTheBoundary("abi-four", `console.log(\`\${gf_c_four({ a: 5, b: 6 })}\`);`),
        ).toBe("5006\n");
    });

    test("eight bytes, two integers", async () => {
        expect(
            await acrossTheBoundary("abi-pair", `console.log(\`\${gf_c_pair({ x: 12, y: 34 })}\`);`),
        ).toBe("12034\n");
    });

    test("eight bytes, two floats — one SSE register on System V", async () => {
        expect(
            await acrossTheBoundary(
                "abi-two-floats",
                `console.log(\`\${gf_c_two_floats({ x: 2, y: 5 })}\`);`,
            ),
        ).toBe("2005\n");
    });

    test("eight bytes, mixed — one integer register on System V", async () => {
        // One integer anywhere in an eightbyte makes the whole eightbyte INTEGER.
        // This and the previous test are the pair that catches the classification
        // being backwards.
        expect(
            await acrossTheBoundary(
                "abi-int-float",
                `console.log(\`\${gf_c_int_float({ a: 3, b: 7 })}\`);`,
            ),
        ).toBe("3007\n");
    });
});

describe("large structs travel by address or on the stack", () => {
    test("twelve bytes", async () => {
        expect(
            await acrossTheBoundary(
                "abi-twelve",
                `console.log(\`\${gf_c_twelve({ a: 1, b: 2, c: 3 })}\`);`,
            ),
        ).toBe("10203\n");
    });

    test("sixteen bytes of floats", async () => {
        expect(
            await acrossTheBoundary(
                "abi-two-doubles",
                `console.log(\`\${gf_c_two_doubles({ x: 4, y: 9 })}\`);`,
            ),
        ).toBe("4009\n");
    });

    test("twenty-four bytes", async () => {
        expect(
            await acrossTheBoundary(
                "abi-big",
                `console.log(\`\${gf_c_big({ a: 1, b: 2, c: 3 })}\`);`,
            ),
        ).toBe("10203\n");
    });

    test("a nested aggregate flattens through", async () => {
        expect(
            await acrossTheBoundary(
                "abi-nested",
                `console.log(\`\${gf_c_nested({ inner: { x: 1, y: 2 }, tail: 3 })}\`);`,
            ),
        ).toBe("10203\n");
    });
});

describe("structs come back", () => {
    test("one byte", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ret-one",
                `const v: One = gf_c_make_one(9);
         console.log(\`\${v.a}\`);`,
            ),
        ).toBe("9\n");
    });

    test("eight bytes of integers", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ret-pair",
                `const v: Pair = gf_c_make_pair(11, 22);
         console.log(\`\${v.x} \${v.y}\`);`,
            ),
        ).toBe("11 22\n");
    });

    test("eight bytes of floats", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ret-two-floats",
                `const v: TwoFloats = gf_c_make_two_floats(1.5, 2.5);
         console.log(\`\${v.x} \${v.y}\`);`,
            ),
        ).toBe("1.5 2.5\n");
    });

    test("eight bytes, mixed", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ret-int-float",
                `const v: IntFloat = gf_c_make_int_float(4, 0.5);
         console.log(\`\${v.a} \${v.b}\`);`,
            ),
        ).toBe("4 0.5\n");
    });

    test("twelve bytes", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ret-twelve",
                `const v: Twelve = gf_c_make_twelve(1, 2, 3);
         console.log(\`\${v.a} \${v.b} \${v.c}\`);`,
            ),
        ).toBe("1 2 3\n");
    });

    test("sixteen bytes of floats", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ret-two-doubles",
                `const v: TwoDoubles = gf_c_make_two_doubles(1.25, 2.75);
         console.log(\`\${v.x} \${v.y}\`);`,
            ),
        ).toBe("1.25 2.75\n");
    });

    test("twenty-four bytes, through a hidden pointer", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ret-big",
                `const v: Big = gf_c_make_big(7, 8, 9);
         console.log(\`\${v.a} \${v.b} \${v.c}\`);`,
            ),
        ).toBe("7 8 9\n");
    });

    test("a nested aggregate", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ret-nested",
                `const v: Nested = gf_c_make_nested(1, 2, 3);
         console.log(\`\${v.inner.x} \${v.inner.y} \${v.tail}\`);`,
            ),
        ).toBe("1 2 3\n");
    });
});

describe("by-value means the caller keeps its own", () => {
    test("a callee mutating its parameter does not reach back", async () => {
        // The by-value path v1 had silently broken the whole time, because nothing
        // exercised it.
        expect(
            await acrossTheBoundary(
                "abi-clobber",
                `const mine: Pair = { x: 1, y: 2 };
         const theirs: i32 = gf_c_clobber(mine);
         console.log(\`\${theirs} \${mine.x} \${mine.y}\`);`,
            ),
        ).toBe("1998 1 2\n");
    });

    test("more structs than fit in registers", async () => {
        expect(
            await acrossTheBoundary(
                "abi-many",
                `const p: Pair = { x: 1, y: 2 };
         console.log(\`\${gf_c_many(p, p, p, p, p)}\`);`,
            ),
        ).toBe("15\n");
    });

    test("a struct after the integer registers are spoken for", async () => {
        expect(
            await acrossTheBoundary(
                "abi-mixed",
                `console.log(\`\${gf_c_mixed(1, 2, 3, 4, { x: 5, y: 6 }, 7)}\`);`,
            ),
        ).toBe("28\n");
    });
});

/**
 * The half of the boundary the by-value suite above never reaches.
 *
 * Every case up to here has Goblin handing a struct *to* C by value, which is
 * what the classification decides and what REWRITE-PLAN §9 asked for. Real C
 * libraries mostly do not work that way: they hand out pointers, take them
 * back, write through out-parameters, exchange `const char *`, and call back
 * into you. None of that was covered, and an SDL3 program found a hole in it
 * within its first few lines.
 */
describe("the pointer-shaped half of C", () => {
    test("a struct is read through a pointer", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ptr-read",
                `const v: Pointer<Vec3> = alloc<Vec3>({x: 3, y: 4, z: 12});
         console.log(\`\${gf_c_vec3_length_sq(v)}\`);
         v.free();`,
            ),
        ).toBe("169\n");
    });

    test("C writes through a pointer and the caller sees it", async () => {
        // The opposite of `gf_c_clobber`: a by-value argument must *not* reach
        // the caller's copy, and a pointer argument must.
        expect(
            await acrossTheBoundary(
                "abi-ptr-write",
                `const v: Pointer<Vec3> = alloc<Vec3>({x: 0, y: 0, z: 0});
         gf_c_vec3_set(v, 1.5, 2.5, 3.5);
         console.log(\`\${v.x} \${v.y} \${v.z}\`);
         v.free();`,
            ),
        ).toBe("1.5 2.5 3.5\n");
    });

    test("a nested struct is reached through a pointer, by both sides", async () => {
        // `position` starts at an offset that is the sum of two layouts. If
        // this compiler and the C compiler disagree about it, the numbers are
        // plausible and wrong rather than absent.
        expect(
            await acrossTheBoundary(
                "abi-ptr-nested",
                `const b: Pointer<Body> = alloc<Body>({
           id: 7,
           position: {x: 10, y: 20, z: 30},
           velocity: {x: 1, y: 2, z: 3},
         });
         gf_c_body_step(b, 2);
         console.log(\`\${gf_c_body_id(b)} \${b.position.x} \${b.position.y} \${b.position.z}\`);
         b.free();`,
            ),
        ).toBe("7 12 24 36\n");
    });

    test("a pointer into the middle of a struct agrees with the field's offset", async () => {
        expect(
            await acrossTheBoundary(
                "abi-ptr-interior",
                `const b: Pointer<Body> = alloc<Body>({
           id: 1,
           position: {x: 3, y: 4, z: 0},
           velocity: {x: 0, y: 0, z: 0},
         });
         const p: Pointer<Vec3> = gf_c_body_position(b);
         console.log(\`\${gf_c_vec3_length_sq(p)} \${p.x}\`);
         b.free();`,
            ),
        ).toBe("25 3\n");
    });

    test("a nested struct returned by value", async () => {
        expect(
            await acrossTheBoundary(
                "abi-nested-return",
                `const b: Body = gf_c_make_body(9, 1.5, 2.5);
         console.log(\`\${b.id} \${b.position.x} \${b.position.y} \${b.velocity.z}\`);`,
            ),
        ).toBe("9 1.5 2.5 3\n");
    });

    test("an out-parameter, with a narrow result saying whether it was written", async () => {
        // The shape C uses for anything that can fail, and the one that pairs a
        // `bool` return with a pointer write.
        expect(
            await acrossTheBoundary(
                "abi-outparam",
                `const slot: Pointer<i32> = alloc<i32>();
         const ok: boolean = gf_c_try_divide(84, 2, slot);
         const bad: boolean = gf_c_try_divide(1, 0, slot);
         console.log(\`\${ok} \${bad} \${slot[0]}\`);
         slot.free();`,
            ),
        ).toBe("true false 42\n");
    });

    test("a struct filled through an out-parameter", async () => {
        expect(
            await acrossTheBoundary(
                "abi-outparam-struct",
                `const slot: Pointer<Pair> = alloc<Pair>({x: 0, y: 0});
         const ok: boolean = gf_c_try_make_pair(3, 8, slot);
         console.log(\`\${ok} \${slot.x} \${slot.y}\`);
         slot.free();`,
            ),
        ).toBe("true 3 8\n");
    });
});

describe("strings across the boundary", () => {
    test("a Goblin string is *borrowed* as a `const char *`", async () => {
        // No `cstringFree`. Without `move` the `string` still owns the bytes and
        // still releases them at the end of its scope, so the `CString` is a
        // borrow that dies with it. Freeing here is a double free, and the
        // automatic live-allocation check reports it as a *negative* count —
        // which is how this test was written wrong the first time.
        expect(
            await acrossTheBoundary(
                "abi-str-borrow",
                `const s: string = "hello" + " there";
         console.log(\`\${gf_c_strlen(cstring(s))}\`);`,
            ),
        ).toBe("11\n");
    });

    test("`cstring(move(s))` hands the bytes over, and `cstringFree` takes them back", async () => {
        // The other half of the same rule, and the only shape `cstringFree` is
        // for: nothing releases the bytes any more, so this leaks unless the C
        // side frees them or this line does.
        expect(
            await acrossTheBoundary(
                "abi-str-move",
                `const s: string = "hello" + " there";
         const c: CString = cstring(move(s));
         console.log(\`\${gf_c_strlen(c)}\`);
         cstringFree(c);`,
            ),
        ).toBe("11\n");
    });

    test("two C strings compare, one built and one static", async () => {
        expect(
            await acrossTheBoundary(
                "abi-str-compare",
                `const a: CString = cstring("hello from C");
         const same: i32 = gf_c_str_equal(a, gf_c_greeting());
         const different: i32 = gf_c_str_equal(a, cstring("something else"));
         console.log(\`\${same} \${different}\`);`,
            ),
        ).toBe("1 0\n");
    });

    test("a `const char *` from C becomes a Goblin string", async () => {
        // The static-storage case, and the ownership question at this boundary:
        // whoever receives this must not free it, so `stringFromCString` copies.
        expect(
            await acrossTheBoundary(
                "abi-str-in",
                `const greeting: string = stringFromCString(gf_c_greeting());
         console.log(greeting + \`, length \${greeting.length}\`);`,
            ),
        ).toBe("hello from C, length 12\n");
    });

    test("C writes into storage this side owns", async () => {
        expect(
            await acrossTheBoundary(
                "abi-str-buffer",
                `const buffer: Pointer<u8> = allocArray<u8>(32);
         const written: i32 = gf_c_copy_into(gf_c_greeting(), buffer, 32);
         console.log(\`\${written} \${stringFromCString(buffer)}\`);
         buffer.free();`,
            ),
        ).toBe("12 hello from C\n");
    });
});

describe("C calling back into Goblin", () => {
    test("a callback taking scalars", async () => {
        // Every other case here has Goblin as the caller. This one has the C
        // library applying the convention to a function *this* compiler
        // defined, which is the other half of the same agreement.
        expect(
            await acrossTheBoundary(
                "abi-callback",
                `console.log(\`\${gf_c_apply(add, 40, 2)}\`);`,
                `function add(a: i32, b: i32): i32 { return a + b; }\n`,
            ),
        ).toBe("42\n");
    });

    test("a callback invoked repeatedly over a buffer", async () => {
        expect(
            await acrossTheBoundary(
                "abi-callback-fold",
                `const values: Pointer<i32> = allocArray<i32>(4);
         values[0] = 1; values[1] = 2; values[2] = 3; values[3] = 4;
         console.log(\`\${gf_c_fold(add, values, 4)}\`);
         values.free();`,
                `function add(a: i32, b: i32): i32 { return a + b; }\n`,
            ),
        ).toBe("10\n");
    });

    test("a callback taking and returning a struct", async () => {
        // The classification applies on the way in *and* the way out of a
        // function this compiler defined, with C on the other side of both.
        expect(
            await acrossTheBoundary(
                "abi-callback-pair",
                `console.log(\`\${gf_c_apply_pair(swap, 3, 8)}\`);`,
                `function swap(v: Pair): Pair { return { x: v.y, y: v.x }; }\n`,
            ),
        ).toBe("8003\n");
    });
});
