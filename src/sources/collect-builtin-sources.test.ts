import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { collectBuiltinSources } from './collect-builtin-sources';

// A home directory with a path a gh executable may be written to.
function setupTest() {
  const temp = setupTempDir('atc-builtin-sources-');

  return { homeDir: temp.dir, gh: join(temp.dir, 'gh'), [Symbol.dispose]: temp[Symbol.dispose] };
}

test('it leaves GitHub out when gh is not on the host', () => {
  using ctx = setupTest();

  const sources = collectBuiltinSources({
    roots: [],
    githubOwner: null,
    ghBin: ctx.gh,
    homeDir: ctx.homeDir,
    collectZoxideDirs: () => Promise.resolve([]),
  });

  expect(sources.map((source) => source.id)).toStrictEqual(['dirs', 'git']);
});

test('it offers GitHub when gh is on the host', () => {
  using ctx = setupTest();

  writeFileSync(ctx.gh, '#!/bin/sh\n', { mode: 0o755 });

  const sources = collectBuiltinSources({
    roots: [],
    githubOwner: null,
    ghBin: ctx.gh,
    homeDir: ctx.homeDir,
    collectZoxideDirs: () => Promise.resolve([]),
  });

  expect(sources.map((source) => source.id)).toStrictEqual(['dirs', 'github', 'git']);
});
