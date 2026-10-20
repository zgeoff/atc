import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readDaemonSocketPaths } from './read-daemon-socket-paths';

// A temp directory for the daemon's files.
function setupTest() {
  const directory = setupTempDir('collect-daemon-socket-paths-').path;

  return { directory };
}

test('it tries the computed socket alone without a record', () => {
  const ctx = setupTest();

  const paths = {
    socketPath: join(ctx.directory, 'atc-daemon.sock'),
    recordFile: join(ctx.directory, 'daemon.json'),
    pidFile: join(ctx.directory, 'atc-daemon.pid'),
  };

  expect(readDaemonSocketPaths(paths)).toStrictEqual([join(ctx.directory, 'atc-daemon.sock')]);
});

test('it tries the recorded socket after the computed one', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'daemon.json'),
    JSON.stringify({
      pid: 42,
      socketPath: join(ctx.directory, 'run', 'atc-daemon.sock'),
      reporterSocketPath: join(ctx.directory, 'run', 'atc.sock'),
      eventsSocketPath: null,
    }),
  );

  const paths = {
    socketPath: join(ctx.directory, 'atc-daemon.sock'),
    recordFile: join(ctx.directory, 'daemon.json'),
    pidFile: join(ctx.directory, 'atc-daemon.pid'),
  };

  expect(readDaemonSocketPaths(paths)).toStrictEqual([
    join(ctx.directory, 'atc-daemon.sock'),
    join(ctx.directory, 'run', 'atc-daemon.sock'),
  ]);
});

test('it tries a recorded socket that matches the computed one once', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'daemon.json'),
    JSON.stringify({
      pid: 42,
      socketPath: join(ctx.directory, 'atc-daemon.sock'),
      reporterSocketPath: join(ctx.directory, 'atc.sock'),
      eventsSocketPath: null,
    }),
  );

  const paths = {
    socketPath: join(ctx.directory, 'atc-daemon.sock'),
    recordFile: join(ctx.directory, 'daemon.json'),
    pidFile: join(ctx.directory, 'atc-daemon.pid'),
  };

  expect(readDaemonSocketPaths(paths)).toStrictEqual([join(ctx.directory, 'atc-daemon.sock')]);
});
