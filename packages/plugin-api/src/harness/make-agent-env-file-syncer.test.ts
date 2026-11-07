import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildAgentEnvFilePath } from './build-agent-env-file-path';
import { makeAgentEnvFileSyncer } from './make-agent-env-file-syncer';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-agent-env-syncer-');

  return { directory: temporaryDirectory.path };
}

test('it writes no file for an entry without env', () => {
  const ctx = setupTest();
  const syncEnvFile = makeAgentEnvFileSyncer({ id: 'grok', env: {} }, ctx.directory);

  expect({
    file: syncEnvFile(),
    written: existsSync(buildAgentEnvFilePath(ctx.directory, 'grok')),
  }).toStrictEqual({ file: null, written: false });
});

test('it removes the env file an earlier run wrote for an entry that no longer has env', () => {
  const ctx = setupTest();
  const left = buildAgentEnvFilePath(ctx.directory, 'codex');

  writeFileSync(left, "export NOTES_VAULT='desk/old-key'\n");
  makeAgentEnvFileSyncer({ id: 'codex', env: {} }, ctx.directory)();

  expect(existsSync(left)).toBeFalse();
});

test.each(['../team/codex', '笔记'.repeat(60)])(
  'it writes the env file of agent id %s inside the folder',
  (id) => {
    const ctx = setupTest();

    const file = makeAgentEnvFileSyncer(
      { id, env: { NOTES_VAULT: 'desk/notes-key' } },
      ctx.directory,
    )();

    invariant(file !== null, 'the syncer wrote no env file');

    expect({ folder: dirname(file), written: existsSync(file) }).toStrictEqual({
      folder: ctx.directory,
      written: true,
    });
  },
);

test('it writes the env file on its first call alone', () => {
  const ctx = setupTest();
  const file = buildAgentEnvFilePath(ctx.directory, 'codex');

  const syncEnvFile = makeAgentEnvFileSyncer(
    { id: 'codex', env: { NOTES_VAULT: 'desk/notes-key' } },
    ctx.directory,
  );

  syncEnvFile();
  writeFileSync(file, 'export NOTES_VAULT=edited\n');
  syncEnvFile();

  expect(readFileSync(file, 'utf8')).toBe('export NOTES_VAULT=edited\n');
});
