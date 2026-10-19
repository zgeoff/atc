import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildMockHostServices, setupTempDir } from '@atc/test-utils';
import { DIRS_SOURCE_PLUGIN } from './dirs-source-plugin';

// A home directory the listed directories sit in.
function setupTest() {
  const temp = setupTempDir('atc-dirs-plugin-');

  return { home: temp.dir };
}

test('it refuses a slice without a home directory', () => {
  const schema = DIRS_SOURCE_PLUGIN.configSchema({
    authProfiles: new Map(),
    entryID: 'dirs',
    foreignFields: new Set(),
  });

  expect(schema.safeParse({ roots: [] }).error?.issues).toPartiallyContain({ path: ['homeDir'] });
});

test('it lists the directories zoxide returns through the host command runner', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'notes'));

  const source = DIRS_SOURCE_PLUGIN.create(
    { roots: [], homeDir: ctx.home },
    buildMockHostServices({
      runCommand: (argv) =>
        Promise.resolve({
          code: argv[0] === 'zoxide' ? 0 : 127,
          stdout: join(ctx.home, 'notes'),
          stderr: '',
          aborted: false,
        }),
    }),
    { authProfiles: new Map() },
  );

  const listed = await source.list(
    {},
    { target: 'local', readSpawnDirs: () => Promise.resolve([]) },
  );

  expect(listed).toStrictEqual({
    candidates: [{ label: '~/notes', pick: { kind: 'path', dir: join(ctx.home, 'notes') } }],
    scope: null,
  });
});
