// Counts the lint directives that switch off an import rule, and fails when
// the count rises above the committed baseline. The unused-directive report
// removes a stale directive, but nothing else stops a new one from switching
// off a package rule. A directive counts when it names an import rule, or
// names no rule at all and so switches off every rule. oxlint honours
// `eslint-disable` comments as well as its own, so both count. Only real
// comments count: the module is tokenized, so a string or template that holds
// a directive's words is skipped, and a block comment may list its rules over
// several lines. Prints the count and exits 1 when it exceeds the baseline.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectSourceFiles } from './collect-source-files';
import { collectTokens } from './collect-tokens';

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));

  const baseline = (
    JSON.parse(readFileSync(join(root, BASELINE_FILE), 'utf8')) as {
      readonly importRuleDisables: number;
    }
  ).importRuleDisables;

  const found = SOURCE_DIRS.flatMap((dir) => collectSourceFiles(root, dir)).flatMap((file) =>
    collectDirectives(readFileSync(join(root, file), 'utf8')).map((line) => `${file}:${line}`),
  );

  for (const directive of found) {
    console.error(`import rule disabled: ${directive}`);
  }

  console.log(`check-disable-baseline: ${found.length} directives, baseline ${baseline}`);

  if (found.length > baseline) {
    console.error(
      `check-disable-baseline: ${found.length - baseline} more than the baseline in ${BASELINE_FILE}`,
    );

    process.exit(1);
  }

  if (found.length < baseline) {
    console.log(
      `check-disable-baseline: lower the baseline in ${BASELINE_FILE} to ${found.length}`,
    );
  }
}

const BASELINE_FILE = 'scripts/disable-baseline.json';
const SOURCE_DIRS = ['packages', 'e2e', 'scripts'];

const IMPORT_RULES: ReadonlySet<string> = new Set([
  'no-restricted-imports',
  'import/no-cycle',
  'import/no-dynamic-require',
]);

const DIRECTIVE =
  /^(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?<rules>(?:\s[\s\S]*|\*\/)?)$/;

/**
 * The line of each directive in the source that switches off an import
 * rule.
 */
function collectDirectives(source: string): number[] {
  const tokens = collectTokens(source);
  const end = tokens.at(-1);

  // the comments and whitespace between tokens, and after the last one
  const trivia = [
    ...tokens.map((token) => ({
      start: token.fullStart,
      text: source.slice(token.fullStart, token.start),
    })),
    ...(end === undefined
      ? [{ start: 0, text: source }]
      : [{ start: end.start + end.text.length, text: source.slice(end.start + end.text.length) }]),
  ];

  return trivia.flatMap((gap) =>
    [...gap.text.matchAll(COMMENT)]
      .filter((comment) => isImportRuleDirective(comment[0]))
      .map((comment) => source.slice(0, gap.start + comment.index).split('\n').length),
  );
}

const COMMENT = /\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g;

function isImportRuleDirective(comment: string): boolean {
  const match = DIRECTIVE.exec(comment);

  if (match === null) {
    return false;
  }

  const rules = (match.groups?.['rules'] ?? '')
    .replace(/\*\/$/, '')
    .split('--')[0]
    ?.split(/[\s,*]+/)
    .filter((rule) => rule !== '')
    .map((rule) => rule.replace(/^eslint\//, ''));

  return rules === undefined || rules.length === 0 || rules.some((rule) => IMPORT_RULES.has(rule));
}

main();
