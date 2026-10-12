import { expect, test } from 'bun:test';
import { SyntaxKind } from 'typescript/unstable/ast';
import { collectTokens } from './collect-tokens';

test('it reads a slash where an expression starts as a regular expression', () => {
  expect(collectTokens('const a = /b/;').map((token) => token.kind)).toStrictEqual([
    SyntaxKind.ConstKeyword,
    SyntaxKind.Identifier,
    SyntaxKind.EqualsToken,
    SyntaxKind.RegularExpressionLiteral,
    SyntaxKind.SemicolonToken,
  ]);
});

test('it continues a template after the brace that closes a substitution', () => {
  expect(collectTokens(`\`a\${b}c\``).map((token) => [token.kind, token.text])).toStrictEqual([
    [SyntaxKind.TemplateHead, `\`a\${`],
    [SyntaxKind.Identifier, 'b'],
    [SyntaxKind.TemplateTail, '}c`'],
  ]);
});

test('it places each token after the comments and whitespace before it', () => {
  expect(
    collectTokens('a /* b */\n// c\nd').map((token) => ({
      text: token.text,
      fullStart: token.fullStart,
      start: token.start,
    })),
  ).toStrictEqual([
    { text: 'a', fullStart: 0, start: 0 },
    { text: 'd', fullStart: 1, start: 15 },
  ]);
});
