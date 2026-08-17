/**
 * The diagnostic model.
 *
 * REWRITE-PLAN §8. There are two sources of "no" and which one speaks matters,
 * because only one of them underlines in the editor:
 *
 *   * `TS####` — real tsc. Preferred whenever the rule can be expressed in the
 *     type system, because the user sees it while typing.
 *   * `GF####` — the language subset and the machine model. Everything tsc
 *     cannot know: widths, ownership, layout, the C boundary.
 *
 * And one hard rule that shapes the whole compiler: **the backend never reports
 * a user error**. Every failure reachable from source that tsc accepted is a
 * missing frontend check. v1 violated this and `someF64 % 2` reached Cranelift,
 * producing `error: compiling function 'main': Rem is not defined on f64` — no
 * code, no file, no line.
 */

import { readFileSync } from "node:fs";

/** How much a diagnostic matters. Only `error` fails a compile. */
export type Severity = "error" | "warning" | "note";

/** Which half of the compiler is speaking. */
export type DiagnosticSource = "tsc" | "goblin";

/** A 1-based position in a source file. */
export interface Location {
    /** Absolute path. Every path that leaves this compiler is absolute. */
    readonly file: string;
    readonly line: number;
    readonly column: number;
    /** Length of the underlined span, in characters. */
    readonly length: number;
}

/**
 * A secondary location attached to a diagnostic.
 *
 * Ownership errors are unreadable without these: "a reference cannot borrow a
 * temporary" needs to point at the temporary, and "this value was already
 * moved" needs to point at the move.
 */
export interface Note {
    readonly message: string;
    readonly location?: Location;
}

export interface Diagnostic {
    readonly severity: Severity;
    /** `TS2322` or `GF0161`. Always present — see {@link Diagnostic} above. */
    readonly code: string;
    readonly message: string;
    readonly source: DiagnosticSource;
    /** Absent only for diagnostics about the build itself, not about source. */
    readonly location?: Location;
    readonly notes?: readonly Note[];
}

/** Whether a set of diagnostics contains anything that should fail the build. */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
    return diagnostics.some((d) => d.severity === "error");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface FormatOptions {
    /**
     * Reads a source file so the excerpt can be shown. Defaults to reading from
     * disk; a watch-mode caller passes its own cache.
     */
    readonly readFile?: (path: string) => string | undefined;
    /** Emit ANSI colour. Defaults to off, because callers usually pipe this. */
    readonly color?: boolean;
    /** Render paths relative to this directory. Defaults to absolute. */
    readonly cwd?: string;
}

const ANSI = {
    reset: "[0m",
    bold: "[1m",
    dim: "[2m",
    red: "[31m",
    yellow: "[33m",
    blue: "[34m",
    cyan: "[36m",
} as const;

/**
 * Render a diagnostic with a source excerpt.
 *
 * Shipped rather than left to the caller because a compiler that only hands
 * back structured data makes the common case — print it — everybody's problem.
 * Callers who want their own rendering still have the structure.
 */
export function format(diagnostic: Diagnostic, options: FormatOptions = {}): string {
    const paint = options.color ?? false;
    const c = (code: string, text: string) => (paint ? `${code}${text}${ANSI.reset}` : text);

    const severityColor =
        diagnostic.severity === "error"
            ? ANSI.red
            : diagnostic.severity === "warning"
                ? ANSI.yellow
                : ANSI.blue;

    const lines: string[] = [];
    lines.push(
        `${c(severityColor + ANSI.bold, `${diagnostic.severity}[${diagnostic.code}]`)}: ${
            diagnostic.message
        }`,
    );

    if (diagnostic.location) {
        lines.push(...excerpt(diagnostic.location, options, severityColor));
    }

    for (const note of diagnostic.notes ?? []) {
        lines.push(`  ${c(ANSI.cyan + ANSI.bold, "note")}: ${note.message}`);
        if (note.location) {
            lines.push(...excerpt(note.location, options, ANSI.cyan).map((line) => `  ${line}`));
        }
    }

    return lines.join("\n");
}

/** Render several diagnostics, blank-line separated. */
export function formatAll(
    diagnostics: readonly Diagnostic[],
    options: FormatOptions = {},
): string {
    return diagnostics.map((d) => format(d, options)).join("\n\n");
}

function excerpt(
    location: Location,
    options: FormatOptions,
    color: string,
): string[] {
    const paint = options.color ?? false;
    const c = (code: string, text: string) => (paint ? `${code}${text}${ANSI.reset}` : text);

    const shown = options.cwd ? relativise(location.file, options.cwd) : location.file;
    const header = `  ${c(ANSI.dim, "-->")} ${shown}:${location.line}:${location.column}`;

    const text = (options.readFile ?? defaultReadFile)(location.file);
    if (text === undefined) {
        return [header];
    }

    const sourceLine = text.split(/\r?\n/)[location.line - 1];
    if (sourceLine === undefined) {
        return [header];
    }

    const gutter = String(location.line);
    const pad = " ".repeat(gutter.length);
    // Tabs would put the caret in the wrong column, so widen them to one space
    // in both the source line and the ruler. Anything cleverer needs to know the
    // reader's tab width, which we do not.
    const rendered = sourceLine.replace(/\t/g, " ");
    const caretOffset = Math.max(0, location.column - 1);
    const caretWidth = Math.max(1, Math.min(location.length, rendered.length - caretOffset));

    return [
        header,
        `  ${pad} ${c(ANSI.dim, "|")}`,
        `  ${gutter} ${c(ANSI.dim, "|")} ${rendered}`,
        `  ${pad} ${c(ANSI.dim, "|")} ${" ".repeat(caretOffset)}${c(color, "^".repeat(caretWidth))}`,
    ];
}

function defaultReadFile(path: string): string | undefined {
    try {
        // Deliberately synchronous: rendering a diagnostic is not a place where an
        // await helps anybody, and the file is already in the OS cache.
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
}

function relativise(path: string, cwd: string): string {
    const normalisedPath = path.replace(/\\/g, "/");
    const normalisedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
    return normalisedPath.startsWith(`${normalisedCwd}/`)
        ? normalisedPath.slice(normalisedCwd.length + 1)
        : normalisedPath;
}
