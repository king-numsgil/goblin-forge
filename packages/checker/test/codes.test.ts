/**
 * The `GF####` registry has to cover every code the compiler can emit.
 *
 * REWRITE-PLAN §8.3: "Codes are stable and documented. Keep a registry file
 * mapping code → short title → long explanation, and generate the docs page
 * from it."
 *
 * A code that exists only as a string literal at the site that raises it drifts
 * out of the documentation within a month — which is exactly what happened to
 * `GF9003`–`GF9005`, emitted by the backend for a milestone before anyone
 * noticed they were not in the table. This is the check that would have caught
 * it the same day.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { allCodes, CODES, explain } from "../src/index.ts";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/** Every `.rs` and `.ts` file the compiler is made of. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "target" || entry === ".git") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith(".rs") || path.endsWith(".ts")) out.push(path);
    }
  };
  walk(join(ROOT, "crates"));
  walk(join(ROOT, "packages"));
  return out;
}

/** Codes that appear as a literal anywhere outside the registry itself. */
function emittedCodes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of sources()) {
    if (path.endsWith(join("checker", "src", "codes.ts"))) continue;
    // Tests name codes they *expect*; a code only a test mentions is still a
    // code the compiler is claimed to emit, so they count.
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/["'`](GF\d{4})["'`]/g)) {
      const code = match[1]!;
      const where = found.get(code) ?? [];
      where.push(path.slice(ROOT.length + 1));
      found.set(code, where);
    }
  }
  return found;
}

describe("the diagnostic registry", () => {
  test("covers every code the compiler emits", () => {
    const missing: string[] = [];
    for (const [code, where] of emittedCodes()) {
      if (!(code in CODES)) missing.push(`${code} (in ${where[0]})`);
    }
    expect(missing).toEqual([]);
  });

  test("every entry has a title and a real explanation", () => {
    for (const [code, entry] of allCodes()) {
      expect({ code, hasTitle: entry.title.length > 0 }).toEqual({ code, hasTitle: true });
      // The explanation is what gets rendered into the docs, so it has to say
      // something rather than restate the title.
      expect({ code, explained: entry.explanation.length > 60 }).toEqual({
        code,
        explained: true,
      });
      expect({ code, restated: entry.explanation === entry.title }).toEqual({
        code,
        restated: false,
      });
    }
  });

  test("codes are unique and well-formed", () => {
    const codes = allCodes().map(([code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect({ code, wellFormed: /^GF\d{4}$/.test(code) }).toEqual({
        code,
        wellFormed: true,
      });
    }
  });

  test("`explain` answers for every registered code", () => {
    for (const [code] of allCodes()) {
      expect(explain(code).title.length).toBeGreaterThan(0);
    }
  });
});
