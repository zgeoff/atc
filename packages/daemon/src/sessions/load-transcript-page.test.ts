import { expect, mock, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import type { TranscriptRow } from '@atcx/contract';
import { loadTranscriptPage } from './load-transcript-page';
import { readLocalTranscriptWindow } from './read-local-transcript-window';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-transcript-');

  return { directory: temporaryDirectory.path };
}

test('it reads every row from the start of a transcript', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');
  const content = 'one\ntwo\nthree\n';

  writeFileSync(path, content);

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
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
  const path = join(ctx.directory, 't.jsonl');

  writeFileSync(path, 'one\ntwo\nthree\n');

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 2,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  expect(page.rows).toStrictEqual([
    { role: 'user', text: 'one', tools: [], at: null },
    { role: 'user', text: 'two', tools: [], at: null },
  ]);

  expect(page.more).toBe(true);
});

test('it resumes from the offset a page at the row limit returns', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');

  writeFileSync(path, 'one\ntwo\nthree\n');

  const first = await loadTranscriptPage({
    path,
    from: null,
    limit: 2,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  const second = await loadTranscriptPage({
    path,
    from: { path, offset: first.offset },
    limit: 2,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  expect(second.rows).toStrictEqual([{ role: 'user', text: 'three', tools: [], at: null }]);
  expect(second.more).toBe(false);
});

test('it picks up rows appended after the last read', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');

  writeFileSync(path, 'one\n');

  const first = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  appendFileSync(path, 'two\n');

  const second = await loadTranscriptPage({
    path,
    from: { path, offset: first.offset },
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  expect(second.rows).toStrictEqual([{ role: 'user', text: 'two', tools: [], at: null }]);
});

test('it leaves a trailing partial line unread', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');

  writeFileSync(path, 'one\ntwo');

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  expect(page.rows).toStrictEqual([{ role: 'user', text: 'one', tools: [], at: null }]);
  expect(page.offset).toBe(Buffer.byteLength('one\n'));
});

test('it reads a partial line once a later write completes it', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');

  writeFileSync(path, 'one\ntwo');

  const first = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  appendFileSync(path, '\n');

  const second = await loadTranscriptPage({
    path,
    from: { path, offset: first.offset },
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  expect(second.rows).toStrictEqual([{ role: 'user', text: 'two', tools: [], at: null }]);
});

test('it skips lines it cannot parse while advancing past them', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');
  const content = 'one\ngarbage\ntwo\n';

  writeFileSync(path, content);

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) =>
      line === 'garbage' ? null : { role: 'user', text: line, tools: [], at: null },
    readWindow: readLocalTranscriptWindow,
  });

  expect(page.rows).toStrictEqual([
    { role: 'user', text: 'one', tools: [], at: null },
    { role: 'user', text: 'two', tools: [], at: null },
  ]);

  expect(page.offset).toBe(Buffer.byteLength(content));
});

test('it stops at the byte budget but always returns at least one row', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');

  writeFileSync(path, 'one\ntwo\n');

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 50,
    maxBytes: 1,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  expect(page.rows).toStrictEqual([{ role: 'user', text: 'one', tools: [], at: null }]);
  expect(page.more).toBe(true);
});

test('it reads from the start when the cursor belongs to another file', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');

  writeFileSync(path, 'one\ntwo\n');

  const page = await loadTranscriptPage({
    path,
    from: { path: '/elsewhere.jsonl', offset: 5 },
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  expect(page.rows).toStrictEqual([
    { role: 'user', text: 'one', tools: [], at: null },
    { role: 'user', text: 'two', tools: [], at: null },
  ]);
});

test('it reads from the start when the cursor runs past the end of the file', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');

  writeFileSync(path, 'one\ntwo\n');

  const page = await loadTranscriptPage({
    path,
    from: { path, offset: 10_000 },
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  expect(page.rows).toStrictEqual([
    { role: 'user', text: 'one', tools: [], at: null },
    { role: 'user', text: 'two', tools: [], at: null },
  ]);
});

test('it answers a missing transcript with an empty page', async () => {
  const ctx = setupTest();

  const page = await loadTranscriptPage({
    path: join(ctx.directory, 'missing.jsonl'),
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: readLocalTranscriptWindow,
  });

  expect(page).toStrictEqual({ rows: [], offset: 0, more: false });
});

test('it returns when the file shrinks while it is being read', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 't.jsonl');

  // The file spans more than one 1 MiB read window, so a read runs after the
  // shrink.
  writeFileSync(path, 'a row\n'.repeat(200_000));

  // The first line parsed empties the file; every later line parses as is.
  const parseLine = mock((line: string): TranscriptRow => ({
    role: 'user',
    text: line,
    tools: [],
    at: null,
  })).mockImplementationOnce((line) => {
    writeFileSync(path, '');

    return { role: 'user', text: line, tools: [], at: null };
  });

  const page = await loadTranscriptPage({
    path,
    from: null,
    limit: 300_000,
    maxBytes: 100_000_000,
    parseLine,
    readWindow: readLocalTranscriptWindow,
  });

  // The page holds the rows of the first window: the whole lines that fit
  // in 1 MiB.
  expect(page).toStrictEqual({
    rows: Array.from({ length: 174_762 }, () => ({
      role: 'user',
      text: 'a row',
      tools: [],
      at: null,
    })),
    offset: 174_762 * Buffer.byteLength('a row\n'),
    more: false,
  });
});

test('it reads only up to the size a window reports when the file grew meanwhile', async () => {
  const page = await loadTranscriptPage({
    path: '/tmp/atc/sessions/s-1/a-1.jsonl',
    from: null,
    limit: 50,
    maxBytes: 262_144,
    parseLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    readWindow: () => Promise.resolve({ size: 4, bytes: Buffer.from('one\ntwo\n') }),
  });

  expect(page).toStrictEqual({
    rows: [{ role: 'user', text: 'one', tools: [], at: null }],
    offset: 4,
    more: false,
  });
});
