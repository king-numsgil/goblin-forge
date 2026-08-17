/**
 * MIR, rendered for humans.
 *
 * REWRITE-PLAN §9 asks for golden MIR snapshots on a handful of programs,
 * because "drop placement is the thing most likely to regress invisibly, and a
 * golden MIR file makes a change to it visible in review". That only works if
 * the rendering is stable and readable, so this is written for a reviewer
 * rather than for a parser: locals are `_0`, blocks are `bb0`, and the shape
 * deliberately resembles rustc's MIR dumps, which is the notation anyone
 * working on this will already know.
 *
 * Nothing depends on this being parseable, and nothing round-trips through it.
 * The wire format is postcard, and it is generated — this is a debug view.
 */

import {
    type Block,
    type Callee,
    type Const,
    type Function as MirFunction,
    type LocalDecl,
    type Module,
    type Operand,
    type Place,
    type Projection,
    type Rvalue,
    type Statement,
    type Terminator,
    type TyDef,
    type TyKind,
    type UnwindAction,
} from "./mir.generated.ts";

/** Operators, spelled the way the source spells them. */
const BIN_OP_TEXT: Partial<Record<string, string>> = {
    Add: "+",
    Sub: "-",
    Mul: "*",
    Div: "/",
    Rem: "%",
    BitAnd: "&",
    BitOr: "|",
    BitXor: "^",
    Shl: "<<",
    Shr: ">>",
    Eq: "==",
    Ne: "!=",
    Lt: "<",
    Le: "<=",
    Gt: ">",
    Ge: ">=",
};

const UN_OP_TEXT: Partial<Record<string, string>> = {Neg: "-", BitNot: "~", Not: "!"};

export interface PrintOptions {
    /** Include each local's storage class and category. Defaults to on. */
    readonly declarations?: boolean;
    /** Include source spans. Defaults to off — they churn when a test moves. */
    readonly spans?: boolean;
}

/** Render a whole module. */
export function printModule(module: Module, options: PrintOptions = {}): string {
    const out: string[] = [];
    for (const [index, extern] of module.externs.entries()) {
        out.push(`extern fn ${sym(module, extern.name)}: ${signature(module, extern.sig)}  // ext${index}`);
    }
    if (module.externs.length > 0) {
        out.push("");
    }
    for (const func of module.funcs) {
        out.push(printFunction(module, func, options));
        out.push("");
    }
    return out.join("\n").trimEnd() + "\n";
}

/** Render one function. */
export function printFunction(
    module: Module,
    func: MirFunction,
    options: PrintOptions = {},
): string {
    const showDeclarations = options.declarations ?? true;
    const out: string[] = [];

    const linkage = func.linkage === "Export" ? "export " : "";
    out.push(`${linkage}fn ${sym(module, func.name)}: ${signature(module, func.sig)} {`);

    if (showDeclarations) {
        for (const [index, local] of func.locals.entries()) {
            out.push(`  ${localDecl(module, index, local, options)}`);
        }
        out.push("");
    }

    for (const [index, block] of func.blocks.entries()) {
        out.push(...printBlock(module, block, index));
        if (index < func.blocks.length - 1) {
            out.push("");
        }
    }

    out.push("}");
    return out.join("\n");
}

function printBlock(module: Module, block: Block, index: number): string[] {
    const kind = block.kind === "Cleanup" ? " (cleanup)" : "";
    const out = [`  bb${index}${kind}: {`];
    for (const statement of block.statements) {
        out.push(`    ${printStatement(module, statement)}`);
    }
    out.push(`    ${printTerminator(module, block.terminator)}`);
    out.push("  }");
    return out;
}

function localDecl(
    module: Module,
    index: number,
    local: LocalDecl,
    options: PrintOptions,
): string {
    const name = local.name === null ? "" : ` // ${sym(module, local.name)}`;
    const category = module.types[local.ty]?.category ?? "?";
    const span =
        (options.spans ?? false) && local.span.line !== 0
            ? ` @${local.span.line}:${local.span.col}`
            : "";
    return `let _${index}: ${ty(module, local.ty)}  [${local.storage}/${category}]${span}${name}`;
}

export function printStatement(module: Module, statement: Statement): string {
    switch (statement.kind) {
        case "Init":
            return `${place(statement.place)} = ${rvalue(module, statement.rvalue)};`;
        // The distinction is the point, so it is spelled out rather than left to
        // the reader: `drop-and-replace` destroys what was there first.
        case "Assign":
            return `${place(statement.place)} <- ${rvalue(module, statement.rvalue)};`;
        case "Drop": {
            const flag = statement.flag === null ? "" : ` if _${statement.flag}`;
            return `drop(${place(statement.place)})${flag}${unwind(statement.unwind)};`;
        }
        case "StorageLive":
            return `StorageLive(_${statement.value});`;
        case "StorageDead":
            return `StorageDead(_${statement.value});`;
        case "SetDropFlag":
            return `_${statement.flag} = ${statement.value};`;
        case "Nop":
            return "nop;";
    }
}

export function printTerminator(module: Module, terminator: Terminator): string {
    switch (terminator.kind) {
        case "Goto":
            return `goto -> bb${terminator.value};`;
        case "Branch":
            return `branch(${operand(module, terminator.cond)}) -> [true: bb${
                terminator.thenBlock
            }, false: bb${terminator.elseBlock}];`;
        case "Switch": {
            const arms = terminator.targets
                .map((target) => `${target.value}: bb${target.block}`)
                .join(", ");
            return `switch(${operand(module, terminator.discr)}) -> [${arms}, otherwise: bb${
                terminator.default
            }];`;
        }
        case "Call": {
            const args = terminator.args.map((arg) => operand(module, arg)).join(", ");
            const to =
                terminator.destination === null
                    ? ""
                    : ` -> [return: bb${terminator.destination.target}]`;
            const dest =
                terminator.destination === null ? "" : `${place(terminator.destination.place)} = `;
            return `${dest}${callee(module, terminator.callee)}(${args})${to}${unwind(
                terminator.unwind,
            )};`;
        }
        case "Return":
            return "return;";
        case "Unreachable":
            return "unreachable;";
        case "Resume":
            return "resume;";
        case "Abort":
            return `abort(${terminator.value});`;
    }
}

function unwind(action: UnwindAction): string {
    switch (action.kind) {
        // The overwhelmingly common case today, and printing it on every line
        // would bury everything else. Nothing can unwind yet.
        case "Unreachable":
            return "";
        case "Continue":
            return " unwind continue";
        case "Cleanup":
            return ` unwind -> bb${action.value}`;
        case "Terminate":
            return " unwind terminate";
    }
}

function callee(module: Module, target: Callee): string {
    switch (target.kind) {
        case "Direct":
            return target.value.kind === "Local"
                ? sym(module, module.funcs[target.value.value]?.name ?? 0)
                : sym(module, module.externs[target.value.value]?.name ?? 0);
        case "Indirect":
            return `(${operand(module, target.operand)})`;
        // The receiver is `args[0]`, so it is already printed by the call itself.
        // Showing the slot is what makes a golden MIR diff catch a shifted vtable.
        case "Virtual":
            return `virtual#${target.slot}`;
        // Likewise: `args[0]` is the `(itab, data)` pair, and the call prints it.
        case "Interface":
            return `itab#${target.slot}`;
    }
}

function rvalue(module: Module, value: Rvalue): string {
    switch (value.kind) {
        case "Use":
            return operand(module, value.value);
        case "Default":
            return "default";
        case "Binary":
            return `${operand(module, value.lhs)} ${BIN_OP_TEXT[value.op] ?? value.op} ${operand(
                module,
                value.rhs,
            )}`;
        case "Unary":
            return `${UN_OP_TEXT[value.op] ?? value.op}${operand(module, value.operand)}`;
        case "Cast":
            return `${operand(module, value.operand)} as ${ty(module, value.to)} (${value.op})`;
        case "Ref":
            return `&${place(value.value)}`;
        case "AddrOf":
            return `&raw ${place(value.value)}`;
        case "Aggregate":
            return `${ty(module, value.ty)} { ${value.fields
                .map((field) => operand(module, field))
                .join(", ")} }`;
        case "Len":
            return `len(${place(value.value)})`;
        case "TryInterface":
            return `tryCast<${sym(module, module.interfaces[value.interface]?.name ?? 0)}>(${place(
                value.source,
            )})`;
        case "TryClass":
            return `tryCast<${sym(module, module.classes[value.class]?.name ?? 0)}>(${place(
                value.source,
            )})`;
        case "InterfaceIsNull":
            return `isNull(${place(value.value)})`;
        case "ArrayPushSlot":
            return `push_slot(${place(value.value)})`;
        // By type id: a MIR dump names types that way everywhere else, and both of
        // these become a constant the backend fills in from the layout.
        case "SizeOf":
            return `sizeof(ty${value.value})`;
        case "AlignOf":
            return `alignof(ty${value.value})`;
        case "MakeInterface":
            return `(${sym(module, module.interfaces[value.interface]?.name ?? 0)}) ${place(
                value.source,
            )}`;
    }
}

function operand(module: Module, value: Operand): string {
    switch (value.kind) {
        // `copy` and `move` are always printed, because which one it is *is* the
        // decision the frontend made, and it is the thing a reviewer is checking.
        case "Copy":
            return `copy ${place(value.value)}`;
        case "Move":
            return `move ${place(value.value)}`;
        case "Borrow":
            return `borrow ${place(value.value)}`;
        case "Const":
            return constant(module, value.value);
    }
}

function constant(module: Module, value: Const): string {
    switch (value.kind) {
        case "Unit":
            return "()";
        case "Bool":
            return String(value.value);
        case "Int":
            return `${signed(module, value.bits, value.ty)}_${ty(module, value.ty)}`;
        case "Float":
            return `${floatOf(module, value.bits, value.ty)}_${ty(module, value.ty)}`;
        case "Null":
            return "null";
        case "Str":
            return JSON.stringify(sym(module, value.text));
        case "Func":
            return value.func.kind === "Local"
                ? sym(module, module.funcs[value.func.value]?.name ?? 0)
                : sym(module, module.externs[value.func.value]?.name ?? 0);
    }
}

/** Render an integer constant the way it was written, sign included. */
function signed(module: Module, bits: bigint, tyId: number): string {
    const kind = module.types[tyId]?.kind;
    if (kind?.kind !== "Int") {
        return String(bits);
    }
    const width = {I8: 8, I16: 16, I32: 32, I64: 64, Isize: 64}[
        kind.value as "I8" | "I16" | "I32" | "I64" | "Isize"
        ];
    if (width === undefined) {
        return String(bits);
    }
    const span = 1n << BigInt(width);
    return String(bits >= span >> 1n ? bits - span : bits);
}

function floatOf(module: Module, bits: bigint, tyId: number): string {
    const kind = module.types[tyId]?.kind;
    if (kind?.kind === "Float" && kind.value === "F32") {
        return String(new Float32Array(new Uint32Array([Number(bits)]).buffer)[0]);
    }
    return String(new Float64Array(new BigUint64Array([bits]).buffer)[0]);
}

function place(value: Place): string {
    let out = `_${value.local}`;
    // Printed outside-in, the way the projections are applied, so `(*_1).0`
    // reads as what it is rather than needing to be decoded.
    for (const step of value.projection) {
        out = projection(out, step);
    }
    return out;
}

function projection(base: string, step: Projection): string {
    switch (step.kind) {
        case "Deref":
            return `(*${base})`;
        case "Field":
            return `${base}.${step.value}`;
        case "Index":
            return `${base}[_${step.value}]`;
        case "ConstIndex":
            return `${base}[${step.value}]`;
    }
}

function signature(module: Module, sigId: number): string {
    const sig = module.sigs[sigId];
    if (sig === undefined) {
        return "<missing>";
    }
    const params = sig.params.map((param) => ty(module, param.ty)).join(", ");
    const abi = sig.abi === "C" ? `extern "C" ` : "";
    return `${abi}(${params}) -> ${ty(module, sig.ret)}`;
}

export function ty(module: Module, tyId: number): string {
    const def: TyDef | undefined = module.types[tyId];
    if (def === undefined) {
        return `<ty${tyId}>`;
    }
    return tyKind(module, def.kind);
}

function tyKind(module: Module, kind: TyKind): string {
    switch (kind.kind) {
        case "Void":
            return "void";
        case "Bool":
            return "bool";
        case "Int":
            return kind.value.toLowerCase();
        case "Float":
            return kind.value.toLowerCase();
        case "Pointer":
            return `Pointer<${ty(module, kind.value)}>`;
        case "Reference":
            return `Reference<${ty(module, kind.value)}>`;
        case "FnPtr":
            return `fn${signature(module, kind.value)}`;
        case "Str":
            return "string";
        case "CStr":
            return "CString";
        case "Array":
            return `${ty(module, kind.value)}[]`;
        case "FixedArray":
            return `FixedArray<${ty(module, kind.element)}, ${kind.length}>`;
        case "Struct":
            return sym(module, module.structs[kind.value]?.name ?? 0);
        case "Class":
            return sym(module, module.classes[kind.value]?.name ?? 0);
        case "Interface":
            return sym(module, module.interfaces[kind.value]?.name ?? 0);
        case "Opaque":
            return sym(module, kind.value);
    }
}

function sym(module: Module, id: number): string {
    return module.strings[id] ?? `<sym${id}>`;
}
