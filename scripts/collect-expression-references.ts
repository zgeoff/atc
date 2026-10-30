// A string literal in an expression may hold `}}`, so the end of an expression is found past them.
const expressionPattern = /\$\{\{(?<body>(?:'(?:[^']|'')*'|[^'])*?)\}\}/gsu;
const indexPattern = /\[\s*'(?<name>[A-Za-z_][\w-]*)'\s*\]/gu;
const stringPattern = /'(?:[^']|'')*'/gu;
const referencePattern = /[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+/gu;

// Only a context reference inside an expression changes between runs: the same words outside one,
// or in one of its string literals, are text. `github['sha']` reads the same value as `github.sha`.
export function collectExpressionReferences(text: string): string[] {
  return [...text.matchAll(expressionPattern)].flatMap((expression) => {
    const body = (expression.groups?.['body'] ?? '')
      .replaceAll(indexPattern, '.$<name>')
      .replaceAll(stringPattern, "''");

    return [...body.matchAll(referencePattern)].map((reference) => reference[0]);
  });
}
