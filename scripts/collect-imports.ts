import { SyntaxKind } from 'typescript/unstable/ast';
import type { Token } from './collect-tokens';
import { collectTokens } from './collect-tokens';

export interface ImportList {
  readonly specifiers: readonly string[];

  // The specifiers that only a resolve form names
  readonly resolveOnly: readonly string[];

  // a type-only statement, or one whose every specifier is type-only, loads
  // nothing, and a dynamic import loads its module only when the code
  // reaches it
  readonly staticLoads: readonly string[];

  // A load whose specifier is not a quoted string, which oxlint's import rules
  // do not read, and a resolve form whose specifier is not a literal
  readonly computedLoadLines: readonly number[];
  readonly computedResolveLines: readonly number[];
}

export function collectImports(source: string): ImportList {
  const tokens = collectTokens(source);

  const specifiers = new Set<string>();

  // specifiers that a form which loads the module names: an import, an
  // export, `import(...)` or `require(...)`
  const loaded = new Set<string>();
  const staticLoads = new Set<string>();

  const computedLoadLines: number[] = [];
  const computedResolveLines: number[] = [];

  // whether the import or export statement the scan is inside loads nothing
  // at runtime, being type-only or naming only type-only specifiers
  let isTypeOnly = false;

  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const open = findLoadParen(tokens, index);

    if (
      (token.kind === SyntaxKind.ImportKeyword || token.kind === SyntaxKind.ExportKeyword) &&
      next?.kind !== SyntaxKind.OpenParenToken &&
      next?.kind !== SyntaxKind.DotToken
    ) {
      isTypeOnly = isTypeOnlyStatement(tokens, index) || hasOnlyTypeSpecifiers(tokens, index);
    }

    if (
      (token.kind === SyntaxKind.FromKeyword || token.kind === SyntaxKind.ImportKeyword) &&
      next?.kind === SyntaxKind.StringLiteral
    ) {
      specifiers.add(next.value);
      loaded.add(next.value);

      if (token.kind === SyntaxKind.ImportKeyword || !isTypeOnly) {
        staticLoads.add(next.value);
      }
    } else if (open !== null) {
      const argument = tokens[open + 1];
      const after = tokens[open + 2];

      const isLiteral =
        (argument?.kind === SyntaxKind.StringLiteral ||
          argument?.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
        (after?.kind === SyntaxKind.CloseParenToken || after?.kind === SyntaxKind.CommaToken);

      const isLoad = !isResolveForm(tokens, index);

      if (isLiteral) {
        specifiers.add(argument.value);

        if (isLoad) {
          loaded.add(argument.value);
        }
      }

      if (isLoad && (!isLiteral || argument.kind !== SyntaxKind.StringLiteral)) {
        computedLoadLines.push(getLineNumber(source, token.start));
      } else if (!isLoad && !isLiteral) {
        computedResolveLines.push(getLineNumber(source, token.start));
      }
    }
  }

  return {
    specifiers: [...specifiers],
    resolveOnly: [...specifiers].filter((specifier) => !loaded.has(specifier)),
    staticLoads: [...staticLoads],
    computedLoadLines,
    computedResolveLines,
  };
}

function findLoadParen(tokens: readonly Token[], index: number): number | null {
  const token = tokens[index];
  const previous = tokens[index - 1]?.kind;

  if (
    token === undefined ||
    previous === SyntaxKind.DotToken ||
    previous === SyntaxKind.QuestionDotToken
  ) {
    return null;
  }

  if (token.kind === SyntaxKind.ImportKeyword) {
    if (tokens[index + 1]?.kind === SyntaxKind.OpenParenToken) {
      return index + 1;
    }

    return hasTexts(tokens, index + 1, ['.', 'meta', '.', 'resolve', '(']) ? index + 5 : null;
  }

  if (token.kind === SyntaxKind.RequireKeyword) {
    return tokens[index + 1]?.kind === SyntaxKind.OpenParenToken ? index + 1 : null;
  }

  if (
    token.text === 'Bun' &&
    (hasTexts(tokens, index + 1, ['.', 'resolveSync', '(']) ||
      hasTexts(tokens, index + 1, ['.', 'resolve', '(']))
  ) {
    return index + 3;
  }

  if (token.kind === SyntaxKind.NewKeyword && hasTexts(tokens, index + 1, ['URL', '('])) {
    const close = getCloseParen(tokens, index + 2);

    for (let position = index + 3; position < close; position += 1) {
      if (hasTexts(tokens, position, ['import', '.', 'meta', '.', 'url'])) {
        return index + 2;
      }
    }
  }

  return null;
}

function hasTexts(tokens: readonly Token[], start: number, texts: readonly string[]): boolean {
  return texts.every((text, offset) => tokens[start + offset]?.text === text);
}

function getCloseParen(tokens: readonly Token[], open: number): number {
  let depth = 0;

  for (let position = open; position < tokens.length; position += 1) {
    const kind = tokens[position]?.kind;

    if (kind === SyntaxKind.OpenParenToken) {
      depth += 1;
    } else if (kind === SyntaxKind.CloseParenToken) {
      depth -= 1;

      if (depth === 0) {
        return position;
      }
    }
  }

  return tokens.length;
}

// A `type` that is itself the imported name, as in `import type from`, does
// not make the statement type-only
function isTypeOnlyStatement(tokens: readonly Token[], index: number): boolean {
  const after = tokens[index + 2];

  return (
    tokens[index + 1]?.kind === SyntaxKind.TypeKeyword &&
    after?.kind !== SyntaxKind.FromKeyword &&
    after?.kind !== SyntaxKind.CommaToken &&
    after?.kind !== SyntaxKind.EqualsToken
  );
}

// Bun erases a statement whose braces list only inline type-only specifiers
// and never runs its module; an empty list still loads it
function hasOnlyTypeSpecifiers(tokens: readonly Token[], index: number): boolean {
  if (tokens[index + 1]?.kind !== SyntaxKind.OpenBraceToken) {
    return false;
  }

  const elements: Token[][] = [[]];

  for (
    let position = index + 2;
    tokens[position]?.kind !== SyntaxKind.CloseBraceToken;
    position += 1
  ) {
    const token = tokens[position];

    if (token === undefined) {
      return false;
    }

    if (token.kind === SyntaxKind.CommaToken) {
      elements.push([]);
    } else {
      elements.at(-1)?.push(token);
    }
  }

  const specifiers = elements.filter((element) => element.length > 0);

  return specifiers.length > 0 && specifiers.every((specifier) => isTypeOnlySpecifier(specifier));
}

// `type A` and `type A as B` are type-only, two and four tokens long; `type`
// alone and `type as B` name a value called type, one and three tokens long
function isTypeOnlySpecifier(element: readonly Token[]): boolean {
  return element[0]?.kind === SyntaxKind.TypeKeyword && element.length % 2 === 0;
}

function isResolveForm(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];

  return (
    token?.text === 'Bun' ||
    token?.kind === SyntaxKind.NewKeyword ||
    (token?.kind === SyntaxKind.ImportKeyword && tokens[index + 1]?.kind === SyntaxKind.DotToken)
  );
}

function getLineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}
