import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { findDaemonRecord } from './find-daemon-record';

// A temp directory to hold the record.
function setupTest() {
  const tmp = setupTempDir('atc-daemon-record-');

  return { recordPath: join(tmp.dir, 'daemon.json') };
}

test('it reads the protocol version the daemon wrote', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.recordPath,
    JSON.stringify({
      pid: 4120,
      socketPath: '/run/user/1000/atc-daemon.sock',
      reporterSocketPath: '/run/user/1000/atc.sock',
      eventsSocketPath: null,
      listenPort: null,
      protocol: 5,
    }),
  );

  expect(findDaemonRecord(ctx.recordPath)).toStrictEqual({
    pid: 4120,
    socketPath: '/run/user/1000/atc-daemon.sock',
    reporterSocketPath: '/run/user/1000/atc.sock',
    eventsSocketPath: null,
    listenPort: null,
    protocol: 5,
  });
});

test('it reads a record without a protocol version as a daemon on the line protocol', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.recordPath,
    JSON.stringify({
      pid: 4121,
      socketPath: '/run/user/1000/atc-daemon.sock',
      reporterSocketPath: '/run/user/1000/atc.sock',
      eventsSocketPath: null,
      listenPort: null,
    }),
  );

  expect(findDaemonRecord(ctx.recordPath)?.protocol).toBeNull();
});

test('it finds no record where none was written', () => {
  const ctx = setupTest();

  expect(findDaemonRecord(ctx.recordPath)).toBeNull();
});
