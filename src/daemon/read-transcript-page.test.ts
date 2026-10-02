import { expect, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { parseClaudeTranscriptLine } from '../agents/parse-claude-transcript-line';
import { readTranscriptPage } from './read-transcript-page';

test('it reads every row from the start of a transcript', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const path = join(temp.dir, 't.jsonl');

  const content =
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
    '{"type":"user","message":{"role":"user","content":"two"}}\n' +
    '{"type":"user","message":{"role":"user","content":"three"}}\n';

  writeFileSync(path, content);

  const page = await readTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows.map((row) => row.text)).toStrictEqual(['one', 'two', 'three']);
  expect(page.offset).toBe(Buffer.byteLength(content));
  expect(page.more).toBe(false);
});

test('it stops at the row limit and resumes from the returned offset', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const path = join(temp.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}\n' +
      '{"type":"user","message":{"role":"user","content":"three"}}\n',
  );

  const first = await readTranscriptPage({
    path,
    from: null,
    limit: 2,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  const second = await readTranscriptPage({
    path,
    from: { path, offset: first.offset },
    limit: 2,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(first.rows).toHaveLength(2);
  expect(first.more).toBe(true);
  expect(second.rows.map((row) => row.text)).toStrictEqual(['three']);
  expect(second.more).toBe(false);
});

test('it picks up rows appended after the last read', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const path = join(temp.dir, 't.jsonl');

  writeFileSync(path, '{"type":"user","message":{"role":"user","content":"one"}}\n');

  const first = await readTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  appendFileSync(path, '{"type":"user","message":{"role":"user","content":"two"}}\n');

  const second = await readTranscriptPage({
    path,
    from: { path, offset: first.offset },
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(second.rows.map((row) => row.text)).toStrictEqual(['two']);
});

test('it leaves a trailing partial line for the next read', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const path = join(temp.dir, 't.jsonl');
  const complete = '{"type":"user","message":{"role":"user","content":"one"}}\n';
  const partial = '{"type":"user","message":{"role":"user","content":"two"}}\n'.trimEnd();

  writeFileSync(path, complete + partial);

  const first = await readTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  appendFileSync(path, '\n');

  const second = await readTranscriptPage({
    path,
    from: { path, offset: first.offset },
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(first.rows.map((row) => row.text)).toStrictEqual(['one']);
  expect(first.offset).toBe(Buffer.byteLength(complete));
  expect(second.rows.map((row) => row.text)).toStrictEqual(['two']);
});

test('it skips lines it cannot parse while advancing past them', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const path = join(temp.dir, 't.jsonl');

  const content =
    '{"type":"user","message":{"role":"user","content":"one"}}\ngarbage\n{"type":"user","message":{"role":"user","content":"two"}}\n';

  writeFileSync(path, content);

  const page = await readTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows.map((row) => row.text)).toStrictEqual(['one', 'two']);
  expect(page.offset).toBe(Buffer.byteLength(content));
});

test('it stops at the byte budget but always returns at least one row', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const path = join(temp.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}\n',
  );

  const page = await readTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 1,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows).toHaveLength(1);
  expect(page.more).toBe(true);
});

test('it reads from the start when the cursor belongs to another file', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const path = join(temp.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}\n',
  );

  const page = await readTranscriptPage({
    path,
    from: { path: '/elsewhere.jsonl', offset: 5 },
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows.map((row) => row.text)).toStrictEqual(['one', 'two']);
});

test('it reads from the start when the cursor runs past the end of the file', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const path = join(temp.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}\n',
  );

  const page = await readTranscriptPage({
    path,
    from: { path, offset: 10_000 },
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows.map((row) => row.text)).toStrictEqual(['one', 'two']);
});

test('it answers a missing transcript with an empty page', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const page = await readTranscriptPage({
    path: join(temp.dir, 'missing.jsonl'),
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page).toStrictEqual({ rows: [], offset: 0, more: false });
});

test('it returns when the file shrinks while it is being read', async () => {
  await using temp = setupTempDir('atc-transcript-');

  const path = join(temp.dir, 't.jsonl');
  const line = '{"type":"user","message":{"role":"user","content":"row"}}\n';

  writeFileSync(path, line.repeat(30_000));

  let truncated = false;

  const page = await readTranscriptPage({
    path,
    from: null,
    limit: 100_000,
    maxBytes: 100_000_000,
    parseLine: (text) => {
      if (!truncated) {
        truncated = true;

        writeFileSync(path, '');
      }

      return parseClaudeTranscriptLine(text);
    },
  });

  expect(page.more).toBe(false);
});
