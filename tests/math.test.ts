/**
 * `std/math` — scalar maths, two of everything.
 *
 * The module's whole design question is the prefix: `dsin` is `f64` and `fsin`
 * is `f32`, and there is no unprefixed spelling that would have to pick one.
 * So the tests that matter most here are not the ones checking that `dsqrt(4)`
 * is `2` — they are the ones checking that the two widths stay apart, and that
 * a name declared in the prelude is a symbol that exists.
 *
 * **Values are asserted by tolerance, computed inside the program**, not by
 * comparing printed digits. The implementation is a MUSL port compiled into the
 * runtime, so the bits genuinely are the same on every target and the digits
 * *could* be asserted — but that would pin this suite to a dependency's last
 * ulp, and the last ulp is not what any of these tests are about. Where a value
 * is exact in binary — `dsqrt(4)`, `dfloor(-2.5)` — it is compared exactly.
 */

import { describe, expect, test } from "bun:test";

import { expectRejected, run } from "./harness.ts";

describe("std/math", () => {
    test("every name the prelude declares is a symbol that exists", async () => {
        // The one test that has to be exhaustive. A name declared here and
        // missing from `STD_MODULES` is a `GF0001`; a name whose symbol is
        // misspelled is an unresolved external with no file and no line — the
        // failure the allowlist exists to prevent, arriving through it. Calling
        // all seventy-two is what turns both into a failure right here.
        const unary = [
            "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
            "exp", "exp2", "log", "log2", "log10", "sqrt", "cbrt",
            "floor", "ceil", "round", "trunc", "abs",
        ];
        const binary = ["atan2", "pow", "hypot", "fmod", "min", "max", "copysign"];
        const predicate = ["isnan", "isinf", "isfinite"];
        const constant = ["pi", "tau", "e", "inf", "nan"];

        const names = [
            ...unary.map((n) => `d${n}`), ...binary.map((n) => `d${n}`),
            ...predicate.map((n) => `d${n}`), ...constant.map((n) => `d${n}`),
            ...unary.map((n) => `f${n}`), ...binary.map((n) => `f${n}`),
            ...predicate.map((n) => `f${n}`), ...constant.map((n) => `f${n}`),
        ];

        const body = [
            ...unary.map((n) => `  d = d + d${n}(0.5);`),
            ...binary.map((n) => `  d = d + d${n}(0.5, 0.25);`),
            ...predicate.map((n) => `  if (d${n}(0.5)) { d = d + 1.0; }`),
            ...constant.map((n) => `  if (disfinite(d${n}())) { d = d + 1.0; }`),
            ...unary.map((n) => `  f = f + f${n}(cast<f32>(0.5));`),
            ...binary.map((n) => `  f = f + f${n}(cast<f32>(0.5), cast<f32>(0.25));`),
            ...predicate.map((n) => `  if (f${n}(cast<f32>(0.5))) { f = f + cast<f32>(1.0); }`),
            ...constant.map((n) => `  if (fisfinite(f${n}())) { f = f + cast<f32>(1.0); }`),
        ].join("\n");

        const result = await run(
            "math-every-name",
            `import { ${names.join(", ")} } from "std/math";

export function main(): i32 {
  let d: f64 = 0.0;
  let f: f32 = cast<f32>(0.0);
${body}
  console.log(disnan(d) ? "d nan" : "d number");
  console.log(fisnan(f) ? "f nan" : "f number");
  return 0;
}
`,
        );
        expect(result.stdout).toBe("d number\nf number\n");
        expect(result.leaked).toBe(0);
    });

    test("the two widths are different functions, and tsc keeps them apart", async () => {
        // The reason for the prefix. An `f64` handed to the `f32` function is
        // refused by the *type checker*, not by a rule of this compiler's —
        // which is what makes the narrowing something you write rather than
        // something that happens to you.
        await expectRejected(
            "math-width-mixed",
            `import { fsqrt } from "std/math";

       export function main(): i32 {
         const wide: f64 = 2.0;
         return cast<i32>(fsqrt(wide));
       }\n`,
            "TS2345",
        );
    });

    test("the widths really are different precisions", async () => {
        // Not a formality: `fsqrt` computes in 32 bits and the answer differs
        // where an `f64` has digits left. If this ever printed "same", the two
        // families would be one function wearing two names.
        const result = await run(
            "math-precision",
            `import { dabs, dsqrt, fsqrt } from "std/math";

       export function main(): i32 {
         const wide = dsqrt(2.0);
         const narrow = cast<f64>(fsqrt(cast<f32>(2.0)));
         console.log(dabs(wide - narrow) > 0.000000001 ? "different" : "same");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("different\n");
        expect(result.leaked).toBe(0);
    });

    test("the exact values are exact", async () => {
        // Everything here is representable in binary, so these are equalities
        // rather than tolerances — and a failure is a wrong function, not a
        // rounding difference.
        const result = await run(
            "math-exact",
            `import { dabs, dceil, dfloor, dpow, dround, dsqrt, dtrunc } from "std/math";

       export function main(): i32 {
         if (dsqrt(4.0) !== 2.0) { return 1; }
         if (dpow(2.0, 10.0) !== 1024.0) { return 2; }
         if (dfloor(-2.5) !== -3.0) { return 3; }
         if (dceil(-2.5) !== -2.0) { return 4; }
         if (dtrunc(-2.5) !== -2.0) { return 5; }
         // Away from zero at the halfway point, as C rounds and unlike the
         // banker's rounding a reader might expect.
         if (dround(-2.5) !== -3.0) { return 6; }
         if (dround(2.5) !== 3.0) { return 7; }
         if (dabs(-2.5) !== 2.5) { return 8; }
         console.log("exact");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("exact\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("the transcendentals land where they should", async () => {
        const result = await run(
            "math-transcendental",
            `import { dabs, dcos, de, dexp, dlog, dpi, dsin } from "std/math";

       export function main(): i32 {
         const tiny: f64 = 0.000000000000001;
         if (dabs(dsin(dpi())) > tiny) { return 1; }
         if (dabs(dcos(0.0) - 1.0) > tiny) { return 2; }
         if (dabs(dlog(de()) - 1.0) > tiny) { return 3; }
         if (dabs(dexp(0.0) - 1.0) > tiny) { return 4; }
         console.log("close enough");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("close enough\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("nothing traps: a bad argument is a NaN or an infinity", async () => {
        // Every one of these is total, exactly as C's is. There is no error to
        // return and nothing to catch — `disnan` is how you ask afterwards.
        const result = await run(
            "math-total",
            `import { disinf, disnan, dfmod, dlog, dsqrt } from "std/math";

       export function main(): i32 {
         if (!disnan(dsqrt(-1.0))) { return 1; }
         if (!disnan(dfmod(1.0, 0.0))) { return 2; }
         if (!disinf(dlog(0.0))) { return 3; }
         // A NaN is not equal to itself, which is why disnan has to exist.
         const n = dsqrt(-1.0);
         if (n === n) { return 4; }
         console.log("total");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("total\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("`dhypot` survives where squaring overflows", async () => {
        // The reason it is worth having rather than writing out. At
        // astronomical scale the *intermediate* square overflows long before
        // the answer would, so the naive spelling returns infinity for a length
        // that fits in an `f64` comfortably.
        const result = await run(
            "math-hypot",
            `import { disfinite, disinf, dhypot, dsqrt } from "std/math";

       export function main(): i32 {
         const big: f64 = 1.0e200;
         const naive = dsqrt(big * big + big * big);
         const safe = dhypot(big, big);
         console.log(\`\${disinf(naive)} \${disfinite(safe)}\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("true true\n");
        expect(result.leaked).toBe(0);
    });

    test("`datan2` is quadrant-correct where `datan` cannot be", async () => {
        // `datan(y / x)` loses the quadrant in the division and divides by zero
        // on the y-axis. Both are checked, because the second is the one that
        // looks fine until the day something sits exactly on the axis.
        const result = await run(
            "math-atan2",
            `import { dabs, datan2, dpi } from "std/math";

       export function main(): i32 {
         const tiny: f64 = 0.000000000000001;
         const quarter = dpi() / 4.0;
         if (dabs(datan2(1.0, 1.0) - quarter) > tiny) { return 1; }
         if (dabs(datan2(-1.0, -1.0) + 3.0 * quarter) > tiny) { return 2; }
         if (dabs(datan2(1.0, 0.0) - dpi() / 2.0) > tiny) { return 3; }
         console.log("quadrants");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("quadrants\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("`dmin` and `dmax` follow C's NaN rule, not `<`'s", async () => {
        // A NaN operand *loses*, which is not what `x < y ? x : y` does — that
        // one propagates the NaN. Worth pinning because the difference only
        // shows up on the input nobody tests with.
        const result = await run(
            "math-minmax",
            `import { dmax, dmin, dnan } from "std/math";

       export function main(): i32 {
         if (dmin(dnan(), 3.0) !== 3.0) { return 1; }
         if (dmax(dnan(), 3.0) !== 3.0) { return 2; }
         if (dmin(2.0, 3.0) !== 2.0) { return 3; }
         if (dmax(2.0, 3.0) !== 3.0) { return 4; }
         console.log("nan loses");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("nan loses\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("`dcopysign` carries the sign of a zero", async () => {
        // The case it exists for. A negative zero compares equal to a positive
        // one, so the sign is only observable by asking — which is what makes
        // `dcopysign` the way to move it.
        const result = await run(
            "math-copysign",
            `import { dcopysign, disinf } from "std/math";

       export function main(): i32 {
         const negativeZero = dcopysign(0.0, -1.0);
         if (negativeZero !== 0.0) { return 1; }
         // 1 / -0 is -inf, which is how the sign shows itself.
         if (!disinf(1.0 / negativeZero)) { return 2; }
         if (1.0 / negativeZero > 0.0) { return 3; }
         if (dcopysign(3.0, -1.0) !== -3.0) { return 4; }
         console.log("signed zero");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("signed zero\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("`dfmod` takes its sign from the dividend", async () => {
        const result = await run(
            "math-fmod",
            `import { dfmod } from "std/math";

       export function main(): i32 {
         if (dfmod(7.5, 2.0) !== 1.5) { return 1; }
         if (dfmod(-7.5, 2.0) !== -1.5) { return 2; }
         if (dfmod(7.5, -2.0) !== 1.5) { return 3; }
         console.log("signed remainder");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("signed remainder\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("the f32 family computes in f32", async () => {
        // The same properties, at the other width — so that `f`-prefixed names
        // are a family rather than a courtesy.
        const result = await run(
            "math-f32",
            `import { fabs, fisnan, fpi, fsin, fsqrt } from "std/math";

       export function main(): i32 {
         if (fsqrt(cast<f32>(4.0)) !== cast<f32>(2.0)) { return 1; }
         if (!fisnan(fsqrt(cast<f32>(-1.0)))) { return 2; }
         const small: f32 = cast<f32>(0.0001);
         if (fabs(fsin(fpi())) > small) { return 3; }
         console.log("f32");
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("f32\n");
        expect(result.exitCode).toBe(0);
        expect(result.leaked).toBe(0);
    });

    test("maths sits beside the other std modules", async () => {
        const result = await run(
            "math-with-others",
            `import * as math from "std/math";
       import { fileWrite, stdout } from "std/io";

       export function main(): i32 {
         fileWrite(stdout(), \`\${math.dsqrt(9.0)}\\n\`);
         return 0;
       }\n`,
        );
        expect(result.stdout).toBe("3\n");
        expect(result.leaked).toBe(0);
    });
});
