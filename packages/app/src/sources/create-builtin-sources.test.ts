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

test('it leaves GitHub out when gh is not on the host', () => {
  const ctx = setupTest();

  const sources = createBuiltinSources({
    roots: [],
    githubOwner: null,
    ghBin: ctx.gh,
    homeDir: ctx.homeDir,
    host: buildMockHostServices(),
  });

  expect(sources.map((source) => source.id)).toStrictEqual(['dirs', 'git']);
});

test('it offers GitHub when gh is on the host', () => {
  const ctx = setupTest();

  writeFileSync(ctx.gh, '#!/bin/sh\n', { mode: 0o755 });

  const sources = createBuiltinSources({
    roots: [],
    githubOwner: null,
    ghBin: ctx.gh,
    homeDir: ctx.homeDir,
    host: buildMockHostServices(),
  });

  expect(sources.map((source) => source.id)).toStrictEqual(['dirs', 'github', 'git']);
});
