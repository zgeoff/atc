import { SyntaxKind } from 'typescript/unstable/ast';
import type { Token } from './collect-tokens';
import { collectTokens } from './collect-tokens';

// What a module imports: every literal specifier, the ones among them that
// only a resolve form names, the ones a static import or export loads as the
// module loads, the line of each module load whose specifier is not a quoted
// string, which oxlint's import rules do not read, and the line of each
// resolve form whose specifier is not a literal, which no graph reads.
export interface ImportList {
  readonly specifiers: readonly string[];
  readonly resolveOnly: readonly string[];

  // a type-only statement, or one whose every specifier is type-only, loads
  // nothing, and a dynamic import loads its module only when the code
  // reaches it
  readonly staticLoads: readonly string[];
  readonly computedLoadLines: readonly number[];
  readonly computedResolveLines: readonly number[];
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
  const staticLoads = new Set<string>();

  const computedLoadLines: number[] = [];
  const computedResolveLines: number[] = [];

  // whether the import or export statement the scan is inside loads nothing
  // at runtime, being type-only or naming only type-only specifiers
  let isTypeOnly = false;

  for (const [i, token] of tokens.entries()) {
    const next = tokens[i + 1];
    const open = findLoadParen(tokens, i);

    if (
      (token.kind === SyntaxKind.ImportKeyword || token.kind === SyntaxKind.ExportKeyword) &&
      next?.kind !== SyntaxKind.OpenParenToken &&
      next?.kind !== SyntaxKind.DotToken
    ) {
      isTypeOnly = isTypeOnlyStatement(tokens, i) || hasOnlyTypeSpecifiers(tokens, i);
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

      const isLoad = !isResolveForm(tokens, i);

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

/**
 * Whether the import or export statement starting at token i is type-only,
 * as `import type { A } from` and `export type { A } from` are. A `type`
 * that is itself the imported name, as in `import type from`, is not.
 */
function isTypeOnlyStatement(tokens: readonly Token[], i: number): boolean {
  const after = tokens[i + 2];

  return (
    tokens[i + 1]?.kind === SyntaxKind.TypeKeyword &&
    after?.kind !== SyntaxKind.FromKeyword &&
    after?.kind !== SyntaxKind.CommaToken &&
    after?.kind !== SyntaxKind.EqualsToken
  );
}

/**
 * Whether the import or export statement starting at token i lists only
 * inline type-only specifiers, as `import { type A } from` and
 * `export { type A, type B as C } from` do; Bun erases such a statement and
 * never runs its module. A list that mixes in a value name, follows a
 * default import, or is empty still loads the module.
 */
function hasOnlyTypeSpecifiers(tokens: readonly Token[], i: number): boolean {
  if (tokens[i + 1]?.kind !== SyntaxKind.OpenBraceToken) {
    return false;
  }

  const elements: Token[][] = [[]];

  for (let j = i + 2; tokens[j]?.kind !== SyntaxKind.CloseBraceToken; j += 1) {
    const token = tokens[j];

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

/**
 * Whether the specifier's tokens make it type-only. `type A` and
 * `type A as B` are, two and four tokens long; `type` alone and `type as B`
 * name a value called type, one and three tokens long.
 */
function isTypeOnlySpecifier(element: readonly Token[]): boolean {
  return element[0]?.kind === SyntaxKind.TypeKeyword && element.length % 2 === 0;
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
