import { expect, test } from 'bun:test';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { writeAgentEnvFile } from './write-agent-env-file';

// A state folder of the test's own.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-agent-env-file-');

  return { directory: temporaryDirectory.path };
}

test('it writes an export line per variable, each value quoted for the shell', () => {
  const ctx = setupTest();

  const file = writeAgentEnvFile(ctx.directory, 'codex', {
    NOTES_VAULT: "desk/it's-key",
    NOTES_REGION: 'eu west',
  });

  expect(readFileSync(file, 'utf8')).toBe(
    `${String.raw`export NOTES_VAULT='desk/it'\''s-key'`}\nexport NOTES_REGION='eu west'\n`,
  );
});

test('it narrows an env file an earlier run left to its owner alone', () => {
  const ctx = setupTest();
  const left = join(ctx.directory, 'agent-env-grok.sh');

  writeFileSync(left, 'export NOTES_VAULT=old\n');
  chmodSync(left, 0o644);

  const file = writeAgentEnvFile(ctx.directory, 'grok', { NOTES_VAULT: 'desk/notes-key' });

  expect(statSync(file).mode & 0o777).toBe(0o600);
});
