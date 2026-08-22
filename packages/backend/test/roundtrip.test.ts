/**
 * REWRITE-PLAN §12.1: the boundary spike.
 *
 * The claim being tested is not "a buffer can cross napi" — of course it can.
 * It is that the *generated* TypeScript encoder and the Rust decoder describe
 * the same wire format. postcard is positional: a struct field written one slot
 * early still decodes, into a different and entirely plausible module. So the
 * assertion that matters is byte equality after a decode/re-encode round trip
 * through Rust, not "no error was thrown".
 */

import { describe, expect, test } from "bun:test";

import {
    Backend,
    type BackendOptions,
    checkBindingsMatchAddon,
    encodeModule,
    SCHEMA_FINGERPRINT_HEX,
    schemaFingerprint,
} from "../js/index.ts";
import { buildFixture } from "./fixture.ts";

const options: BackendOptions = {
    optLevel: "O0",
    debugInfo: false,
    checked: false,
};

const backend = new Backend(options);

describe("the napi boundary", () => {
    test("the addon and the generated bindings agree on the wire format", () => {
        expect(schemaFingerprint()).toBe(SCHEMA_FINGERPRINT_HEX);
        expect(() => checkBindingsMatchAddon()).not.toThrow();
    });

    test("a module survives encode, decode and re-encode byte for byte", () => {
        const module = buildFixture(8);
        const encoded = encodeModule(module);
        const returned = backend.roundTrip(encoded);

        expect(returned.length).toBe(encoded.length);
        // Compare as arrays so a mismatch reports the offending index rather than
        // just "not equal".
        expect(Array.from(returned)).toEqual(Array.from(encoded));
    });

    test("byte equality holds across every node kind the fixture uses", () => {
        // One function is enough to exercise the shapes; eight is enough to catch a
        // length prefix that only works for the first element.
        for (const count of [1, 2, 8, 64]) {
            const encoded = encodeModule(buildFixture(count));
            expect(Array.from(backend.roundTrip(encoded))).toEqual(Array.from(encoded));
        }
    });

    test("the decoded module has the contents the frontend put in it", () => {
        const summary = backend.describeModule(encodeModule(buildFixture(3)));

        expect(summary.ok).toBe(true);
        expect(summary.diagnostics).toEqual([]);
        expect(summary.name).toBe("fixture");
        expect(summary.funcCount).toBe(3);
        // Five blocks per function: entry, head, body, after-call, exit.
        expect(summary.blockCount).toBe(15);
        // Only the first function is exported.
        expect(summary.defines).toEqual(["work_0"]);
        // Read from the real call sites, not the declaration list.
        expect(summary.requires).toEqual(["gf_print_i32"]);
    });

    test("a stale frontend is reported, not silently decoded", () => {
        const module = buildFixture(1);
        const encoded = encodeModule({...module, schemaFingerprint: 0xdeadbeefn});
        const summary = backend.describeModule(encoded);

        expect(summary.ok).toBe(false);
        expect(summary.diagnostics[0]?.code).toBe("GF9002");
        expect(summary.diagnostics[0]?.message).toContain("different MIR definitions");
    });

    test("a corrupt buffer is a diagnostic, not a crash", () => {
        const summary = backend.describeModule(new Uint8Array([0xff, 0xff, 0xff]));
        expect(summary.ok).toBe(false);
        expect(summary.diagnostics[0]?.code).toBe("GF9001");
    });
});
