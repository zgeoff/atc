import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLocalMatchingLines } from '@atc/plugin-api';
import { setupTempDir } from '@atc/test-utils';
import { loadClaudeName } from './load-claude-name';

// A folder for the transcript a test writes.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-claude-name-');

  return { directory: temporaryDirectory.path };
}

test('it names the session after the last custom title, as named by the agent', async () => {
  const ctx = setupTest();
  const transcript = join(ctx.directory, 'transcript.jsonl');

  writeFileSync(
    transcript,
    [
      '{"type":"custom-title","customTitle":"first"}',
      '{"type":"summary","summary":"a summary"}',
      '{"type":"custom-title","customTitle":"fix the build"}',
    ].join('\n'),
  );

  const name = await loadClaudeName(transcript, 'user', {
    readMatchingLines: readLocalMatchingLines,
  });

  expect(name).toStrictEqual({ name: 'fix the build', namedBy: 'agent' });
});

test('it names an automatically named session after its summary', async () => {
  const ctx = setupTest();
  const transcript = join(ctx.directory, 'transcript.jsonl');

  writeFileSync(transcript, '{"type":"summary","summary":"Build fix"}\n');

  const name = await loadClaudeName(transcript, 'auto', {
    readMatchingLines: readLocalMatchingLines,
  });

  expect(name).toStrictEqual({ name: 'Build fix' });
});

test('it keeps a name a person typed over a summary', async () => {
  const ctx = setupTest();
  const transcript = join(ctx.directory, 'transcript.jsonl');

  writeFileSync(transcript, '{"type":"summary","summary":"Build fix"}\n');

  const name = await loadClaudeName(transcript, 'user', {
    readMatchingLines: readLocalMatchingLines,
  });

  expect(name).toBeNull();
});

test('it skips a line that is not a name line', async () => {
  const ctx = setupTest();
  const transcript = join(ctx.directory, 'transcript.jsonl');

  writeFileSync(
    transcript,
    ['{"type":"custom-title","customTitle":42}', '{"type":"summary",', ''].join('\n'),
  );

  const name = await loadClaudeName(transcript, 'auto', {
    readMatchingLines: readLocalMatchingLines,
  });

  expect(name).toBeNull();
});

test('it gives no name for a transcript that does not exist', async () => {
  const ctx = setupTest();

  const name = await loadClaudeName(join(ctx.directory, 'missing.jsonl'), 'auto', {
    readMatchingLines: readLocalMatchingLines,
  });

  expect(name).toBeNull();
});

test('it reads the name lines through the files of the session host', async () => {
  const name = await loadClaudeName('/tmp/atc/sessions/s-1/a-1.jsonl', 'auto', {
    readMatchingLines: () =>
      Promise.resolve(['{"type":"custom-title","customTitle":"tidy the docs"}']),
  });

  expect(name).toStrictEqual({ name: 'tidy the docs', namedBy: 'agent' });
});
