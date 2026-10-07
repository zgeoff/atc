import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { collectBuiltinSources } from './collect-builtin-sources';

test('it leaves GitHub out when gh is not on the host', () => {
  using temp = setupTempDir('atc-builtin-sources-');

  const sources = collectBuiltinSources({
    roots: [],
    githubOwner: null,
    ghBin: join(temp.dir, 'gh'),
    homeDir: temp.dir,
    collectZoxideDirs: () => Promise.resolve([]),
  });

  expect(sources.map((source) => source.id)).toStrictEqual(['dirs', 'git']);
});

test('it offers GitHub when gh is on the host', () => {
  using temp = setupTempDir('atc-builtin-sources-');

  writeFileSync(join(temp.dir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });

  const sources = collectBuiltinSources({
    roots: [],
    githubOwner: null,
    ghBin: join(temp.dir, 'gh'),
    homeDir: temp.dir,
    collectZoxideDirs: () => Promise.resolve([]),
  });

  expect(sources.map((source) => source.id)).toStrictEqual(['dirs', 'github', 'git']);
});
