import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHostFiles } from '@atc/plugin-api';
import { runLocalCommand, setupTempDir } from '@atc/test-utils';
import { loadCodexName } from './load-codex-name';

// A Codex home for the session index a test writes.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-codex-name-');

  return { codexHome: temporaryDirectory.path };
}

test('it loads the latest indexed thread name', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.codexHome, 'session_index.jsonl'),
    [
      '{"id":"c-1","thread_name":"first title","updated_at":"2026-08-20T00:00:00Z"}',
      '{"id":"c-2","thread_name":"other session","updated_at":"2026-08-20T00:00:01Z"}',
      '{"id":"c-1","thread_name":"renamed title","updated_at":"2026-08-20T00:00:02Z"}',
    ].join('\n'),
  );

  const name = await loadCodexName(
    ctx.codexHome,
    'c-1',
    'auto',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(name).toStrictEqual({ name: 'renamed title' });
});

test('it never loads an indexed thread name over a user-typed name', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.codexHome, 'session_index.jsonl'),
    '{"id":"c-1","thread_name":"renamed title","updated_at":"2026-08-20T00:00:02Z"}\n',
  );

  const name = await loadCodexName(
    ctx.codexHome,
    'c-1',
    'user',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(name).toBeNull();
});

test('it loads no name for a session the index lacks', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.codexHome, 'session_index.jsonl'),
    [
      '{"id":"c-1","thread_name":"first title","updated_at":"2026-08-20T00:00:00Z"}',
      '{"id":"c-2","thread_name":"other session","updated_at":"2026-08-20T00:00:01Z"}',
    ].join('\n'),
  );

  const name = await loadCodexName(
    ctx.codexHome,
    'c-missing',
    'auto',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(name).toBeNull();
});

test('it skips index lines that do not parse or hold another id containing the source', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.codexHome, 'session_index.jsonl'),
    [
      '{"id":"c-1","thread_name":"kept title"}',
      '{"id":"c-1","thread_name":',
      '{"id":"c-10","thread_name":"another thread"}',
      '{"id":"c-1","thread_name":7}',
    ].join('\n'),
  );

  const name = await loadCodexName(
    ctx.codexHome,
    'c-1',
    'auto',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(name).toStrictEqual({ name: 'kept title' });
});

test('it loads no name when the latest title for the thread is empty', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.codexHome, 'session_index.jsonl'),
    ['{"id":"c-1","thread_name":"first title"}', '{"id":"c-1","thread_name":""}'].join('\n'),
  );

  const name = await loadCodexName(
    ctx.codexHome,
    'c-1',
    'agent',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(name).toBeNull();
});

test('it loads no name when the Codex home has no session index', async () => {
  const ctx = setupTest();

  const name = await loadCodexName(
    ctx.codexHome,
    'c-1',
    'auto',
    buildHostFiles(runLocalCommand, 'host-1'),
  );

  expect(name).toBeNull();
});
