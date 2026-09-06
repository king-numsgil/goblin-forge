/**
 * A synthetic module of adjustable size, shaped like real lowered code.
 *
 * Used by the round-trip test for correctness and by the boundary benchmark for
 * REWRITE-PLAN §2's de-risk question. The failure mode that question is looking
 * for is not "the buffer doesn't work" but "it works and marshalling dominates
 * the compile", so the fixture has to have a realistic ratio of statements to
 * strings to types — a module that is all symbol names would measure the wrong
 * thing.
 */

import { ModuleBuilder } from "../js/builder.ts";
import { type Const, LocalId, type Module, type Operand, type Place, type TyId } from "../js/mir.generated.ts";

const place = (local: LocalId): Place => ({local, projection: []});
const copy = (local: LocalId): Operand => ({kind: "Copy", value: place(local)});
const int = (bits: number, ty: TyId): Operand => ({
    kind: "Const",
    value: {kind: "Int", bits: BigInt(bits), ty} satisfies Const,
});

/**
 * Build a module with `functionCount` functions, each a small loop with a
 * conditional, a call, and a handful of locals.
 */
export function buildFixture(functionCount: number): Module {
    const m = new ModuleBuilder("fixture");
    const file = m.file("F:/fixture/src/main.ts");
    const span = (line: number) => ({file, line, col: 1});

    const i32 = m.ty({kind: "Int", value: "I32"});
    const bool = m.ty({kind: "Bool"});
    const void_ = m.ty({kind: "Void"});
    const ptrI32 = m.ty({kind: "Pointer", value: i32});

    const printSig = m.sig({params: [i32], ret: void_, abi: "C"});
    const print = m.extern({name: "gf_print_i32", sig: printSig});

    // Module-level constants, one per initialiser shape, so that byte equality
    // covers each of them rather than only the ones a first program happens to
    // use. `PAIR` is the one that matters most: two leaves for two fields, which
    // is where a length prefix that only works for a single element shows up.
    const pair = m.ty({kind: "FixedArray", element: i32, length: 2n});
    const table = m.global({
        name: "FIXTURE_LIMIT",
        ty: i32,
        init: [{kind: "Scalar", value: {kind: "Int", bits: 7n, ty: i32}}],
    });
    m.global({
        name: "FIXTURE_PAIR",
        ty: pair,
        init: [
            {kind: "Scalar", value: {kind: "Int", bits: 1n, ty: i32}},
            {kind: "SizeOf", value: i32},
        ],
    });
    // Exported, and zero — which is both `Linkage::Export` on a global and the
    // leaf that stands for a whole subtree.
    m.global({name: "FIXTURE_SHARED", ty: pair, linkage: "Export", init: [{kind: "Zero"}]});
    const imported = m.externGlobal({name: "other_module$CONST", ty: i32});

    const workSig = m.sig({params: [i32, ptrI32], ret: i32});

    for (let index = 0; index < functionCount; index += 1) {
        const f = m.declareFunction({
            name: `work_${index}`,
            sig: workSig,
            linkage: index === 0 ? "Export" : "Internal",
            span: span(index * 10 + 1),
        });

        const limit = LocalId(1);
        const out = LocalId(2);
        const counter = f.addLocal({ty: i32, storage: "Owned", name: "counter", span: span(index * 10 + 2)});
        const keepGoing = f.addLocal({ty: bool, storage: "Temporary"});
        const scratch = f.addLocal({ty: i32, storage: "Temporary"});

        const entry = f.block();
        const head = f.block();
        const body = f.block();
        const afterCall = f.block();
        const exit = f.block();

        f.push(entry, {kind: "StorageLive", value: counter});
        f.push(entry, {
            kind: "Init",
            place: place(counter),
            rvalue: {kind: "Use", value: int(0, i32)},
        });
        // Reading a global: its *address* as a constant, then a `Deref` like any
        // other pointer. Both `GlobalRef` variants appear, because a local one and
        // an imported one are different slots on the wire.
        for (const target of [
            {kind: "Local", value: table} as const,
            {kind: "Extern", value: imported} as const,
        ]) {
            const address = f.addLocal({ty: ptrI32, storage: "Temporary"});
            f.push(entry, {kind: "StorageLive", value: address});
            f.push(entry, {
                kind: "Init",
                place: place(address),
                rvalue: {kind: "Use", value: {kind: "Const", value: {kind: "Global", global: target, ty: ptrI32}}},
            });
            f.push(entry, {
                kind: "Assign",
                place: place(counter),
                rvalue: {
                    kind: "Binary",
                    op: "Add",
                    lhs: copy(counter),
                    rhs: {kind: "Copy", value: {local: address, projection: [{kind: "Deref"}]}},
                },
            });
            f.push(entry, {kind: "StorageDead", value: address});
        }
        f.seal(entry, {kind: "Goto", value: head});

        f.push(head, {kind: "StorageLive", value: keepGoing});
        f.push(head, {
            kind: "Init",
            place: place(keepGoing),
            rvalue: {kind: "Binary", op: "Lt", lhs: copy(counter), rhs: copy(limit)},
        });
        f.seal(head, {
            kind: "Branch",
            cond: copy(keepGoing),
            thenBlock: body,
            elseBlock: exit,
        });

        f.push(body, {kind: "StorageLive", value: scratch});
        f.push(body, {
            kind: "Init",
            place: place(scratch),
            rvalue: {kind: "Binary", op: "Mul", lhs: copy(counter), rhs: int(3, i32)},
        });
        f.push(body, {
            kind: "Assign",
            place: {local: out, projection: [{kind: "Deref"}]},
            rvalue: {kind: "Use", value: copy(scratch)},
        });
        f.seal(body, {
            kind: "Call",
            callee: {kind: "Direct", value: {kind: "Extern", value: print}},
            args: [copy(scratch)],
            destination: {place: place(LocalId(0)), target: afterCall},
            // A C function cannot unwind, so this edge is dead. The edge exists in
            // the IR regardless — see REWRITE-PLAN §11.5.
            unwind: {kind: "Unreachable"},
        });

        f.push(afterCall, {kind: "StorageDead", value: scratch});
        f.push(afterCall, {
            kind: "Assign",
            place: place(counter),
            rvalue: {kind: "Binary", op: "Add", lhs: copy(counter), rhs: int(1, i32)},
        });
        f.seal(afterCall, {kind: "Goto", value: head});

        f.push(exit, {kind: "StorageDead", value: keepGoing});
        f.push(exit, {
            kind: "Init",
            place: place(LocalId(0)),
            rvalue: {kind: "Use", value: copy(counter)},
        });
        f.push(exit, {kind: "StorageDead", value: counter});
        f.seal(exit, {kind: "Return"});
    }

    return m.finish();
}
