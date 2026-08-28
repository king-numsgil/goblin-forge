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
 *
 * **At the level the harness compiles at**, because the runtime is now built
 * per optimisation level and warming the wrong one warms nothing: the first
 * test to compile would pay for the real build, which is the whole failure
 * described above, arriving again through a fixture that looks like it is
 * doing its job.
 */

import { setDefaultTimeout } from "bun:test";

import { buildRuntime } from "@goblin-forge/runtime/build";

import { HARNESS_OPT_LEVEL } from "./harness.ts";

/**
 * And raise the per-test budget, for the same reason one level up.
 *
 * Every test here compiles a real program with clang and links a real binary.
 * Five seconds is enough when a file is run on its own and not always enough in
 * a full run, where forty-odd files contend for one disk and one compiler: a
 * test that takes 2.3 s alone has been seen to take 6.4 s and be failed for it,
 * with a message — "this test timed out after 5000ms" — that says nothing about
 * the program under test.
 *
 * A timeout that fires on contention is worse than a slow suite, because the
 * failure it invents is indistinguishable from a real one. The harness's most
 * valuable check is the *missing* live-allocation report, and what that check
 * says is "the program did not finish" — so a spurious version of exactly that
 * sentence teaches a reader to shrug at the one thing they should not.
 *
 * Here rather than in `bunfig.toml`, whose `[test]` table takes `preload` and
 * ignores `timeout` (Bun 1.4.0 — verified, not assumed), and here rather than
 * on the `bun test` command line so that running it bare gets the same budget
 * as running it through `package.json`.
 */
setDefaultTimeout(30_000);

buildRuntime(undefined, HARNESS_OPT_LEVEL);
