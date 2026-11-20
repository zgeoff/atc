import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDaemonSocketPaths } from './read-daemon-socket-paths';

function setupTest() {
  const folder = mkdtempSync(join(tmpdir(), 'atcx-paths-'));

  onTestFinished(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const daemonRecordFile = join(folder, 'daemon.json');

  return {
    daemonRecordFile,
    writeRecord: (text: string) => {
      writeFileSync(daemonRecordFile, text);
    },
  };
}

test('it gives the computed path, then the recorded path when it differs', async () => {
  const ctx = setupTest();

  ctx.writeRecord(JSON.stringify({ pid: 4, socketPath: '/run/other.sock' }));

  const paths = await readDaemonSocketPaths({
    daemonSocketPath: '/run/atc-daemon.sock',
    daemonRecordFile: ctx.daemonRecordFile,
  });

  expect(paths).toStrictEqual(['/run/atc-daemon.sock', '/run/other.sock']);
});

test('it gives the computed path alone when the record holds the same path', async () => {
  const ctx = setupTest();

  ctx.writeRecord(JSON.stringify({ socketPath: '/run/atc-daemon.sock' }));

  const paths = await readDaemonSocketPaths({
    daemonSocketPath: '/run/atc-daemon.sock',
    daemonRecordFile: ctx.daemonRecordFile,
  });

  expect(paths).toStrictEqual(['/run/atc-daemon.sock']);
});

test.each([
  ['a missing record', undefined],
  ['a record that is not JSON', 'not json'],
  ['a record with no socket path', '{"pid":4}'],
])('it gives the computed path alone for %s', async (_name, text) => {
  const ctx = setupTest();

  if (text !== undefined) {
    ctx.writeRecord(text);
  }

  const paths = await readDaemonSocketPaths({
    daemonSocketPath: '/run/atc-daemon.sock',
    daemonRecordFile: ctx.daemonRecordFile,
  });

  expect(paths).toStrictEqual(['/run/atc-daemon.sock']);
});
