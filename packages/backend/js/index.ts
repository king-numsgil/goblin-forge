/**
 * The napi boundary, from the JavaScript side.
 *
 * Two things live behind this entry point and they are deliberately different
 * in kind:
 *
 * * The **addon** (`Backend`, `schemaFingerprint`) — a native class whose
 *   methods take and return flat, plain objects.
 * * The **MIR** (`./mir.generated.ts`) — types and a postcard encoder,
 *   generated from `crates/goblin-mir`. Nothing here is written by hand, and
 *   nothing in the frontend declares a second copy of these shapes.
 *
 * REWRITE-PLAN §2 puts only the MIR through as an opaque buffer, for a reason
 * worth restating: napi-rs handles plain structs and C-like enums well, and a
 * deeply nested tagged-union IR badly. Modelling MIR as `#[napi(object)]`
 * would mean hand-written conversions — v1's hand-synced protocol in a new
 * costume.
 */

import { Backend, outputExtension, outputPrefix, schemaFingerprint } from "../binding.js";
import { SCHEMA_FINGERPRINT_HEX } from "./mir.generated.ts";

export { Backend, outputExtension, outputPrefix, schemaFingerprint };
export type {
    BackendDiagnostic,
    BackendOptions,
    LayoutReport,
    LinkReport,
    LinkRequest,
    ModuleArtifact,
    ModuleSummary,
} from "../binding.d.ts";
export * from "./mir.generated.ts";
export { FunctionBuilder, ModuleBuilder, SYNTHETIC } from "./builder.ts";
export {
    type PrintOptions,
    printFunction,
    printModule,
    printStatement,
    printTerminator,
} from "./print.ts";

/**
 * Whether the prebuilt addon and the generated bindings describe the same wire
 * format.
 *
 * The addon is a compiled binary and the JavaScript beside it is not, so they
 * can be updated independently — and when they are, postcard's positional
 * encoding means the mismatch does not announce itself. Checking once at
 * startup turns a decode that yields a plausible wrong module into one clear
 * message.
 */
export function checkBindingsMatchAddon(): void {
    const addon = schemaFingerprint();
    if (addon !== SCHEMA_FINGERPRINT_HEX) {
        throw new Error(
            `goblin-forge: the native backend was built from a different MIR ` +
            `definition than the generated bindings (addon ${addon}, bindings ` +
            `${SCHEMA_FINGERPRINT_HEX}). Run \`bun run build:backend\` to rebuild ` +
            `both from crates/goblin-mir.`,
        );
    }
}
