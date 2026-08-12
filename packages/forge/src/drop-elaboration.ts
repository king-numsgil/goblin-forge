/**
 * Drop elaboration.
 *
 * REWRITE-PLAN §5.1, as a real pass:
 *
 * 1. Lower to a CFG with `StorageLive`/`StorageDead` and no drops.
 * 2. Compute, per point, which owned locals are initialised.
 * 3. Insert `Drop` wherever an initialised local goes out of scope.
 * 4. Where a local *may or may not* be initialised on a path, use a **drop
 *    flag** — a hidden `bool` local — rather than refusing the program.
 *
 * The reason this is a pass rather than something the lowerer splices in is the
 * failure it makes impossible. v1 released "everything down to depth N" at an
 * early exit, got the bound inclusive where it should have been exclusive, and
 * freed a `switch` subject twice. There is no depth arithmetic here at all:
 * a drop goes where a live value stops being live, and that is computed.
 *
 * ## What is and is not on today
 *
 * Nothing in the language owns anything yet — every type is trivial, so
 * {@link needsDrop} is false for all of them and this pass inserts nothing.
 * That is milestone 4 working as intended (REWRITE-PLAN §12.4): the pass
 * exists, is tested, and is ready for milestone 5 to give it something to
 * destroy. The unit tests build MIR with an `Owning` type directly, so the
 * dataflow is exercised before the language can express it.
 *
 * ## Unwind paths
 *
 * DECISIONS.md records that exceptions are planned, so `Drop` carries an
 * `UnwindAction` and the pass is organised around scope-exit ladders — the
 * shape an unwind path needs. Every action it currently emits is
 * `Unreachable`, because nothing can throw yet and generating cleanup blocks
 * reachable from nowhere would be dead code in every object file. The seam is
 * {@link unwindFor}, and it is one function rather than a shape the pass would
 * have to be rebuilt around.
 */

import {
  type Block,
  FileId,
  type Function as MirFunction,
  type LocalDecl,
  LocalId,
  type Module,
  type Operand,
  type Place,
  type Rvalue,
  type Statement,
  type Terminator,
  TyId,
  type UnwindAction,
} from "@goblin-forge/backend";

/** Block 0 is always the entry. */
const ENTRY_BLOCK = 0;

/**
 * Whether a local is destroyed by the code that names it.
 *
 * Two independent questions, and both have to be yes:
 *
 * * does the **type** own anything (REWRITE-PLAN §4.1), and
 * * does this **place** own its storage (REWRITE-PLAN §4.2)?
 *
 * An `Inline` local is destroyed by its parent as part of destroying itself,
 * and a `Borrowed` one is never destroyed at all — that last clause being the
 * entire content of `Reference<T>`.
 */
export function needsDrop(module: Module, local: LocalDecl): boolean {
  const category = module.types[local.ty]?.category;
  if (category !== "Owning" && category !== "Polymorphic") return false;
  return local.storage === "Owned" || local.storage === "Temporary";
}

/** Run drop elaboration over every function in a module, in place. */
export function elaborateDrops(module: Module): void {
  for (const func of module.funcs) {
    elaborateFunction(module, func);
  }
}

/**
 * The unwind action for a drop.
 *
 * The seam described in this module's header. When `throw` exists, this is
 * where a drop learns which cleanup block continues the unwind.
 */
function unwindFor(): UnwindAction {
  return { kind: "Unreachable" };
}

/** Per-local initialisedness, as a pair of bit-per-local sets. */
interface InitState {
  /** Initialised on at least one path reaching here. */
  readonly maybe: Set<number>;
  /** Initialised on every path reaching here. */
  readonly definitely: Set<number>;
}

function cloneState(state: InitState): InitState {
  return { maybe: new Set(state.maybe), definitely: new Set(state.definitely) };
}

function sameState(a: InitState, b: InitState): boolean {
  return setsEqual(a.maybe, b.maybe) && setsEqual(a.definitely, b.definitely);
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * Merge two states at a join point.
 *
 * `maybe` unions and `definitely` intersects — which is the whole reason drop
 * flags exist. A local initialised down one arm of an `if` and not the other is
 * in `maybe` and not in `definitely`, and that difference is exactly the set of
 * locals whose drop has to be conditional.
 */
function merge(into: InitState, from: InitState): void {
  for (const local of from.maybe) into.maybe.add(local);
  for (const local of into.definitely) {
    if (!from.definitely.has(local)) into.definitely.delete(local);
  }
}

function elaborateFunction(module: Module, func: MirFunction): void {
  const tracked = new Set<number>();
  for (const [index, local] of func.locals.entries()) {
    if (needsDrop(module, local)) tracked.add(index);
  }
  // Parameters arrive initialised, but the *caller* destroys a by-value
  // argument (REWRITE-PLAN §4.5, Itanium-style), so the callee never drops one.
  const paramCount = module.sigs[func.sig]?.params.length ?? 0;
  for (let index = 1; index <= paramCount; index += 1) tracked.delete(index);

  if (tracked.size === 0) return;

  const entry: InitState = { maybe: new Set(), definitely: new Set() };
  const onEntry = solve(func, tracked, entry);
  insertDrops(module, func, tracked, onEntry);
}

/**
 * Forward dataflow to a fixed point.
 *
 * A worklist rather than a fixed number of passes: a loop body's entry state
 * depends on its own exit state, so the loop has to be walked until nothing
 * changes.
 */
function solve(
  func: MirFunction,
  tracked: ReadonlySet<number>,
  entry: InitState,
): Map<number, InitState> {
  const onEntry = new Map<number, InitState>();
  onEntry.set(ENTRY_BLOCK, entry);

  const worklist: number[] = [ENTRY_BLOCK];
  while (worklist.length > 0) {
    const index = worklist.shift()!;
    const block = func.blocks[index];
    const state = onEntry.get(index);
    if (block === undefined || state === undefined) continue;

    const exit = cloneState(state);
    for (const statement of block.statements) {
      applyStatement(statement, tracked, exit);
    }
    applyTerminator(block.terminator, tracked, exit);

    for (const successor of successors(block.terminator)) {
      const existing = onEntry.get(successor);
      if (existing === undefined) {
        onEntry.set(successor, cloneState(exit));
        worklist.push(successor);
        continue;
      }
      const merged = cloneState(existing);
      merge(merged, exit);
      if (!sameState(merged, existing)) {
        onEntry.set(successor, merged);
        worklist.push(successor);
      }
    }
  }
  return onEntry;
}

function applyStatement(
  statement: Statement,
  tracked: ReadonlySet<number>,
  state: InitState,
): void {
  switch (statement.kind) {
    case "Init":
    case "Assign": {
      // Only a whole local becomes initialised. Writing through a projection
      // reaches into something that was already initialised.
      readsOf(statement.rvalue).forEach((operand) => applyOperand(operand, tracked, state));
      if (statement.place.projection.length === 0) {
        setInit(statement.place.local, tracked, state, true);
      }
      break;
    }
    case "Drop":
      if (statement.place.projection.length === 0) {
        setInit(statement.place.local, tracked, state, false);
      }
      break;
    case "StorageLive":
    case "StorageDead":
      setInit(statement.value, tracked, state, false);
      break;
    case "SetDropFlag":
    case "Nop":
      break;
  }
}

function applyTerminator(
  terminator: Terminator,
  tracked: ReadonlySet<number>,
  state: InitState,
): void {
  switch (terminator.kind) {
    case "Branch":
      applyOperand(terminator.cond, tracked, state);
      break;
    case "Switch":
      applyOperand(terminator.discr, tracked, state);
      break;
    case "Call":
      for (const arg of terminator.args) applyOperand(arg, tracked, state);
      if (terminator.destination !== null && terminator.destination.place.projection.length === 0) {
        setInit(terminator.destination.place.local, tracked, state, true);
      }
      break;
    default:
      break;
  }
}

/** A `move` ends the source's initialisedness; a `copy` or a `borrow` does not. */
function applyOperand(
  operand: Operand,
  tracked: ReadonlySet<number>,
  state: InitState,
): void {
  if (operand.kind !== "Move") return;
  if (operand.value.projection.length !== 0) return;
  setInit(operand.value.local, tracked, state, false);
}

function setInit(
  local: LocalId,
  tracked: ReadonlySet<number>,
  state: InitState,
  initialised: boolean,
): void {
  if (!tracked.has(local)) return;
  if (initialised) {
    state.maybe.add(local);
    state.definitely.add(local);
  } else {
    state.maybe.delete(local);
    state.definitely.delete(local);
  }
}

function readsOf(rvalue: Rvalue): Operand[] {
  switch (rvalue.kind) {
    case "Use":
    case "Unary":
      return [rvalue.kind === "Use" ? rvalue.value : rvalue.operand];
    case "Cast":
      return [rvalue.operand];
    case "Binary":
      return [rvalue.lhs, rvalue.rhs];
    case "Aggregate":
      return rvalue.fields;
    default:
      return [];
  }
}

function successors(terminator: Terminator): number[] {
  switch (terminator.kind) {
    case "Goto":
      return [terminator.value];
    case "Branch":
      return [terminator.thenBlock, terminator.elseBlock];
    case "Switch":
      return [...terminator.targets.map((target) => target.block), terminator.default];
    case "Call": {
      const out = terminator.destination === null ? [] : [terminator.destination.target];
      if (terminator.unwind.kind === "Cleanup") out.push(terminator.unwind.value);
      return out;
    }
    default:
      return [];
  }
}

/**
 * Walk each block again with the solved entry state and rewrite it.
 *
 * A drop goes immediately *before* the `StorageDead` that ends the local, so
 * the destructor still has storage to run against.
 */
function insertDrops(
  module: Module,
  func: MirFunction,
  tracked: ReadonlySet<number>,
  onEntry: ReadonlyMap<number, InitState>,
): void {
  // Which locals need a flag is decided *before* anything is rewritten.
  //
  // Doing it lazily — allocating a flag at the drop that first needs one — is
  // wrong in a way that is easy to miss: the `Init` that should set the flag
  // lives in an earlier block, which has already been rewritten by the time the
  // drop is reached. The result compiles, reads plausibly, and destroys an
  // uninitialised local.
  const conditional = new Set<number>();
  for (const [index, block] of func.blocks.entries()) {
    const state = onEntry.get(index);
    if (state === undefined) continue;
    const running = cloneState(state);
    for (const statement of block.statements) {
      if (
        statement.kind === "StorageDead" &&
        tracked.has(statement.value) &&
        running.maybe.has(statement.value) &&
        !running.definitely.has(statement.value)
      ) {
        conditional.add(statement.value);
      }
      applyStatement(statement, tracked, running);
    }
    applyTerminator(block.terminator, tracked, running);
  }

  /** Tracked local to the drop flag standing in for it. */
  const flags = new Map<number, LocalId>();
  if (conditional.size > 0) {
    const flagTy = boolTy(module);
    for (const local of conditional) {
      const id = LocalId(func.locals.length);
      func.locals.push({
        ty: flagTy,
        // The flag is a machine detail, not a value the program named. It owns
        // nothing and never needs dropping itself.
        storage: "Borrowed",
        name: null,
        span: func.locals[local]?.span ?? { file: FileId(0), line: 0, col: 0 },
      });
      flags.set(local, id);
    }
  }

  for (const [index, block] of func.blocks.entries()) {
    const state = onEntry.get(index);
    // A block the dataflow never reached is unreachable, and inserting drops
    // into it would be inventing behaviour for code that cannot run.
    if (state === undefined) continue;

    const running = cloneState(state);
    const rewritten: Statement[] = [];

    for (const statement of block.statements) {
      if (statement.kind === "StorageDead" && tracked.has(statement.value)) {
        const local = statement.value;
        if (running.maybe.has(local)) {
          const needsFlag = !running.definitely.has(local);
          const flag = needsFlag ? flags.get(local) : undefined;
          if (needsFlag && flag === undefined) {
            // The two phases disagreed about whether this drop is conditional.
            // Silently emitting an unconditional one would destroy a local that
            // may never have been initialised, so say so instead.
            throw new Error(
              `drop elaboration: _${local} needs a drop flag but none was allocated`,
            );
          }
          rewritten.push({
            kind: "Drop",
            place: wholeLocal(local),
            flag: flag ?? null,
            unwind: unwindFor(),
          });
        }
      }

      if (statement.kind === "Init" || statement.kind === "Assign") {
        applyStatement(statement, tracked, running);
        rewritten.push(statement);
        // After, not before: if the construction itself unwinds, the local is
        // not initialised, and a flag already saying otherwise would have the
        // cleanup path destroy something that was never built.
        maybeSetFlag(rewritten, flags, statement.place, true);
        continue;
      }

      if (statement.kind === "StorageDead" || statement.kind === "StorageLive") {
        applyStatement(statement, tracked, running);
        rewritten.push(statement);
        const flag = flags.get(statement.value);
        if (flag !== undefined) {
          rewritten.push({ kind: "SetDropFlag", flag, value: false });
        }
        continue;
      }

      applyStatement(statement, tracked, running);
      rewritten.push(statement);
    }

    applyTerminator(block.terminator, tracked, running);
    block.statements = rewritten;
  }

  // A flag has to start out false, because a local is not initialised before
  // its `StorageLive`, and the entry block is the only place that is certain.
  if (flags.size > 0) {
    const entry = func.blocks[ENTRY_BLOCK];
    if (entry !== undefined) {
      entry.statements.unshift(
        ...[...flags.values()].map(
          (flag): Statement => ({ kind: "SetDropFlag", flag, value: false }),
        ),
      );
    }
  }
}

function maybeSetFlag(
  out: Statement[],
  flags: ReadonlyMap<number, LocalId>,
  place: Place,
  value: boolean,
): void {
  if (place.projection.length !== 0) return;
  const flag = flags.get(place.local);
  if (flag !== undefined) out.push({ kind: "SetDropFlag", flag, value });
}

function wholeLocal(local: number): Place {
  return { local: LocalId(local), projection: [] };
}

/** The module's `bool` type, added if it is not already there. */
function boolTy(module: Module): TyId {
  const existing = module.types.findIndex((def) => def.kind.kind === "Bool");
  if (existing >= 0) return TyId(existing);
  module.types.push({ kind: { kind: "Bool" }, category: "Trivial" });
  return TyId(module.types.length - 1);
}

/** Re-exported so tests can assert on block shape without importing the bindings. */
export type { Block, MirFunction };
