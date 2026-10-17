// Fails when a test helper hard-codes the source entry of a command that
// `scripts/with-test-home.sh` exports as an `ATC_*_ENTRY` variable. The check
// reads the entries from the wrapper, so a package move that changes an entry
// path moves the check with it. A helper reads the variable instead, and a
// literal path or a `join` of its segments leaves the helper behind on a move.
// Prints each hit's file, line, and variable, and exits 1 when it finds one.
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { collectSourceFiles } from './collect-source-files';

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const entries = parseSourceEntries(readFileSync(join(root, WRAPPER), 'utf8'));

  if (entries.length === 0) {
    console.error(`${WRAPPER} exports no ATC_*_ENTRY variable`);
    process.exit(1);
  }

  const found = collectHelperFiles(root).flatMap((file) =>
    collectHardCodedEntries(readFileSync(join(root, file), 'utf8'), entries).map(
      (hit) => `${file}:${hit.line} holds ${hit.entry.path}; read it from ${hit.entry.name}`,
    ),
  );

  for (const hit of found) {
    console.error(`hard-coded source entry: ${hit}`);
  }

  console.log(`check-source-entries: ${found.length} hard-coded source entries`);

  if (found.length > 0) {
    process.exit(1);
  }
}

const WRAPPER = 'scripts/with-test-home.sh';

interface SourceEntry {
  readonly name: string;
  readonly path: string;
}

/**
 * Each `export ATC_*_ENTRY="$repo/<path>"` line of the wrapper, as the
 * variable's name and the entry's repo-relative path.
 */
function parseSourceEntries(script: string): SourceEntry[] {
  return [
    ...script.matchAll(/^export (?<name>ATC_[A-Z_]+_ENTRY)="\$repo\/(?<path>[^"]+)"$/gmu),
  ].map((match) => ({ name: match.groups?.['name'] ?? '', path: match.groups?.['path'] ?? '' }));
}

/**
 * The modules a test runs commands through: every module of the end-to-end
 * suites, and each module that is not itself a test inside a package's
 * `test-utils` or `testing` folder or the shared test-utils package. A unit
 * test of a helper stays out, since an entry path there is fixture data.
 */
function collectHelperFiles(root: string): string[] {
  const helpers = collectSourceFiles(root, 'packages').filter(
    (file) => /\/(?:test-utils|testing)\//u.test(file) && !/\.test\.[cm]?[jt]sx?$/u.test(file),
  );

  return [...collectSourceFiles(root, 'e2e'), ...helpers];
}

interface HardCodedEntry {
  line: number;
  entry: SourceEntry;
}

/**
 * Each line of the source that holds an entry's file name as the end of a
 * path or as a string of its own, so `'cli.ts'` in a `join` counts as well
 * as a whole path, with the entry it matches. Lines are 1-based.
 */
function collectHardCodedEntries(
  source: string,
  entries: readonly SourceEntry[],
): HardCodedEntry[] {
  const patterns = entries.map((entry) => ({
    entry,
    pattern: new RegExp(`(?:^|[/'"\`])${RegExp.escape(basename(entry.path))}(?![\\w.-])`, 'u'),
  }));

  return source
    .split('\n')
    .flatMap((text, index) =>
      patterns
        .filter((candidate) => candidate.pattern.test(text))
        .map((candidate) => ({ line: index + 1, entry: candidate.entry })),
    );
}

main();
