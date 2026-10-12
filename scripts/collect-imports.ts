import { SyntaxKind, createScanner, tokenIsIdentifierOrKeyword } from 'typescript/unstable/ast';

// What a module imports: every literal specifier, the ones among them that
// only a resolve form names, and the line of each module reference whose
// specifier is computed.
export interface ImportList {
  readonly specifiers: readonly string[];
  readonly resolveOnly: readonly string[];
  readonly nonLiteralLines: readonly number[];
}

// Static imports and re-exports, type-only ones included, side-effect
// imports, and every call that loads or resolves a module: `import(...)`,
// import types among them, `require(...)` and `import x = require(...)`,
// `import.meta.resolve(...)`, `Bun.resolve(...)` and `Bun.resolveSync(...)`,
// and `new URL(..., import.meta.url)`.
export function collectImports(source: string): ImportList {
  const tokens = collectTokens(source);

  const specifiers = new Set<string>();

  // specifiers that a form which loads the module names: an import, an
  // export, `import(...)` or `require(...)`
  const loaded = new Set<string>();

  const nonLiteralLines: number[] = [];

  for (const [i, token] of tokens.entries()) {
    const next = tokens[i + 1];
    const open = findLoadParen(tokens, i);

    if (
      (token.kind === SyntaxKind.FromKeyword || token.kind === SyntaxKind.ImportKeyword) &&
      next?.kind === SyntaxKind.StringLiteral
    ) {
      specifiers.add(next.value);
      loaded.add(next.value);
    } else if (open !== null) {
      const argument = tokens[open + 1];
      const after = tokens[open + 2];

      const isLiteral =
        (argument?.kind === SyntaxKind.StringLiteral ||
          argument?.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
        (after?.kind === SyntaxKind.CloseParenToken || after?.kind === SyntaxKind.CommaToken);

      if (isLiteral) {
        specifiers.add(argument.value);

        if (!isResolveForm(tokens, i)) {
          loaded.add(argument.value);
        }
      } else {
        nonLiteralLines.push(getLineNumber(source, token.start));
      }
    }
  }

  return {
    specifiers: [...specifiers],
    resolveOnly: [...specifiers].filter((specifier) => !loaded.has(specifier)),
    nonLiteralLines,
  };
}

/**
 * Whether the module reference starting at token i only resolves a path,
 * as `import.meta.resolve(...)`, `Bun.resolve(...)`, `Bun.resolveSync(...)`
 * and `new URL(...)` do, rather than loading the module.
 */
function isResolveForm(tokens: readonly Token[], i: number): boolean {
  const token = tokens[i];

  return (
    token?.text === 'Bun' ||
    token?.kind === SyntaxKind.NewKeyword ||
    (token?.kind === SyntaxKind.ImportKeyword && tokens[i + 1]?.kind === SyntaxKind.DotToken)
  );
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
