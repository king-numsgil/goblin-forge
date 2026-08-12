/**
 * REWRITE-PLAN §2, "de-risk before anything else".
 *
 * > Confirm the buffer boundary carries a real module. […] the failure mode is
 * > not "it doesn't work" but "it works and marshalling dominates the compile".
 * > If it does, the answer is to emit per function rather than one blob per
 * > module — cheap to do early, annoying to retrofit.
 *
 * So this measures three things separately, because only the split tells you
 * what to do about a bad number:
 *
 *   encode   — building the buffer in TypeScript
 *   transfer — the napi call itself, with the decode taken out
 *   decode   — postcard in Rust
 *
 * The yardstick is Cranelift. A single-pass backend emits somewhere around
 * 1–10 MB/s of machine code; if marshalling a module costs a small fraction of
 * what compiling it will cost, the one-blob-per-module design stands.
 *
 * Run with `bun run bench:boundary`.
 */

import { Backend, encodeModule, type Module } from "../js/index.ts";
import { buildFixture } from "../test/fixture.ts";

const backend = new Backend({ optLevel: "none", debugInfo: false, checked: false });

const SIZES = [1, 16, 128, 512, 2048];

function time(iterations: number, body: () => void): number {
  // Warm up the JIT and the allocator before the measured run.
  for (let i = 0; i < Math.max(1, iterations >> 2); i += 1) body();
  const start = Bun.nanoseconds();
  for (let i = 0; i < iterations; i += 1) body();
  return (Bun.nanoseconds() - start) / iterations / 1e6;
}

function iterationsFor(functionCount: number): number {
  if (functionCount <= 16) return 500;
  if (functionCount <= 128) return 200;
  if (functionCount <= 512) return 50;
  return 20;
}

interface Row {
  functions: number;
  statements: number;
  bytes: number;
  encodeMs: number;
  roundTripMs: number;
  describeMs: number;
}

function measure(functionCount: number): Row {
  const module: Module = buildFixture(functionCount);
  const encoded = encodeModule(module);
  const iterations = iterationsFor(functionCount);

  const statements = module.funcs.reduce(
    (total, f) => total + f.blocks.reduce((n, b) => n + b.statements.length, 0),
    0,
  );

  return {
    functions: functionCount,
    statements,
    bytes: encoded.length,
    encodeMs: time(iterations, () => {
      encodeModule(module);
    }),
    // Decode plus re-encode plus two crossings: an upper bound on the boundary
    // cost, and the only number here that includes a Rust-side encode.
    roundTripMs: time(iterations, () => {
      backend.roundTrip(encoded);
    }),
    // Decode plus a walk of every function — the shape a real `compileModule`
    // call starts with.
    describeMs: time(iterations, () => {
      backend.describeModule(encoded);
    }),
  };
}

const rows = SIZES.map(measure);

const columns = [
  ["functions", (r: Row) => String(r.functions)],
  ["stmts", (r: Row) => String(r.statements)],
  ["bytes", (r: Row) => r.bytes.toLocaleString("en-US")],
  ["encode ms", (r: Row) => r.encodeMs.toFixed(3)],
  ["describe ms", (r: Row) => r.describeMs.toFixed(3)],
  ["round-trip ms", (r: Row) => r.roundTripMs.toFixed(3)],
  [
    "MB/s in",
    (r: Row) => (r.bytes / 1e6 / (r.encodeMs / 1e3)).toFixed(0),
  ],
  [
    "bytes/stmt",
    (r: Row) => (r.bytes / r.statements).toFixed(1),
  ],
] as const;

const header = columns.map(([name]) => name);
const body = rows.map((row) => columns.map(([, render]) => render(row)));
const widths = header.map((name, index) =>
  Math.max(name.length, ...body.map((cells) => cells[index]!.length)),
);

const line = (cells: readonly string[]) =>
  cells.map((cell, index) => cell.padStart(widths[index]!)).join("  ");

console.log("goblin-forge — napi boundary cost\n");
console.log(line(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const cells of body) console.log(line(cells));

const largest = rows.at(-1)!;
console.log(
  `\nlargest module: ${largest.bytes.toLocaleString("en-US")} bytes, ` +
    `${largest.encodeMs.toFixed(2)} ms to encode, ` +
    `${largest.describeMs.toFixed(2)} ms to cross and decode.`,
);
