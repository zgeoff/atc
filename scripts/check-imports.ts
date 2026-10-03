// Checks the import graph under src/: no cycles (type-only imports count),
// each directory imports only the directories its row allows, and the
// packages that belong to one owner are imported nowhere else. Modules at the
// src/ root have a row of their own. The composition root may import any
// directory, and test files are exempt from the direction rules. An import
// whose specifier is not a literal is a finding, since no rule can check it.
// Imports are read with the TypeScript scanner, so comments, strings, and
// template literals never hide or invent one. Prints every finding and exits
// 1 when there is one.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { SyntaxKind, createScanner, tokenIsIdentifierOrKeyword } from 'typescript/unstable/ast';

const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  shared: [],
  protocol: ['shared'],
  agents: ['shared', 'protocol'],
  workspace: ['shared', 'protocol'],
  store: ['shared', 'protocol'],
  daemon: ['shared', 'protocol', 'agents', 'workspace', 'store'],
  client: ['shared', 'protocol'],
  mcp: ['shared', 'protocol'],

  // modules at the src/ root: the subcommand modules beside the entrypoint
  root: ['shared', 'protocol', 'agents', 'client', 'mcp'],
};

// The entrypoints that wire concrete modules together, exempt from the
// direction rules.
const COMPOSITION_ROOTS: ReadonlySet<string> = new Set(['src/cli.ts']);

const CONFINED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  'bun-pty': ['src/daemon/local-pty-provider.ts'],
  '@zgeoff/imp-client': ['src/daemon/imp-client-port.ts'],
  '@anthropic-ai/claude-agent-sdk': [
    'src/agents/build-claude-query-options.ts',
    'src/agents/start-claude-headless-run.ts',
  ],
};

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const files = collectSourceFiles(root, 'src');

  const known = new Set(files);
  const graph = new Map<string, string[]>();

  const findings: string[] = [];

  for (const file of files) {
    const imports = collectImports(readFileSync(join(root, file), 'utf8'));
    const targets: string[] = [];

    for (const line of imports.nonLiteralLines) {
      findings.push(`non-literal import: ${file}:${line} imports a computed specifier`);
    }

    for (const specifier of imports.specifiers) {
      if (specifier.startsWith('.')) {
        const target = resolveImport(file, specifier, known);

        if (target !== null) {
          targets.push(target);
        }
      } else {
        findings.push(...checkConfinement(file, specifier));
      }
    }

    graph.set(file, targets);
    findings.push(...checkDirection(file, targets));
  }

  const cycles = collectCycles(graph);

  for (const cycle of cycles) {
    findings.push(`cycle among: ${cycle.join(', ')}`);
  }

  for (const finding of findings) {
    console.error(finding);
  }

  console.log(
    `check-imports: ${files.length} files, ${cycles.length} cycles, ${findings.length - cycles.length} other findings`,
  );

  if (findings.length > 0) {
    process.exit(1);
  }
}

function collectSourceFiles(root: string, dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(join(root, dir)).toSorted()) {
    const path = `${dir}/${entry}`;

    if (statSync(join(root, path)).isDirectory()) {
      files.push(...collectSourceFiles(root, path));
    } else if (path.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

// What a module imports: every literal specifier, and the line of each
// import or require whose specifier is computed.
interface ImportList {
  readonly specifiers: readonly string[];
  readonly nonLiteralLines: readonly number[];
}

// Static imports and re-exports, type-only ones included, side-effect
// imports, `import x = require(...)`, `require(...)`, and dynamic imports,
// import types among them.
function collectImports(source: string): ImportList {
  const tokens = collectTokens(source);

  const specifiers = new Set<string>();

  const nonLiteralLines: number[] = [];

  for (const [i, token] of tokens.entries()) {
    const next = tokens[i + 1];

    if (
      (token.kind === SyntaxKind.FromKeyword || token.kind === SyntaxKind.ImportKeyword) &&
      next?.kind === SyntaxKind.StringLiteral
    ) {
      specifiers.add(next.value);
    } else if (isLoadCall(tokens, i)) {
      const argument = tokens[i + 2];
      const after = tokens[i + 3];

      const isLiteral =
        (argument?.kind === SyntaxKind.StringLiteral ||
          argument?.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
        (after?.kind === SyntaxKind.CloseParenToken || after?.kind === SyntaxKind.CommaToken);

      if (isLiteral) {
        specifiers.add(argument.value);
      } else {
        nonLiteralLines.push(getLineNumber(source, token.start));
      }
    }
  }

  return { specifiers: [...specifiers], nonLiteralLines };
}

interface Token {
  readonly kind: SyntaxKind;
  readonly value: string;
  readonly start: number;
}

// The module's tokens, with the two context-dependent ones settled the way
// the parser settles them: a slash where an expression can start begins a
// regular expression, and the brace that closes a template substitution
// continues the template.
function collectTokens(source: string): Token[] {
  const scanner = createScanner(true, undefined, source);
  const tokens: Token[] = [];

  // the brace depth at which each open template substitution started
  const substitutions: number[] = [];
  let braces = 0;

  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (
      (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
      canStartRegex(tokens.at(-1)?.kind)
    ) {
      kind = scanner.reScanSlashToken();
    } else if (kind === SyntaxKind.OpenBraceToken) {
      braces += 1;
    } else if (kind === SyntaxKind.CloseBraceToken) {
      if (substitutions.at(-1) === braces) {
        kind = scanner.reScanTemplateToken(false);

        if (kind === SyntaxKind.TemplateTail) {
          substitutions.pop();
        }
      } else {
        braces -= 1;
      }
    }

    if (kind === SyntaxKind.TemplateHead) {
      substitutions.push(braces);
    }

    tokens.push({ kind, value: scanner.getTokenValue(), start: scanner.getTokenStart() });
  }

  return tokens;
}

// Keywords an expression can follow, so a slash after one starts a regular
// expression rather than dividing.
const EXPRESSION_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AwaitKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.DoKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.NewKeyword,
  SyntaxKind.OfKeyword,
  SyntaxKind.ReturnKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.YieldKeyword,
]);

// Tokens that end a value, so a slash after one divides.
const VALUE_ENDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateTail,
]);

function canStartRegex(previous: SyntaxKind | undefined): boolean {
  if (previous === undefined) {
    return true;
  }

  if (tokenIsIdentifierOrKeyword(previous)) {
    return EXPRESSION_KEYWORDS.has(previous);
  }

  return !VALUE_ENDS.has(previous);
}

// `import(` or a bare `require(`; a property such as `module.require(` is
// not one.
function isLoadCall(tokens: readonly Token[], i: number): boolean {
  const token = tokens[i];

  if (tokens[i + 1]?.kind !== SyntaxKind.OpenParenToken || token === undefined) {
    return false;
  }

  if (token.kind === SyntaxKind.ImportKeyword) {
    return true;
  }

  const previous = tokens[i - 1]?.kind;

  return (
    token.kind === SyntaxKind.RequireKeyword &&
    previous !== SyntaxKind.DotToken &&
    previous !== SyntaxKind.QuestionDotToken
  );
}

function getLineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function resolveImport(file: string, specifier: string, known: ReadonlySet<string>): string | null {
  const base = relative('.', join(dirname(file), specifier.replace(/\.js$/, '')));

  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (known.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function checkConfinement(file: string, specifier: string): string[] {
  const findings: string[] = [];

  for (const [pkg, owners] of Object.entries(CONFINED_PACKAGES)) {
    const isPackage = specifier === pkg || specifier.startsWith(`${pkg}/`);

    if (isPackage && !owners.includes(file)) {
      findings.push(
        `confined package: ${file} imports ${pkg}, allowed only in ${owners.join(', ')}`,
      );
    }
  }

  return findings;
}

function checkDirection(file: string, targets: readonly string[]): string[] {
  // a test wires real modules from several directories together, so only
  // production modules are held to the direction rules
  if (COMPOSITION_ROOTS.has(file) || file.endsWith('.test.ts')) {
    return [];
  }

  const from = getLayer(file);
  const allowed = ALLOWED_IMPORTS[from];

  if (allowed === undefined) {
    return [`unknown directory: ${file} is in src/${from}/, which has no import rule`];
  }

  const findings: string[] = [];

  for (const target of targets) {
    const to = getLayer(target);

    if (to !== from && !allowed.includes(to)) {
      findings.push(`forbidden edge: ${file} imports ${target} (${from} -> ${to})`);
    }
  }

  return findings;
}

/**
 * The first directory under src/, or `root` for a module at the src/ root.
 */
function getLayer(file: string): string {
  const parts = file.split('/');

  return parts.length > 2 ? (parts[1] ?? 'root') : 'root';
}

/**
 * Tarjan's strongly connected components: every component with more than one
 * file, or a file importing itself, is a cycle.
 */
function collectCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();

  const stack: string[] = [];

  const onStack = new Set<string>();

  const cycles: string[][] = [];
  let next = 0;

  const collectComponent = (file: string): void => {
    index.set(file, next);
    low.set(file, next);

    next += 1;

    stack.push(file);
    onStack.add(file);

    for (const target of graph.get(file) ?? []) {
      if (!index.has(target)) {
        collectComponent(target);

        low.set(file, Math.min(low.get(file) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(file, Math.min(low.get(file) ?? 0, index.get(target) ?? 0));
      }
    }

    if (low.get(file) !== index.get(file)) {
      return;
    }

    const component: string[] = [];
    let member: string | undefined;

    do {
      member = stack.pop();

      if (member !== undefined) {
        onStack.delete(member);
        component.push(member);
      }
    } while (member !== undefined && member !== file);

    if (component.length > 1 || (graph.get(file) ?? []).includes(file)) {
      cycles.push(component.toSorted());
    }
  };

  for (const file of graph.keys()) {
    if (!index.has(file)) {
      collectComponent(file);
    }
  }

  return cycles;
}

main();
