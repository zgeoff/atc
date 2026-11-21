import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@zgeoff/testing/bin';
import { z } from 'zod';
import { toShellArg } from '../index';

const RELEASE_SCHEMA = z.object({ tagName: z.string(), isLatest: z.boolean() });
const RELEASES_SCHEMA = z.array(RELEASE_SCHEMA);

type StubGHRelease = z.infer<typeof RELEASE_SCHEMA>;

interface StubGHReleasesOptions {
  readonly releases: readonly StubGHRelease[];

  readonly rivals?: readonly string[];
}

interface StubGHReleases {
  readonly directory: string;

  readonly readReleases: () => StubGHRelease[];

  readonly readCalls: () => string[];
}

export function createStubGHReleases(
  directory: string,
  options: StubGHReleasesOptions,
): StubGHReleases {
  const state = join(directory, 'releases.json');
  const calls = join(directory, 'gh-calls');
  const rivals = join(directory, 'rivals');
  const bin = join(directory, 'bin');

  writeFileSync(state, JSON.stringify(options.releases));
  writeFileSync(calls, '');
  writeFileSync(rivals, (options.rivals ?? []).map((rival) => `${rival}\n`).join(''));

  const stateLiteral = toShellArg(state);
  const rivalsLiteral = toShellArg(rivals);

  createStubBin(bin, 'gh', {
    script: [
      '#!/bin/sh',
      'set -eu',
      `printf '%s\\n' "$*" >> ${toShellArg(calls)}`,
      'case "$1 $2" in',
      `  'release list') cat ${stateLiteral} ;;`,
      `  'release edit')`,
      `    rival=$(head -n 1 ${rivalsLiteral})`,
      '    if [ -n "$rival" ]; then',
      `      jq --arg tag "$rival" '[.[] | .isLatest = false] + [{tagName: $tag, isLatest: true}]' ${stateLiteral} > ${stateLiteral}.next`,
      `      mv ${stateLiteral}.next ${stateLiteral}`,
      `      tail -n +2 ${rivalsLiteral} > ${rivalsLiteral}.next`,
      `      mv ${rivalsLiteral}.next ${rivalsLiteral}`,
      '    fi',
      `    jq --arg tag "$3" '[.[] | .isLatest = (.tagName == $tag)]' ${stateLiteral} > ${stateLiteral}.next`,
      `    mv ${stateLiteral}.next ${stateLiteral}`,
      '    ;;',
      `  *) echo "unexpected gh $*" >&2; exit 1 ;;`,
      'esac',
      '',
    ].join('\n'),
  });

  return {
    directory: bin,
    readReleases: () => RELEASES_SCHEMA.parse(JSON.parse(readFileSync(state, 'utf8'))),
    readCalls: () =>
      readFileSync(calls, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}
