import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createStubBin } from './create-stub-bin';

const RELEASE_SCHEMA = z.object({ tagName: z.string(), isLatest: z.boolean() });
const RELEASES_SCHEMA = z.array(RELEASE_SCHEMA);

type StubGHRelease = z.infer<typeof RELEASE_SCHEMA>;

interface StubGHReleasesOptions {
  readonly releases: readonly StubGHRelease[];

  // A release that another branch publishes after the first read and before
  // the first edit lands, so it takes the latest mark first. Absent adds none.
  readonly rival?: string;
}

interface StubGHReleases {
  // The directory that holds the stub `gh`, for the front of PATH.
  readonly directory: string;

  readonly readReleases: () => StubGHRelease[];

  // Each run's arguments, one line per run.
  readonly readCalls: () => string[];
}

// `gh release list` prints the releases as `--json tagName,isLatest` does,
// and `gh release edit <tag> --latest` moves the mark to that tag.
export function createStubGHReleases(
  directory: string,
  options: StubGHReleasesOptions,
): StubGHReleases {
  const state = join(directory, 'releases.json');
  const calls = join(directory, 'gh-calls');
  const rivalPending = join(directory, 'rival-pending');
  const bin = join(directory, 'bin');

  writeFileSync(state, JSON.stringify(options.releases));
  writeFileSync(calls, '');

  if (options.rival !== undefined) {
    writeFileSync(rivalPending, options.rival);
  }

  const stateLiteral = toShellLiteral(state);
  const rivalLiteral = toShellLiteral(rivalPending);

  createStubBin(
    bin,
    'gh',
    [
      '#!/bin/sh',
      'set -eu',
      `printf '%s\\n' "$*" >> ${toShellLiteral(calls)}`,
      'case "$1 $2" in',
      `  'release list') cat ${stateLiteral} ;;`,
      `  'release edit')`,
      `    if [ -f ${rivalLiteral} ]; then`,
      `      jq --arg tag "$(cat ${rivalLiteral})" '[.[] | .isLatest = false] + [{tagName: $tag, isLatest: true}]' ${stateLiteral} > ${stateLiteral}.next`,
      `      mv ${stateLiteral}.next ${stateLiteral}`,
      `      rm ${rivalLiteral}`,
      '    fi',
      `    jq --arg tag "$3" '[.[] | .isLatest = (.tagName == $tag)]' ${stateLiteral} > ${stateLiteral}.next`,
      `    mv ${stateLiteral}.next ${stateLiteral}`,
      '    ;;',
      `  *) echo "unexpected gh $*" >&2; exit 1 ;;`,
      'esac',
      '',
    ].join('\n'),
  );

  return {
    directory: bin,
    readReleases: () => RELEASES_SCHEMA.parse(JSON.parse(readFileSync(state, 'utf8'))),
    readCalls: () =>
      readFileSync(calls, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}

function toShellLiteral(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
