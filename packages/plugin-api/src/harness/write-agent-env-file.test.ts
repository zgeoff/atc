import { expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLocalCommand, setupTempDir } from '@atc/test-utils';
import { buildAgentEnvFilePath } from './build-agent-env-file-path';
import { writeAgentEnvFile } from './write-agent-env-file';

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

test('it writes a value that a shell sources unchanged, running nothing in it', async () => {
  const ctx = setupTest();
  const value = "a$(touch x)`touch y`'b\nc";
  const file = writeAgentEnvFile(ctx.directory, 'codex', { NOTES_VAULT: value });

  const result = await runLocalCommand({
    argv: ['sh', '-c', '. "$1" && printf %s "$NOTES_VAULT"', 'sh', file],
    cwd: ctx.directory,
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout,
    ran: [existsSync(join(ctx.directory, 'x')), existsSync(join(ctx.directory, 'y'))],
  }).toStrictEqual({ exitCode: 0, stdout: value, ran: [false, false] });
});

test('it narrows an env file an earlier run left to its owner alone', () => {
  const ctx = setupTest();
  const left = buildAgentEnvFilePath(ctx.directory, 'grok');

  writeFileSync(left, 'export NOTES_VAULT=old\n');
  chmodSync(left, 0o644);

  const file = writeAgentEnvFile(ctx.directory, 'grok', { NOTES_VAULT: 'desk/notes-key' });

  expect(statSync(file).mode & 0o777).toBe(0o600);
});
