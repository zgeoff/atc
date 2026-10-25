// Fails when a test helper hard-codes the source entry of a command that
// `scripts/with-test-home.sh` exports as an `ATC_*_ENTRY` variable, since a
// literal path is left behind when a package move changes the entry.
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readSourceFiles } from './read-source-files';

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const entries = parseSourceEntries(readFileSync(join(root, WRAPPER), 'utf8'));

  if (entries.length === 0) {
    console.error(`${WRAPPER} exports no ATC_*_ENTRY variable`);
    process.exit(1);
  }

  const found = readHelperFiles(root).flatMap((file) =>
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

function parseSourceEntries(script: string): SourceEntry[] {
  return [
    ...script.matchAll(/^export (?<name>ATC_[A-Z_]+_ENTRY)="\$repo\/(?<path>[^"]+)"$/gmu),
  ].map((match) => ({ name: match.groups?.['name'] ?? '', path: match.groups?.['path'] ?? '' }));
}

function readHelperFiles(root: string): string[] {
  // A helper's unit test stays out, since an entry path there is fixture data
  const helpers = readSourceFiles(root, 'packages').filter(
    (file) => /\/(?:test-utils|testing)\//u.test(file) && !/\.test\.[cm]?[jt]sx?$/u.test(file),
  );

  return [...readSourceFiles(root, 'e2e'), ...readSourceFiles(root, 'integration'), ...helpers];
}

interface HardCodedEntry {
  line: number;
  entry: SourceEntry;
}

function collectHardCodedEntries(
  source: string,
  entries: readonly SourceEntry[],
): HardCodedEntry[] {
  // The bare file name matches too, so `'cli.ts'` in a `join` counts
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
