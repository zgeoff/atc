// Checks the import graph under src/: no cycles (type-only imports count),
// each directory imports only the directories its row allows, and the
// packages that belong to one owner are imported nowhere else. Modules at the
// src/ root have a row of their own. The composition root may import any
// directory, and test files are exempt from the direction rules. An import
// or module reference whose specifier is not a literal is a finding, since no
// rule can check it. Imports are read from the TypeScript scanner's tokens, so
// comments, strings, and template literals never hide or invent one. The
// tokens before a slash decide whether it starts a regular expression, so a
// slash right after a class body or a function expression's closing brace can
// be misread. Prints every finding and exits 1 when there is one.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { SyntaxKind, createScanner, tokenIsIdentifierOrKeyword } from 'typescript/unstable/ast';

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
// module reference whose specifier is computed.
interface ImportList {
  readonly specifiers: readonly string[];
  readonly nonLiteralLines: readonly number[];
}

// Static imports and re-exports, type-only ones included, side-effect
// imports, and every call that loads or resolves a module: `import(...)`,
// import types among them, `require(...)` and `import x = require(...)`,
// `import.meta.resolve(...)`, `Bun.resolve(...)` and `Bun.resolveSync(...)`,
// and `new URL(..., import.meta.url)`.
function collectImports(source: string): ImportList {
  const tokens = collectTokens(source);

  const specifiers = new Set<string>();

  const nonLiteralLines: number[] = [];

  for (const [i, token] of tokens.entries()) {
    const next = tokens[i + 1];
    const open = findLoadParen(tokens, i);

    if (
      (token.kind === SyntaxKind.FromKeyword || token.kind === SyntaxKind.ImportKeyword) &&
      next?.kind === SyntaxKind.StringLiteral
    ) {
      specifiers.add(next.value);
    } else if (open !== null) {
      const argument = tokens[open + 1];
      const after = tokens[open + 2];

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
  readonly text: string;
  readonly value: string;
  readonly start: number;
}

// What an open brace began: a block, an object literal or type, or a
// template substitution.
type BraceKind = 'block' | 'object' | 'substitution';

// Keywords whose parenthesized condition a statement follows, so a slash
// after the closing parenthesis starts a regular expression.
const CONTROL_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ForKeyword,
  SyntaxKind.IfKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.WithKeyword,
]);

// Tokens after which an open brace begins a block rather than an object.
const BLOCK_OPENERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.CloseBraceToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.DoKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.EqualsGreaterThanToken,
  SyntaxKind.FinallyKeyword,
  SyntaxKind.OpenBraceToken,
  SyntaxKind.SemicolonToken,
  SyntaxKind.TryKeyword,
]);

// The module's tokens, with the two context-dependent ones settled the way
// the parser settles them: a slash where an expression can start begins a
// regular expression, and the brace that closes a template substitution
// continues the template.
function collectTokens(source: string): Token[] {
  const scanner = createScanner(true, undefined, source);
  const tokens: Token[] = [];

  // whether each open parenthesis holds a control statement's condition
  const parens: boolean[] = [];
  const braces: BraceKind[] = [];
  let slashStartsRegex = true;

  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    const previous = tokens.at(-1)?.kind;
    let closedControl = false;
    let closedBlock = false;

    if (
      (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
      slashStartsRegex
    ) {
      kind = scanner.reScanSlashToken();
    } else if (kind === SyntaxKind.OpenParenToken) {
      parens.push(previous !== undefined && CONTROL_KEYWORDS.has(previous));
    } else if (kind === SyntaxKind.CloseParenToken) {
      closedControl = parens.pop() ?? false;
    } else if (kind === SyntaxKind.OpenBraceToken) {
      const opened: BraceKind =
        previous === undefined || BLOCK_OPENERS.has(previous) ? 'block' : 'object';

      braces.push(opened);
    } else if (kind === SyntaxKind.CloseBraceToken) {
      const closed = braces.pop();

      closedBlock = closed === 'block';

      if (closed === 'substitution') {
        kind = scanner.reScanTemplateToken(false);
      }
    }

    if (kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle) {
      braces.push('substitution');
    }

    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
      start: scanner.getTokenStart(),
    });

    if (kind === SyntaxKind.CloseParenToken) {
      slashStartsRegex = closedControl;
    } else if (kind === SyntaxKind.CloseBraceToken) {
      slashStartsRegex = closedBlock;
    } else {
      slashStartsRegex = canStartRegex(kind);
    }
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

// Tokens other than closing brackets of statements that end a value, so a
// slash after one divides.
const VALUE_ENDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateTail,
]);

function canStartRegex(previous: SyntaxKind): boolean {
  if (tokenIsIdentifierOrKeyword(previous)) {
    return EXPRESSION_KEYWORDS.has(previous);
  }

  return !VALUE_ENDS.has(previous);
}

/**
 * The index of the parenthesis that opens a module-loading call starting at
 * token i, or null when none starts there. A property such as
 * `module.require(` is not one, and a `new URL(` counts only when its
 * arguments hold `import.meta.url`.
 */
function findLoadParen(tokens: readonly Token[], i: number): number | null {
  const token = tokens[i];
  const previous = tokens[i - 1]?.kind;

  if (
    token === undefined ||
    previous === SyntaxKind.DotToken ||
    previous === SyntaxKind.QuestionDotToken
  ) {
    return null;
  }

  if (token.kind === SyntaxKind.ImportKeyword) {
    if (tokens[i + 1]?.kind === SyntaxKind.OpenParenToken) {
      return i + 1;
    }

    return hasTexts(tokens, i + 1, ['.', 'meta', '.', 'resolve', '(']) ? i + 5 : null;
  }

  if (token.kind === SyntaxKind.RequireKeyword) {
    return tokens[i + 1]?.kind === SyntaxKind.OpenParenToken ? i + 1 : null;
  }

  if (
    token.text === 'Bun' &&
    (hasTexts(tokens, i + 1, ['.', 'resolveSync', '(']) ||
      hasTexts(tokens, i + 1, ['.', 'resolve', '(']))
  ) {
    return i + 3;
  }

  if (token.kind === SyntaxKind.NewKeyword && hasTexts(tokens, i + 1, ['URL', '('])) {
    const close = findCloseParen(tokens, i + 2);

    for (let j = i + 3; j < close; j += 1) {
      if (hasTexts(tokens, j, ['import', '.', 'meta', '.', 'url'])) {
        return i + 2;
      }
    }
  }

  return null;
}

function hasTexts(tokens: readonly Token[], start: number, texts: readonly string[]): boolean {
  return texts.every((text, offset) => tokens[start + offset]?.text === text);
}

/**
 * The index of the parenthesis that closes the one at `open`, or the token
 * count when the module ends first.
 */
function findCloseParen(tokens: readonly Token[], open: number): number {
  let depth = 0;

  for (let j = open; j < tokens.length; j += 1) {
    const kind = tokens[j]?.kind;

    if (kind === SyntaxKind.OpenParenToken) {
      depth += 1;
    } else if (kind === SyntaxKind.CloseParenToken) {
      depth -= 1;

      if (depth === 0) {
        return j;
      }
    }
  }

  return tokens.length;
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

const CONFINED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  'bun-pty': ['src/daemon/local-pty-provider.ts'],
  '@zgeoff/imp-client': ['src/daemon/imp-client-port.ts'],
  '@anthropic-ai/claude-agent-sdk': [
    'src/agents/build-claude-query-options.ts',
    'src/agents/start-claude-headless-run.ts',
  ],
};

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

// The entrypoints that wire concrete modules together, exempt from the
// direction rules.
const COMPOSITION_ROOTS: ReadonlySet<string> = new Set(['src/cli.ts']);

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
