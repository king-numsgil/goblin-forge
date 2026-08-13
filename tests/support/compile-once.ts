/**
 * Compile one program, in a process of its own.
 *
 * The backend panics rather than returning politely when it reaches a case the
 * frontend should have rejected (REWRITE-PLAN §8, and `strictInternalErrors`),
 * and a panic inside the addon takes the whole process with it. That is the
 * right behaviour and it is what makes a compiler crash impossible to mistake
 * for a clean rejection — but it means a test cannot *observe* one from inside
 * the runner, because the runner dies too.
 *
 * So the observation happens here instead. This script compiles a single
 * program described by a JSON file and prints one marker line when it survives.
 * No marker means the addon aborted.
 */

import { readFileSync } from "node:fs";

import { compileSource } from "../harness.ts";

const MARKER = "##goblin-compile-once:";

const request = JSON.parse(readFileSync(Bun.argv[2]!, "utf8")) as {
  name: string;
  source: string;
  files?: Record<string, string>;
};

const { result } = await compileSource(request.name, request.source, {
  ...(request.files !== undefined ? { files: request.files } : {}),
});

console.log(
  MARKER +
    JSON.stringify({
      ok: result.ok,
      codes: result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
    }),
);
