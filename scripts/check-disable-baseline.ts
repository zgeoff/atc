// Fails when the lint directives that switch off an import rule, or every
// rule, outnumber the committed baseline: nothing else stops a new one from
// switching off a package rule.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { collectTokens } from './collect-tokens';
import { readSourceFiles } from './read-source-files';

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const text = readFileSync(join(root, BASELINE_FILE), 'utf8');
  const baseline = BASELINE_SCHEMA.parse(JSON.parse(text)).importRuleDisables;

  const found = SOURCE_DIRS.flatMap((directory) => readSourceFiles(root, directory)).flatMap(
    (file) =>
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
const BASELINE_SCHEMA = z.object({ importRuleDisables: z.number().int().nonnegative() });
const SOURCE_DIRS = ['packages', 'e2e', 'integration', 'scripts', 'mods'];

// the require ban keeps every module load in a form the import rules read
const IMPORT_RULES: ReadonlySet<string> = new Set([
  'import-zones',
  'no-restricted-imports',
  'no-cycle',
  'no-dynamic-require',
  'no-require-imports',
]);

// oxlint honours `eslint-disable` too
const DIRECTIVE =
  /^(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?<rules>(?:\s[\s\S]*|\*\/)?)$/u;

function collectDirectives(source: string): number[] {
  // Tokenized, so a string or template that holds a directive's words is skipped
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

const COMMENT = /\/\/[^\n\r]*|\/\*[\s\S]*?\*\//gu;

function isImportRuleDirective(comment: string): boolean {
  const match = DIRECTIVE.exec(comment);

  if (match === null) {
    return false;
  }

  const rules = (match.groups?.['rules'] ?? '')
    .replace(/\*\/$/u, '')
    .split('--')[0]
    ?.split(/[\s,*]+/u)
    .filter((rule) => rule !== '')

    // oxlint takes a rule name with any plugin prefix or none
    .map((rule) => rule.slice(rule.lastIndexOf('/') + 1));

  return rules === undefined || rules.length === 0 || rules.some((rule) => IMPORT_RULES.has(rule));
}

main();
