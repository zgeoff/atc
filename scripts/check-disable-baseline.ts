// Counts the lint directives that switch off an import rule, and fails when
// the count rises above the committed baseline. The unused-directive report
// removes a stale directive, but nothing else stops a new one from switching
// off a package rule. A directive counts when it names an import rule, or
// names no rule at all and so switches off every rule. oxlint honours
// `eslint-disable` comments as well as its own, so both count. A directive is
// a `//` or `/*` comment at the start of a line or after whitespace, so text
// inside a string that holds a directive's words right after its quote does
// not count. Prints the count and exits 1 when it exceeds the baseline.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectSourceFiles } from './collect-source-files';

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
  /(?:^|\s)(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\b(?<rules>[^\n]*)/gm;

/**
 * The line of each directive in the source that switches off an import
 * rule.
 */
function collectDirectives(source: string): number[] {
  const lines: number[] = [];

  for (const match of source.matchAll(DIRECTIVE)) {
    const rules = (match.groups?.['rules'] ?? '')
      .replace(/\*\/.*$/, '')
      .split('--')[0]
      ?.split(/[\s,]+/)
      .filter((rule) => rule !== '')
      .map((rule) => rule.replace(/^eslint\//, ''));

    if (rules === undefined || rules.length === 0 || rules.some((rule) => IMPORT_RULES.has(rule))) {
      lines.push(
        source.slice(0, match.index).split('\n').length + (match[0].startsWith('\n') ? 1 : 0),
      );
    }
  }

  return lines;
}

main();
