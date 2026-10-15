import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { loadClaudeName } from './load-claude-name';

// A folder for the transcript a test writes.
function setupTest() {
  const tmp = setupTempDir('atc-claude-name-');

  return { dir: tmp.dir };
}

test('it names the session after the last custom title, as named by the agent', async () => {
  const ctx = setupTest();
  const transcript = join(ctx.dir, 'transcript.jsonl');

  writeFileSync(
    transcript,
    [
      '{"type":"custom-title","customTitle":"first"}',
      '{"type":"summary","summary":"a summary"}',
      '{"type":"custom-title","customTitle":"fix the build"}',
    ].join('\n'),
  );

  const name = await loadClaudeName(transcript, 'user');

  expect(name).toStrictEqual({ name: 'fix the build', namedBy: 'agent' });
});

test('it names an automatically named session after its summary', async () => {
  const ctx = setupTest();
  const transcript = join(ctx.dir, 'transcript.jsonl');

  writeFileSync(transcript, '{"type":"summary","summary":"Build fix"}\n');

  const name = await loadClaudeName(transcript, 'auto');

  expect(name).toStrictEqual({ name: 'Build fix' });
});

test('it keeps a name a person typed over a summary', async () => {
  const ctx = setupTest();
  const transcript = join(ctx.dir, 'transcript.jsonl');

  writeFileSync(transcript, '{"type":"summary","summary":"Build fix"}\n');

  const name = await loadClaudeName(transcript, 'user');

  expect(name).toBeNull();
});

test('it skips a line that is not a name line', async () => {
  const ctx = setupTest();
  const transcript = join(ctx.dir, 'transcript.jsonl');

  writeFileSync(
    transcript,
    ['{"type":"custom-title","customTitle":42}', '{"type":"summary",', ''].join('\n'),
  );

  const name = await loadClaudeName(transcript, 'auto');

  expect(name).toBeNull();
});

test('it gives no name for a transcript that does not exist', async () => {
  const ctx = setupTest();

  const name = await loadClaudeName(join(ctx.dir, 'missing.jsonl'), 'auto');

  expect(name).toBeNull();
});
