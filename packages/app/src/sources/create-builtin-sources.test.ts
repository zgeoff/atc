import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMockHostServices, setupTempDir } from '@atc/test-utils';
import { createBuiltinSources } from './create-builtin-sources';

// A home directory with a path a gh executable may be written to.
function setupTest() {
  const temp = setupTempDir('atc-builtin-sources-');

  return { homeDir: temp.path, gh: join(temp.path, 'gh') };
}

test('it builds one source per entry, in entry order, each under its entry id', () => {
  const ctx = setupTest();

  writeFileSync(ctx.gh, '#!/bin/sh\n', { mode: 0o755 });

  const built = createBuiltinSources({
    entries: [
      { id: 'git', kind: 'git' },
      { id: 'acme', kind: 'github', owner: 'acme-tools', bin: ctx.gh },
      { id: 'local', kind: 'dirs', roots: [] },
    ],
    homeDir: ctx.homeDir,
    host: buildMockHostServices(),
  });

  expect({
    sources: built.sources.map((source) => [source.id, source.kind]),
    problems: built.problems,
  }).toStrictEqual({
    sources: [
      ['git', 'git'],
      ['acme', 'git'],
      ['local', 'path'],
    ],
    problems: [],
  });
});

test('it leaves out a GitHub entry whose gh does not exist, with one line, and offers the others', () => {
  const ctx = setupTest();

  const built = createBuiltinSources({
    entries: [
      { id: 'dirs', kind: 'dirs', roots: [] },
      { id: 'github', kind: 'github', owner: null, bin: ctx.gh },
      { id: 'git', kind: 'git' },
    ],
    homeDir: ctx.homeDir,
    host: buildMockHostServices(),
  });

  expect({
    sources: built.sources.map((source) => source.id),
    problems: built.problems,
  }).toStrictEqual({
    sources: ['dirs', 'git'],
    problems: ["sources.github: gh is not on the daemon's PATH; left out"],
  });
});
