import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHostFiles } from '@atc/plugin-api';
import { runLocalCommand, setupTempDir } from '@atc/test-utils';
import { loadGrokName } from './load-grok-name';

// A Grok home of the test's own, where summaries sit under each working
// directory's session folder.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-grok-name-');

  return { home: temporaryDirectory.path };
}

test('it loads a manual title over a user-typed name', async () => {
  const ctx = setupTest();
  const file = join(ctx.home, 'summary.json');

  writeFileSync(
    file,
    JSON.stringify({
      title_is_manual: true,
      generated_title: 'renamed in grok',
      session_summary: 'auto blurb',
    }),
  );

  const update = await loadGrokName(
    ctx.home,
    file,
    'user',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(update).toStrictEqual({ name: 'renamed in grok', namedBy: 'agent' });
});

test('it loads an auto title when the session was not user-named', async () => {
  const ctx = setupTest();
  const file = join(ctx.home, 'summary.json');

  writeFileSync(
    file,
    JSON.stringify({ generated_title: 'auto title', session_summary: 'auto blurb' }),
  );

  const update = await loadGrokName(
    ctx.home,
    file,
    'auto',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(update).toStrictEqual({ name: 'auto title' });
});

test('it keeps a user-typed name over an auto title', async () => {
  const ctx = setupTest();
  const file = join(ctx.home, 'summary.json');

  writeFileSync(
    file,
    JSON.stringify({ generated_title: 'auto title', session_summary: 'auto blurb' }),
  );

  const update = await loadGrokName(
    ctx.home,
    file,
    'user',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(update).toBeNull();
});

test('it loads the session summary when the summary file holds no title', async () => {
  const ctx = setupTest();
  const file = join(ctx.home, 'summary.json');

  writeFileSync(file, JSON.stringify({ generated_title: 7, session_summary: 'auto blurb' }));

  const update = await loadGrokName(
    ctx.home,
    file,
    'agent',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(update).toStrictEqual({ name: 'auto blurb' });
});

test('it loads a pretty-printed summary', async () => {
  const ctx = setupTest();
  const file = join(ctx.home, 'summary.json');

  writeFileSync(file, JSON.stringify({ generated_title: 'auto title' }, null, 2));

  const update = await loadGrokName(
    ctx.home,
    file,
    'auto',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(update).toStrictEqual({ name: 'auto title' });
});

test('it loads the summary through the files of the session host', async () => {
  const ctx = setupTest();

  const update = await loadGrokName(
    ctx.home,
    '/root/.grok/sessions/%2Fwork/g1/summary.json',
    'auto',
    {
      readMatchingLines: () => Promise.resolve(['{"generated_title":"guest title"}']),
      readDirectory: () => Promise.resolve(null),
    },
  );

  expect(update).toStrictEqual({ name: 'guest title' });
});

test('it scans the sessions of the home on the session host when the source is gone', async () => {
  const summaries = new Map([
    ['/root/.grok/sessions/%2Fwork%2Fnew/g1/summary.json', ['{"generated_title":"moved title"}']],
  ]);

  const directories = new Map([['/root/.grok/sessions', ['%2Fwork%2Fold', '%2Fwork%2Fnew']]]);

  const update = await loadGrokName(
    '/root/.grok',
    '/root/.grok/sessions/%2Fwork%2Fold/g1/summary.json',
    'auto',
    {
      readMatchingLines: (path) => Promise.resolve(summaries.get(path) ?? null),
      readDirectory: (path) => Promise.resolve(directories.get(path) ?? null),
    },
  );

  expect(update).toStrictEqual({ name: 'moved title' });
});

test('it loads the summary of the same session under another working directory when the source is gone', async () => {
  const ctx = setupTest();
  const moved = join(ctx.home, 'sessions', '%2Fwork%2Fnew', 'g1');

  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, 'summary.json'), JSON.stringify({ generated_title: 'found title' }));

  const update = await loadGrokName(
    ctx.home,
    join(ctx.home, 'sessions', '%2Fwork%2Fold', 'g1', 'summary.json'),
    'auto',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(update).toStrictEqual({ name: 'found title' });
});

test('it loads no name when no summary exists for the session', async () => {
  const ctx = setupTest();

  const update = await loadGrokName(
    ctx.home,
    join(ctx.home, 'sessions', '%2Fwork', 'g1', 'summary.json'),
    'auto',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(update).toBeNull();
});

test('it loads no name from a summary that is not a JSON object', async () => {
  const ctx = setupTest();
  const file = join(ctx.home, 'summary.json');

  writeFileSync(file, '["auto title"]');

  const update = await loadGrokName(
    ctx.home,
    file,
    'auto',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(update).toBeNull();
});
