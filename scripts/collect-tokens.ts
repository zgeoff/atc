import { SyntaxKind, createScanner, tokenIsIdentifierOrKeyword } from 'typescript/unstable/ast';

export interface Token {
  readonly kind: SyntaxKind;
  readonly text: string;
  readonly value: string;
  readonly start: number;

  // where the comments and whitespace before the token begin
  readonly fullStart: number;
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
export function collectTokens(source: string): Token[] {
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
      fullStart: scanner.getTokenFullStart(),
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
