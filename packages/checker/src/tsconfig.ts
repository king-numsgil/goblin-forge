/**
 * Loading and validating the project's tsconfig.
 *
 * REWRITE-PLAN §3: the tsconfig is the *user's*, and goblin-forge supplies a
 * base to extend. A few of the base's settings are not stylistic — override one
 * and tsc is checking a different language than the one this compiler
 * implements. v1 assumed them silently; here an override is a diagnostic that
 * names the setting.
 */

import { dirname, isAbsolute, resolve } from "node:path";

import ts from "typescript";

import type { Diagnostic } from "./diagnostics.ts";

/**
 * A setting the language depends on, and what goes wrong without it.
 *
 * The `why` is part of the diagnostic, not a comment: somebody who set
 * `"types": ["node"]` for a good reason needs to know what it costs, not just
 * that it is forbidden.
 */
interface Requirement {
  readonly setting: string;
  readonly check: (options: ts.CompilerOptions) => boolean;
  readonly expected: string;
  readonly why: string;
}

const REQUIREMENTS: readonly Requirement[] = [
  {
    setting: "noLib",
    check: (o) => o.noLib === true,
    expected: "true",
    why:
      "without it, tsc loads the JavaScript standard library and your program " +
      "type-checks against `Array.prototype.map`, `Math`, and a `console` that " +
      "this compiler does not implement",
  },
  {
    setting: "types",
    check: (o) => Array.isArray(o.types) && o.types.length === 0,
    expected: "[]",
    why:
      "`noLib` alone does not close the global surface — tsc still walks up to " +
      "the nearest node_modules and loads every `@types/*` package it finds, " +
      "which is how a stray `@types/node` quietly puts `Buffer` and the whole " +
      "Node API back",
  },
  {
    setting: "typeRoots",
    check: (o) => Array.isArray(o.typeRoots) && o.typeRoots.length === 0,
    expected: "[]",
    why: "same reason as `types`: it is the other half of closing the global surface",
  },
  {
    setting: "strict",
    check: (o) => o.strict === true || (o.strictNullChecks === true && o.noImplicitAny === true),
    expected: "true",
    why:
      "this language has no `undefined` and no `any`; without strict checking " +
      "tsc lets values through that have no machine representation",
  },
  {
    setting: "noFallthroughCasesInSwitch",
    check: (o) => o.noFallthroughCasesInSwitch === true,
    expected: "true",
    why:
      "a fallthrough case reaches the next arm with the previous arm's scope " +
      "already exited, which is a shape the drop pass has no way to express",
  },
  {
    setting: "noImplicitOverride",
    check: (o) => o.noImplicitOverride === true,
    expected: "true",
    why:
      "vtable slots are assigned from declared overrides; an accidental one " +
      "silently replaces a base method's slot",
  },
  {
    setting: "target",
    check: (o) => (o.target ?? ts.ScriptTarget.ES5) >= ts.ScriptTarget.ES2015,
    expected: "ES2015 or later",
    why:
      "ES5 is deprecated in TypeScript 6.0 and stops functioning in 7.0. " +
      "Under `noLib` the later targets infer `for...of` element types from the " +
      "array index signature exactly as ES5 did, so nothing is lost",
  },
];

export interface LoadedConfig {
  /** Absolute path to the tsconfig that was read. */
  readonly path: string;
  readonly options: ts.CompilerOptions;
  /** Absolute paths of every file the config names. */
  readonly fileNames: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Read a tsconfig and check it still has the settings the language depends on.
 *
 * Returns diagnostics rather than throwing: a misconfigured project is a
 * *result*, in the same way a program that does not compile is.
 */
export function loadConfig(configPath: string): LoadedConfig {
  const absolute = resolve(configPath);
  const diagnostics: Diagnostic[] = [];

  const read = ts.readConfigFile(absolute, ts.sys.readFile);
  if (read.error) {
    return {
      path: absolute,
      options: {},
      fileNames: [],
      diagnostics: [fromTsDiagnostic(read.error)],
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(absolute),
    undefined,
    absolute,
  );
  diagnostics.push(...parsed.errors.map(fromTsDiagnostic));

  for (const requirement of REQUIREMENTS) {
    if (requirement.check(parsed.options)) continue;
    diagnostics.push({
      severity: "error",
      code: "GF0003",
      source: "goblin",
      message:
        `\`${requirement.setting}\` must be ${requirement.expected} — ` +
        `${requirement.why}. Extend ` +
        `"@goblin-forge/runtime/tsconfig.base.json" and leave this setting alone.`,
      location: { file: absolute, line: 1, column: 1, length: 1 },
    });
  }

  return {
    path: absolute,
    options: parsed.options,
    fileNames: parsed.fileNames.map((file) =>
      isAbsolute(file) ? file : resolve(dirname(absolute), file),
    ),
    diagnostics,
  };
}

/**
 * Convert a `ts.Diagnostic` into this compiler's shape.
 *
 * The code keeps its `TS` prefix. REWRITE-PLAN §9 asks the test suite to assert
 * diagnostic codes across both prefixes, so that a check moving from `GF` to
 * `TS` — or the other way — shows up as a failure rather than passing quietly.
 */
export function fromTsDiagnostic(diagnostic: ts.Diagnostic): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n  ");
  const severity =
    diagnostic.category === ts.DiagnosticCategory.Error
      ? "error"
      : diagnostic.category === ts.DiagnosticCategory.Warning
        ? "warning"
        : "note";

  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return { severity, code: `TS${diagnostic.code}`, message, source: "tsc" };
  }

  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    severity,
    code: `TS${diagnostic.code}`,
    message,
    source: "tsc",
    location: {
      file: resolve(diagnostic.file.fileName),
      line: line + 1,
      column: character + 1,
      length: Math.max(1, diagnostic.length ?? 1),
    },
  };
}
