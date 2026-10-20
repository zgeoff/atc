import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { UnconfirmedSends } from './unconfirmed-sends';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-unconfirmed-sends-');
  const logs: string[] = [];

  return {
    directory: temporaryDirectory.path,
    path: join(temporaryDirectory.path, 'unconfirmed-sends.json'),
    logs,
    log: (line: string) => {
      logs.push(line);
    },
  };
}

test('it finds the thread of a message that an earlier instance set on the same file', () => {
  const ctx = setupTest();

  new UnconfirmedSends(ctx.path, ctx.log).setThread('m-1', 'thread-old');

  const sends = new UnconfirmedSends(ctx.path, ctx.log);

  expect(sends.findThread('m-1')).toBe('thread-old');
});

test('it writes each thread it sets to the file as one object', () => {
  const ctx = setupTest();

  const sends = new UnconfirmedSends(ctx.path, ctx.log);

  sends.setThread('m-1', 'thread-old');
  sends.setThread('m-2', 'thread-new');

  expect(JSON.parse(readFileSync(ctx.path, 'utf8'))).toStrictEqual({
    'm-1': 'thread-old',
    'm-2': 'thread-new',
  });
});

test('it drops the messages it removes from the file', () => {
  const ctx = setupTest();

  writeFileSync(ctx.path, JSON.stringify({ 'm-1': 'thread-old', 'm-2': 'thread-new' }));

  new UnconfirmedSends(ctx.path, ctx.log).removeMessages(['m-1']);

  expect(new UnconfirmedSends(ctx.path, ctx.log).collectMessages()).toStrictEqual(['m-2']);
});

test('it starts empty and logs nothing when the file does not exist', () => {
  const ctx = setupTest();

  const sends = new UnconfirmedSends(ctx.path, ctx.log);

  expect(sends.collectMessages()).toStrictEqual([]);
  expect(ctx.logs).toStrictEqual([]);
});

test('it starts empty and logs the file when it holds no map of threads', () => {
  const ctx = setupTest();

  writeFileSync(ctx.path, JSON.stringify({ 'm-1': 7 }));

  const sends = new UnconfirmedSends(ctx.path, ctx.log);

  expect(sends.collectMessages()).toStrictEqual([]);
  expect(ctx.logs).toStrictEqual([expect.toInclude(`${ctx.path} did not parse`)]);
});

test('it keeps the thread in memory and logs the file when the write fails', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'missing', 'unconfirmed-sends.json');

  const sends = new UnconfirmedSends(path, ctx.log);

  sends.setThread('m-1', 'thread-old');

  expect(sends.findThread('m-1')).toBe('thread-old');
  expect(ctx.logs).toStrictEqual([expect.toInclude(`${path} did not write`)]);
});

test('it starts empty and logs the file when it does not read', () => {
  const ctx = setupTest();

  mkdirSync(ctx.path);

  const sends = new UnconfirmedSends(ctx.path, ctx.log);

  expect(sends.collectMessages()).toStrictEqual([]);
  expect(ctx.logs).toStrictEqual([expect.toInclude(`${ctx.path} did not read`)]);
});

test('it keeps the threads in memory alone when it has no file', () => {
  const ctx = setupTest();

  const sends = new UnconfirmedSends(null, ctx.log);

  sends.setThread('m-1', 'thread-old');

  expect(sends.findThread('m-1')).toBe('thread-old');
  expect(new UnconfirmedSends(ctx.path, ctx.log).collectMessages()).toStrictEqual([]);
});
