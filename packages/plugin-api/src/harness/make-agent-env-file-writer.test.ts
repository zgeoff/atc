import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { makeAgentEnvFileWriter } from './make-agent-env-file-writer';

// A state folder of the test's own.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-agent-env-writer-');

  return { directory: temporaryDirectory.path };
}

test('it writes no file for an entry without env', () => {
  const ctx = setupTest();
  const writeEnvFile = makeAgentEnvFileWriter({ id: 'grok', env: {} }, ctx.directory);

  expect({
    file: writeEnvFile(),
    written: existsSync(join(ctx.directory, 'agent-env-grok.sh')),
  }).toStrictEqual({ file: null, written: false });
});

test('it removes the env file an earlier run wrote for an entry that no longer has env', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'agent-env-codex.sh'), "export NOTES_VAULT='desk/old-key'\n");
  makeAgentEnvFileWriter({ id: 'codex', env: {} }, ctx.directory)();

  expect(existsSync(join(ctx.directory, 'agent-env-codex.sh'))).toBeFalse();
});

test('it keeps the env file of an agent id that holds a slash inside the folder', () => {
  const ctx = setupTest();

  const file = makeAgentEnvFileWriter(
    { id: '../team/codex', env: { NOTES_VAULT: 'desk/notes-key' } },
    ctx.directory,
  )();

  expect(file).toBe(join(ctx.directory, 'agent-env-..%2Fteam%2Fcodex.sh'));
});

test('it writes the env file on its first call alone', () => {
  const ctx = setupTest();

  const writeEnvFile = makeAgentEnvFileWriter(
    { id: 'codex', env: { NOTES_VAULT: 'desk/notes-key' } },
    ctx.directory,
  );

  const file = writeEnvFile();

  writeFileSync(join(ctx.directory, 'agent-env-codex.sh'), 'export NOTES_VAULT=edited\n');
  writeEnvFile();

  expect(readFileSync(join(ctx.directory, 'agent-env-codex.sh'), 'utf8')).toBe(
    'export NOTES_VAULT=edited\n',
  );

  expect(file).toBe(join(ctx.directory, 'agent-env-codex.sh'));
});
