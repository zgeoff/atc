import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readDaemonSocketPaths } from './read-daemon-socket-paths';

// A temp directory for the daemon's files.
function setupTest() {
  const dir = setupTempDir('collect-daemon-socket-paths-').path;

  return { dir };
}

test('it tries the computed socket alone without a record', () => {
  const ctx = setupTest();

  const paths = {
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    recordFile: join(ctx.dir, 'daemon.json'),
    pidFile: join(ctx.dir, 'atc-daemon.pid'),
  };

  expect(readDaemonSocketPaths(paths)).toStrictEqual([join(ctx.dir, 'atc-daemon.sock')]);
});

test('it tries the recorded socket after the computed one', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'daemon.json'),
    JSON.stringify({
      pid: 42,
      socketPath: join(ctx.dir, 'run', 'atc-daemon.sock'),
      reporterSocketPath: join(ctx.dir, 'run', 'atc.sock'),
      eventsSocketPath: null,
    }),
  );

  const paths = {
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    recordFile: join(ctx.dir, 'daemon.json'),
    pidFile: join(ctx.dir, 'atc-daemon.pid'),
  };

  expect(readDaemonSocketPaths(paths)).toStrictEqual([
    join(ctx.dir, 'atc-daemon.sock'),
    join(ctx.dir, 'run', 'atc-daemon.sock'),
  ]);
});

test('it tries a recorded socket that matches the computed one once', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'daemon.json'),
    JSON.stringify({
      pid: 42,
      socketPath: join(ctx.dir, 'atc-daemon.sock'),
      reporterSocketPath: join(ctx.dir, 'atc.sock'),
      eventsSocketPath: null,
    }),
  );

  const paths = {
    socketPath: join(ctx.dir, 'atc-daemon.sock'),
    recordFile: join(ctx.dir, 'daemon.json'),
    pidFile: join(ctx.dir, 'atc-daemon.pid'),
  };

  expect(readDaemonSocketPaths(paths)).toStrictEqual([join(ctx.dir, 'atc-daemon.sock')]);
});
