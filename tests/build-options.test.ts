/**
 * The knobs on `compile()`, each turned and each observed.
 *
 * Every other suite runs with one setting of these — `optLevel: "none"`,
 * `debugInfo: false`, `checked: false` — because that is what the harness
 * defaults to and what makes a failure quickest to read. Which means the other
 * settings are exercised by nothing at all, and an optimiser that miscompiles a
 * loop or a debug-info emitter that writes a malformed section would be found
 * by a user rather than by this suite.
 *
 * The programs are deliberately the same across settings: what is being tested
 * is that the *answer* does not depend on the setting.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";

import { compileSource, run } from "./harness.ts";

/** Enough control flow and arithmetic that an optimiser has something to do. */
const WORKLOAD = `function collatz(start: i32): i32 {
   let n: i32 = start;
   let steps: i32 = 0;
   while (n !== 1) {
     if (n % 2 === 0) { n = n / 2; } else { n = 3 * n + 1; }
     steps = steps + 1;
   }
   return steps;
 }

 export function main(): i32 {
   let total: i32 = 0;
   for (let i: i32 = 1; i < 30; i = i + 1) { total = total + collatz(i); }
   console.log(\`\${total}\`);
   return 0;
 }\n`;

describe("optimisation levels", () => {
  for (const optLevel of ["none", "speed", "size"] as const) {
    test(`\`${optLevel}\` computes the same answer`, async () => {
      const result = await run(`opt-${optLevel}`, WORKLOAD, { optLevel });
      expect(result.stdout).toBe("423\n");
      expect(result.exitCode).toBe(0);
      expect(result.leaked).toBe(0);
    });
  }

  test("an unknown level is refused before anything is built", async () => {
    // `OptLevel::parse` in the addon is the only thing that knows the set, so
    // the failure has to come from there rather than from a Cranelift panic.
    let message = "";
    try {
      await compileSource("opt-unknown", WORKLOAD, { optLevel: "fastest" as "speed" });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("optimisation level");
  });

  test("optimisation does not change what an owning program allocates", async () => {
    for (const optLevel of ["none", "speed", "size"] as const) {
      const result = await run(
        `opt-owning-${optLevel}`,
        `export function main(): i32 {
           let i: i32 = 0;
           while (i < 20) {
             const s: string = \`item \${i}\` + "!";
             i = i + 1;
           }
           console.log("done");
           return 0;
         }\n`,
        { optLevel },
      );
      expect({ optLevel, stdout: result.stdout, leaked: result.leaked }).toEqual({
        optLevel,
        stdout: "done\n",
        leaked: 0,
      });
    }
  });
});

describe("debug information", () => {
  for (const debugInfo of [false, true]) {
    test(`\`debugInfo: ${debugInfo}\` still produces a program that runs`, async () => {
      const result = await run(`dbg-${debugInfo}`, WORKLOAD, { debugInfo });
      expect(result.stdout).toBe("423\n");
    });
  }

  test("debug information does not change the answer at any optimisation level", async () => {
    for (const optLevel of ["none", "speed"] as const) {
      const result = await run(`dbg-opt-${optLevel}`, WORKLOAD, { optLevel, debugInfo: true });
      expect({ optLevel, stdout: result.stdout }).toEqual({ optLevel, stdout: "423\n" });
    }
  });
});

describe("`checked`", () => {
  test.failing("a checked build catches a double free", async () => {
    // `global.d.ts` describes `checked` as what catches the double free that
    // `free()`'s pointer poisoning cannot — "Aliases are not poisoned;
    // `checked` catches the double free instead". The flag is threaded from
    // `compile()` through the napi boundary into `object::Options` and is read
    // by nothing: `grep -r checked crates/goblin-codegen/src` finds the field
    // and two comments. So a checked build is byte-identical to an unchecked
    // one, and the sentence in the prelude is a promise about a future.
    //
    // There is no way to write the double free the sentence describes yet
    // either — `free()` is `GF0001` — so this asserts the weaker thing that
    // could be true today: that the flag changes the program at all.
    const plain = await compileSource("checked-off", WORKLOAD, { checked: false });
    const checked = await compileSource("checked-on", WORKLOAD, { checked: true });
    const sizeOf = (path: string): number => statSync(path).size;
    expect(sizeOf(checked.result.objects[0]!)).not.toBe(sizeOf(plain.result.objects[0]!));
  });

  test("a checked build compiles and runs, whatever it does not yet check", async () => {
    const result = await run("checked-runs", WORKLOAD, { checked: true });
    expect(result.stdout).toBe("423\n");
  });
});

describe("emitted artifacts", () => {
  test("`emit.ir` writes the MIR beside the object", async () => {
    const { result } = await compileSource("emit-ir", WORKLOAD, { emitIr: true });
    expect(result.ok).toBe(true);
    expect(result.irPath).toBeDefined();
    expect(existsSync(result.irPath!)).toBe(true);
    expect(readFileSync(result.irPath!, "utf8")).toContain("collatz");
  });

  test("without `emit.ir` there is no MIR path at all", async () => {
    const { result } = await compileSource("emit-no-ir", WORKLOAD);
    expect(result.irPath).toBeUndefined();
  });

  test("the reported paths are absolute and the files exist", async () => {
    const { result } = await compileSource("emit-paths", WORKLOAD);
    expect(result.ok).toBe(true);
    for (const path of [result.output!, ...result.objects]) {
      expect(path).toMatch(/^([A-Za-z]:[\\/]|\/)/);
      expect(existsSync(path)).toBe(true);
    }
  });

  test("a `bin` produces no header", async () => {
    const { result } = await compileSource("emit-bin-header", WORKLOAD);
    expect(result.headerPath).toBeUndefined();
  });
});

describe("`main`", () => {
  test("returning anything but `i32` is GF0004, and the message says so", async () => {
    const { result } = await compileSource(
      "main-void",
      `export function main(): void { }\n`,
    );
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === "GF0004");
    expect(diagnostic?.message).toContain("i32");
  });

  test("a `main` that is not exported does not count", async () => {
    const { result } = await compileSource(
      "main-unexported",
      `function main(): i32 { return 0; }\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("GF0004");
  });

  test("`main(args: string[])` receives the command line", async () => {
    // `argv[0]` is kept, as it is in C: which arguments a program gets is not
    // something a compiler should have an opinion about. So a program handed
    // two arguments sees three elements.
    const result = await run(
      "main-args",
      `export function main(args: string[]): i32 {
         console.log(\`\${args.length}\`);
         let i: usize = 1;
         while (i < args.length) { console.log(args[i]); i = i + 1; }
         return 0;
       }\n`,
      { args: ["alpha", "beta"] },
    );
    expect(result.stdout).toBe("3\nalpha\nbeta\n");
    // The strings are copies of the platform's bytes, so `main`'s scope owns
    // them and releases them — which the counter is what proves.
    expect(result.leaked).toBe(0);
  });

  test("`main(args)` with no arguments still gets `argv[0]`", async () => {
    const result = await run(
      "main-args-empty",
      `export function main(args: string[]): i32 {
         return cast<i32>(args.length);
       }\n`,
    );
    expect(result.exitCode).toBe(1);
    expect(result.leaked).toBe(0);
  });

  test("`args` is an ordinary `string[]`, and may be walked with `for…of`", async () => {
    const result = await run(
      "main-args-forof",
      `export function main(args: string[]): i32 {
         let total: usize = 0;
         for (const a of args) { total = total + a.length; }
         console.log(\`\${total > 0}\`);
         return 0;
       }\n`,
      { args: ["xyz"] },
    );
    expect(result.stdout).toBe("true\n");
    expect(result.leaked).toBe(0);
  });

  test("the conventional argc/argv pair is GF0004, and the message says what to write", async () => {
    // C's shape, refused: there is nothing here to hand the two halves to
    // separately, because the runtime has already turned them into an array by
    // the time the first statement runs.
    const { result } = await compileSource(
      "main-argv",
      `export function main(argc: i32, argv: Pointer<Pointer<u8>>): i32 { return 0; }\n`,
    );
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("GF0004");
    expect(codes).not.toContain("GF0001");
    const diagnostic = result.diagnostics.find((d) => d.code === "GF0004");
    expect(diagnostic?.message).toContain("string[]");
  });

  test("`main` taking anything else is GF0004", async () => {
    const { result } = await compileSource(
      "main-wrong-param",
      `export function main(n: i32): i32 { return n; }\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("GF0004");
  });

  test("a second exported function beside `main` is fine", async () => {
    const result = await run(
      "main-plus-export",
      `export function helper(): i32 { return 7; }

       export function main(): i32 { return helper(); }\n`,
    );
    expect(result.exitCode).toBe(7);
  });
});

describe("exit codes", () => {
  test("a small value reaches the shell intact", async () => {
    expect((await run("exit-small", "export function main(): i32 { return 42; }\n")).exitCode).toBe(
      42,
    );
  });

  test("a value wider than a byte is truncated by the harness, not by the program", async () => {
    // Documented on `RunResult.exitCode`: POSIX `waitpid` gives eight bits and
    // Bun truncates on Windows too. The program really does exit 300; this is
    // the observation that cannot see it, and the reason every other test in
    // the suite prints what it wants to check.
    expect((await run("exit-wide", "export function main(): i32 { return 300; }\n")).exitCode).toBe(
      44,
    );
  });

  test("a negative return arrives as its low byte", async () => {
    expect((await run("exit-neg", "export function main(): i32 { return -1; }\n")).exitCode).toBe(
      255,
    );
  });
});
