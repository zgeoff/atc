import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
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
    written: existsSync(join(ctx.directory, 'agent-env-grok.sh')),
  }).toStrictEqual({ file: null, written: false });
});

test('it removes the env file an earlier run wrote for an entry that no longer has env', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'agent-env-codex.sh'), "export NOTES_VAULT='desk/old-key'\n");
  makeAgentEnvFileSyncer({ id: 'codex', env: {} }, ctx.directory)();

  expect(existsSync(join(ctx.directory, 'agent-env-codex.sh'))).toBeFalse();
});

test('it keeps the env file of an agent id that holds a slash inside the folder', () => {
  const ctx = setupTest();

  const file = makeAgentEnvFileSyncer(
    { id: '../team/codex', env: { NOTES_VAULT: 'desk/notes-key' } },
    ctx.directory,
  )();

  expect(file).toBe(join(ctx.directory, 'agent-env-..%2Fteam%2Fcodex.sh'));
});

test('it writes the env file on its first call alone', () => {
  const ctx = setupTest();

  const syncEnvFile = makeAgentEnvFileSyncer(
    { id: 'codex', env: { NOTES_VAULT: 'desk/notes-key' } },
    ctx.directory,
  );

  const file = syncEnvFile();

  writeFileSync(join(ctx.directory, 'agent-env-codex.sh'), 'export NOTES_VAULT=edited\n');
  syncEnvFile();

  expect(readFileSync(join(ctx.directory, 'agent-env-codex.sh'), 'utf8')).toBe(
    'export NOTES_VAULT=edited\n',
  );

  expect(file).toBe(join(ctx.directory, 'agent-env-codex.sh'));
});
