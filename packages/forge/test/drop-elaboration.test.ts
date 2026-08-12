/**
 * Drop elaboration, tested before the language can express an owning type.
 *
 * Milestone 4 has no owning types — REWRITE-PLAN §12.4 says so explicitly, and
 * that is the point: the pass exists and is tested *first*, so that milestone 5
 * is "give it something to destroy" rather than "and now we make ownership
 * work".
 *
 * So these build MIR directly, with a type marked `Owning`, and assert where
 * the drops land. It is the only way to exercise the dataflow this early, and
 * it is a better test than a source-level one anyway: the question is where a
 * `Drop` goes, and here that is asserted rather than inferred from behaviour.
 */

import { describe, expect, test } from "bun:test";

import {
  BlockId,
  type Function as MirFunction,
  LocalId,
  type Module,
  ModuleBuilder,
  type Operand,
  type Place,
  printFunction,
  type Statement,
  type TyId,
} from "@goblin-forge/backend";

import { elaborateDrops } from "../src/drop-elaboration.ts";

const place = (local: LocalId): Place => ({ local, projection: [] });
const copy = (local: LocalId): Operand => ({ kind: "Copy", value: place(local) });
const move = (local: LocalId): Operand => ({ kind: "Move", value: place(local) });
const unit: Operand = { kind: "Const", value: { kind: "Unit" } };

/**
 * A module builder with a `string`-shaped owning type available.
 *
 * `Str` is the type milestone 5 makes real. Marking it `Owning` here is exactly
 * what the frontend will do then, so the pass is being tested against the
 * arrangement it will actually meet.
 */
function scaffold(): { m: ModuleBuilder; owning: TyId; i32: TyId; void_: TyId } {
  const m = new ModuleBuilder("drops");
  const owning = m.ty({ kind: "Str" });
  const i32 = m.ty({ kind: "Int", value: "I32" });
  const void_ = m.ty({ kind: "Void" });
  return { m, owning, i32, void_ };
}

/** The statements of one block, rendered, for readable assertions. */
function statements(module: Module, func: MirFunction, block: number): string[] {
  return printFunction(module, func, { declarations: false })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(indexOfBlock(module, func, block), indexOfBlock(module, func, block + 1))
    .filter((line) => line !== "}" || false)
    .filter((line, index, all) => !(line === "}" && index === all.length - 1));
}

function indexOfBlock(module: Module, func: MirFunction, block: number): number {
  const lines = printFunction(module, func, { declarations: false })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const found = lines.findIndex((line) => line.startsWith(`bb${block}`));
  return found === -1 ? lines.length : found;
}

/** Every `drop(...)` line in a function, in order. */
function drops(module: Module, func: MirFunction): string[] {
  return printFunction(module, func, { declarations: false })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("drop("));
}

describe("what gets dropped", () => {
  test("an owned local is dropped where it goes out of scope", () => {
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "one", sig });

    const s = f.addLocal({ ty: owning, storage: "Owned", name: "s" });
    const bb = f.block();
    f.push(bb, { kind: "StorageLive", value: s });
    f.push(bb, { kind: "Init", place: place(s), rvalue: { kind: "Use", value: unit } });
    f.push(bb, { kind: "StorageDead", value: s });
    f.seal(bb, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);

    // Immediately *before* the StorageDead, so the destructor still has
    // storage to run against.
    expect(statements(module, module.funcs[0]!, 0)).toEqual([
      "bb0: {",
      "StorageLive(_1);",
      "_1 = ();",
      "drop(_1);",
      "StorageDead(_1);",
      "return;",
    ]);
  });

  test("a trivial local is not dropped", () => {
    const { m, i32, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "trivial", sig });

    const n = f.addLocal({ ty: i32, storage: "Owned", name: "n" });
    const bb = f.block();
    f.push(bb, { kind: "StorageLive", value: n });
    f.push(bb, { kind: "Init", place: place(n), rvalue: { kind: "Use", value: unit } });
    f.push(bb, { kind: "StorageDead", value: n });
    f.seal(bb, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);
    expect(drops(module, module.funcs[0]!)).toEqual([]);
  });

  test("a borrowed local is never dropped, whatever its type", () => {
    // The entire content of `Reference<T>`: it is an address into somebody
    // else's storage, and nobody destroys it.
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "borrowed", sig });

    const r = f.addLocal({ ty: owning, storage: "Borrowed", name: "r" });
    const bb = f.block();
    f.push(bb, { kind: "StorageLive", value: r });
    f.push(bb, { kind: "Init", place: place(r), rvalue: { kind: "Use", value: unit } });
    f.push(bb, { kind: "StorageDead", value: r });
    f.seal(bb, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);
    expect(drops(module, module.funcs[0]!)).toEqual([]);
  });

  test("a by-value parameter is not dropped by the callee", () => {
    // REWRITE-PLAN §4.5: the *caller* destroys a by-value argument,
    // Itanium-style. Dropping it here too is a double free at every call.
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [owning], ret: void_ });
    const f = m.declareFunction({ name: "takes", sig });

    const bb = f.block();
    f.push(bb, { kind: "StorageDead", value: LocalId(1) });
    f.seal(bb, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);
    expect(drops(module, module.funcs[0]!)).toEqual([]);
  });

  test("a moved-from local is not dropped", () => {
    // A move transfers ownership and leaves the source safe to destroy but not
    // to read. Dropping it as well is the double free a move exists to avoid.
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "moved", sig });

    const from = f.addLocal({ ty: owning, storage: "Owned", name: "from" });
    const to = f.addLocal({ ty: owning, storage: "Owned", name: "to" });

    const bb = f.block();
    f.push(bb, { kind: "StorageLive", value: from });
    f.push(bb, { kind: "Init", place: place(from), rvalue: { kind: "Use", value: unit } });
    f.push(bb, { kind: "StorageLive", value: to });
    f.push(bb, {
      kind: "Init",
      place: place(to),
      rvalue: { kind: "Use", value: move(from) },
    });
    f.push(bb, { kind: "StorageDead", value: to });
    f.push(bb, { kind: "StorageDead", value: from });
    f.seal(bb, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);
    // Only the destination. `from` gave its value away.
    expect(drops(module, module.funcs[0]!)).toEqual(["drop(_2);"]);
  });

  test("a copied-from local is still dropped", () => {
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "copied", sig });

    const from = f.addLocal({ ty: owning, storage: "Owned", name: "from" });
    const to = f.addLocal({ ty: owning, storage: "Owned", name: "to" });

    const bb = f.block();
    f.push(bb, { kind: "StorageLive", value: from });
    f.push(bb, { kind: "Init", place: place(from), rvalue: { kind: "Use", value: unit } });
    f.push(bb, { kind: "StorageLive", value: to });
    f.push(bb, {
      kind: "Init",
      place: place(to),
      rvalue: { kind: "Use", value: copy(from) },
    });
    f.push(bb, { kind: "StorageDead", value: to });
    f.push(bb, { kind: "StorageDead", value: from });
    f.seal(bb, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);
    expect(drops(module, module.funcs[0]!)).toEqual(["drop(_2);", "drop(_1);"]);
  });
});

describe("drop flags", () => {
  test("a local initialised on only one path gets a conditional drop", () => {
    // REWRITE-PLAN §5.1.4: where a local may or may not be initialised on a
    // path, use a drop flag rather than refusing the program.
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "maybe", sig });

    const s = f.addLocal({ ty: owning, storage: "Owned", name: "s" });
    const cond = f.addLocal({ ty: m.ty({ kind: "Bool" }), storage: "Owned" });

    const entry = f.block();
    const then = f.block();
    const join = f.block();

    f.push(entry, { kind: "StorageLive", value: s });
    f.seal(entry, {
      kind: "Branch",
      cond: copy(cond),
      thenBlock: then,
      elseBlock: join,
    });

    f.push(then, { kind: "Init", place: place(s), rvalue: { kind: "Use", value: unit } });
    f.seal(then, { kind: "Goto", value: join });

    f.push(join, { kind: "StorageDead", value: s });
    f.seal(join, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);
    const func = module.funcs[0]!;

    // Conditional, because only one arm initialised it.
    expect(drops(module, func)).toEqual(["drop(_1) if _3;"]);

    const rendered = printFunction(module, func, { declarations: false });
    // The flag starts false in the entry block, and the initialising arm sets
    // it. Without the first of those, an uninitialised local is destroyed.
    expect(rendered).toContain("_3 = false;");
    expect(rendered).toContain("_3 = true;");
  });

  test("a local initialised on every path is dropped unconditionally", () => {
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "always", sig });

    const s = f.addLocal({ ty: owning, storage: "Owned", name: "s" });
    const cond = f.addLocal({ ty: m.ty({ kind: "Bool" }), storage: "Owned" });

    const entry = f.block();
    const then = f.block();
    const otherwise = f.block();
    const join = f.block();

    f.push(entry, { kind: "StorageLive", value: s });
    f.seal(entry, { kind: "Branch", cond: copy(cond), thenBlock: then, elseBlock: otherwise });

    f.push(then, { kind: "Init", place: place(s), rvalue: { kind: "Use", value: unit } });
    f.seal(then, { kind: "Goto", value: join });

    f.push(otherwise, { kind: "Init", place: place(s), rvalue: { kind: "Use", value: unit } });
    f.seal(otherwise, { kind: "Goto", value: join });

    f.push(join, { kind: "StorageDead", value: s });
    f.seal(join, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);
    // No flag: it is initialised whichever way control went.
    expect(drops(module, module.funcs[0]!)).toEqual(["drop(_1);"]);
  });
});

describe("loops", () => {
  test("a local initialised inside a loop is dropped on each iteration", () => {
    // The case a fixed number of dataflow passes gets wrong: the loop body's
    // entry state depends on its own exit state, so it has to be walked to a
    // fixed point.
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "loop", sig });

    const s = f.addLocal({ ty: owning, storage: "Owned", name: "s" });
    const cond = f.addLocal({ ty: m.ty({ kind: "Bool" }), storage: "Owned" });

    const entry = f.block();
    const head = f.block();
    const body = f.block();
    const exit = f.block();

    f.seal(entry, { kind: "Goto", value: head });
    f.seal(head, { kind: "Branch", cond: copy(cond), thenBlock: body, elseBlock: exit });

    f.push(body, { kind: "StorageLive", value: s });
    f.push(body, { kind: "Init", place: place(s), rvalue: { kind: "Use", value: unit } });
    f.push(body, { kind: "StorageDead", value: s });
    f.seal(body, { kind: "Goto", value: head });

    f.seal(exit, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);
    // Exactly one, unconditional: inside the body it is always initialised,
    // and outside it is always dead.
    expect(drops(module, module.funcs[0]!)).toEqual(["drop(_1);"]);
  });

  test("an unreachable block gets no drops invented for it", () => {
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "unreachable", sig });

    const s = f.addLocal({ ty: owning, storage: "Owned", name: "s" });
    const entry = f.block();
    const orphan = f.block();

    f.seal(entry, { kind: "Return" });
    f.push(orphan, { kind: "StorageDead", value: s });
    f.seal(orphan, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);
    expect(drops(module, module.funcs[0]!)).toEqual([]);
  });
});

describe("the unwind seam", () => {
  test("every drop carries an unwind action", () => {
    // DECISIONS.md: exceptions are planned, so the edge is in the IR from the
    // start. Nothing can throw yet, so every action is `Unreachable` — but the
    // field exists and the pass fills it, which is what stops adding real
    // unwind paths from being a rewrite of this pass (REWRITE-PLAN §11.5).
    const { m, owning, void_ } = scaffold();
    const sig = m.sig({ params: [], ret: void_ });
    const f = m.declareFunction({ name: "unwind", sig });

    const s = f.addLocal({ ty: owning, storage: "Owned", name: "s" });
    const bb = f.block();
    f.push(bb, { kind: "StorageLive", value: s });
    f.push(bb, { kind: "Init", place: place(s), rvalue: { kind: "Use", value: unit } });
    f.push(bb, { kind: "StorageDead", value: s });
    f.seal(bb, { kind: "Return" });

    const module = m.finish();
    elaborateDrops(module);

    const dropStatement = module.funcs[0]!.blocks[BlockId(0)]!.statements.find(
      (statement: Statement) => statement.kind === "Drop",
    );
    expect(dropStatement).toBeDefined();
    expect(dropStatement!.kind).toBe("Drop");
    if (dropStatement!.kind === "Drop") {
      expect(dropStatement!.unwind.kind).toBe("Unreachable");
    }
  });
});
