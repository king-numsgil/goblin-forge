/**
 * Build the runtime once, before any test is allowed to need it.
 *
 * The runtime is a Rust staticlib compiled for the user's target, and on a
 * cold `target/` that is a cargo build measured in tens of seconds. It is
 * cached per process, so exactly one test pays for it — whichever happens to
 * compile first — and that test is billed for a fixture rather than for its
 * own work. Against bun's five-second per-test timeout on a clean checkout,
 * that test loses.
 *
 * The failure it produced was worse than a slow test: the timeout killed cargo
 * mid-build, `buildRuntime` saw a non-zero status with nothing on stderr, and
 * reported "building the Goblin runtime failed:" followed by nothing at all.
 * Three tests in `modules.test.ts` failed that way on this machine's first run,
 * and none of them had anything to do with the runtime.
 *
 * Doing it here puts the cost outside every test's clock, where a fixture
 * belongs. Once the library is built cargo is a fast no-op, so this stays
 * cheap on every run after the first.
 */

import { buildRuntime } from "@goblin-forge/runtime/build";

buildRuntime();
