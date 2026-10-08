import { expect, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscriptLine } from '../agents/parse-claude-transcript-line';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { loadTranscriptPage } from './load-transcript-page';

function setupTest() {
  const tmp = setupTempDir('atc-transcript-');

  return { dir: tmp.dir };
}

test('it reads every row from the start of a transcript', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');

  const content =
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
    '{"type":"user","message":{"role":"user","content":"two"}}\n' +
    '{"type":"user","message":{"role":"user","content":"three"}}\n';

  writeFileSync(path, content);

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows).toStrictEqual([
    { role: 'user', text: 'one', tools: [], at: null },
    { role: 'user', text: 'two', tools: [], at: null },
    { role: 'user', text: 'three', tools: [], at: null },
  ]);

  expect(page.offset).toBe(Buffer.byteLength(content));
  expect(page.more).toBe(false);
});

test('it stops at the row limit and reports more rows', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}\n' +
      '{"type":"user","message":{"role":"user","content":"three"}}\n',
  );

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 2,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows).toStrictEqual([
    { role: 'user', text: 'one', tools: [], at: null },
    { role: 'user', text: 'two', tools: [], at: null },
  ]);

  expect(page.more).toBe(true);
});

test('it resumes from the offset a page at the row limit returns', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}\n' +
      '{"type":"user","message":{"role":"user","content":"three"}}\n',
  );

  const first = await loadTranscriptPage({
    path,
    from: null,
    limit: 2,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  const second = await loadTranscriptPage({
    path,
    from: { path, offset: first.offset },
    limit: 2,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(second.rows).toStrictEqual([{ role: 'user', text: 'three', tools: [], at: null }]);
  expect(second.more).toBe(false);
});

test('it picks up rows appended after the last read', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');

  writeFileSync(path, '{"type":"user","message":{"role":"user","content":"one"}}\n');

  const first = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  appendFileSync(path, '{"type":"user","message":{"role":"user","content":"two"}}\n');

  const second = await loadTranscriptPage({
    path,
    from: { path, offset: first.offset },
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(second.rows).toStrictEqual([{ role: 'user', text: 'two', tools: [], at: null }]);
});

test('it leaves a trailing partial line unread', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');
  const complete = '{"type":"user","message":{"role":"user","content":"one"}}\n';

  writeFileSync(path, `${complete}{"type":"user","message":{"role":"user","content":"two"}}`);

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows).toStrictEqual([{ role: 'user', text: 'one', tools: [], at: null }]);
  expect(page.offset).toBe(Buffer.byteLength(complete));
});

test('it reads a partial line once a later write completes it', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}',
  );

  const first = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  appendFileSync(path, '\n');

  const second = await loadTranscriptPage({
    path,
    from: { path, offset: first.offset },
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(second.rows).toStrictEqual([{ role: 'user', text: 'two', tools: [], at: null }]);
});

test('it skips lines it cannot parse while advancing past them', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');

  const content =
    '{"type":"user","message":{"role":"user","content":"one"}}\ngarbage\n{"type":"user","message":{"role":"user","content":"two"}}\n';

  writeFileSync(path, content);

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows).toStrictEqual([
    { role: 'user', text: 'one', tools: [], at: null },
    { role: 'user', text: 'two', tools: [], at: null },
  ]);

  expect(page.offset).toBe(Buffer.byteLength(content));
});

test('it stops at the byte budget but always returns at least one row', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}\n',
  );

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 1,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows).toStrictEqual([{ role: 'user', text: 'one', tools: [], at: null }]);
  expect(page.more).toBe(true);
});

test('it reads from the start when the cursor belongs to another file', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}\n',
  );

  const page = await loadTranscriptPage({
    path,
    from: { path: '/elsewhere.jsonl', offset: 5 },
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows).toStrictEqual([
    { role: 'user', text: 'one', tools: [], at: null },
    { role: 'user', text: 'two', tools: [], at: null },
  ]);
});

test('it reads from the start when the cursor runs past the end of the file', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');

  writeFileSync(
    path,
    '{"type":"user","message":{"role":"user","content":"one"}}\n' +
      '{"type":"user","message":{"role":"user","content":"two"}}\n',
  );

  const page = await loadTranscriptPage({
    path,
    from: { path, offset: 10_000 },
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page.rows).toStrictEqual([
    { role: 'user', text: 'one', tools: [], at: null },
    { role: 'user', text: 'two', tools: [], at: null },
  ]);
});

test('it answers a missing transcript with an empty page', async () => {
  const ctx = setupTest();

  const page = await loadTranscriptPage({
    path: join(ctx.dir, 'missing.jsonl'),
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: parseClaudeTranscriptLine,
  });

  expect(page).toStrictEqual({ rows: [], offset: 0, more: false });
});

test('it returns when the file shrinks while it is being read', async () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 't.jsonl');
  const line = '{"type":"user","message":{"role":"user","content":"row"}}\n';

  // The file spans more than one 1 MiB read window, so a read runs after the
  // shrink.
  writeFileSync(path, line.repeat(30_000));

  let truncated = false;

  const page = await loadTranscriptPage({
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

  // The page holds the rows of the first window: the whole lines that fit
  // in 1 MiB.
  expect(page).toStrictEqual({
    rows: Array.from({ length: 18_078 }, () => ({
      role: 'user',
      text: 'row',
      tools: [],
      at: null,
    })),
    offset: 18_078 * Buffer.byteLength(line),
    more: false,
  });
});
