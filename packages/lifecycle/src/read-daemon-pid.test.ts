import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readDaemonPID } from './read-daemon-pid';

function setupTest() {
  const dir = setupTempDir('find-daemon-pid-').path;
  const procRoot = join(dir, 'proc');
  const stateDir = join(dir, 'home', '.local', 'state', 'atc');

  // The test process stands in for a live daemon: its `/proc` entry shows
  // the daemon's command line and a home that holds the state directory.
  mkdirSync(join(procRoot, String(process.pid)), { recursive: true });
  writeFileSync(join(procRoot, String(process.pid), 'cmdline'), 'atc\0daemon\0');
  writeFileSync(join(procRoot, String(process.pid), 'environ'), `HOME=${join(dir, 'home')}\0`);

  return {
    dir,
    procRoot,
    stateDir,
    paths: {
      socketPath: join(dir, 'atc-daemon.sock'),
      recordFile: join(dir, 'daemon.json'),
      pidFile: join(dir, 'atc-daemon.pid'),
    },
  };
}

test('it takes the pid the record holds for the socket that answered', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.paths.recordFile,
    JSON.stringify({
      pid: 4242,
      socketPath: join(ctx.dir, 'run', 'atc-daemon.sock'),
      reporterSocketPath: join(ctx.dir, 'run', 'atc.sock'),
      eventsSocketPath: null,
    }),
  );

  expect(
    readDaemonPID(join(ctx.dir, 'run', 'atc-daemon.sock'), {
      paths: ctx.paths,
      stateDir: ctx.stateDir,
      procRoot: ctx.procRoot,
    }),
  ).toBe(4242);
});

test('it takes the pid file beside the computed socket when that socket answered', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.pidFile, '4343');

  expect(
    readDaemonPID(ctx.paths.socketPath, {
      paths: ctx.paths,
      stateDir: ctx.stateDir,
      procRoot: ctx.procRoot,
    }),
  ).toBe(4343);
});

test('it takes a recorded pid that runs the daemon on this state directory when no socket answered', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.paths.recordFile,
    JSON.stringify({
      pid: process.pid,
      socketPath: join(ctx.dir, 'run', 'atc-daemon.sock'),
      reporterSocketPath: join(ctx.dir, 'run', 'atc.sock'),
      eventsSocketPath: null,
    }),
  );

  expect(
    readDaemonPID(null, { paths: ctx.paths, stateDir: ctx.stateDir, procRoot: ctx.procRoot }),
  ).toBe(process.pid);
});

test('it takes the pid file when no socket answered and no record exists', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.pidFile, String(process.pid));

  expect(
    readDaemonPID(null, { paths: ctx.paths, stateDir: ctx.stateDir, procRoot: ctx.procRoot }),
  ).toBe(process.pid);
});

test('it never takes a recorded pid that runs the daemon of another state directory', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.paths.recordFile,
    JSON.stringify({
      pid: process.pid,
      socketPath: join(ctx.dir, 'run', 'atc-daemon.sock'),
      reporterSocketPath: join(ctx.dir, 'run', 'atc.sock'),
      eventsSocketPath: null,
    }),
  );

  expect(
    readDaemonPID(null, {
      paths: ctx.paths,
      stateDir: join(ctx.dir, 'other', '.local', 'state', 'atc'),
      procRoot: ctx.procRoot,
    }),
  ).toBeNull();
});

test('it never takes the pid file of the computed socket for another socket that answered', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.pidFile, String(process.pid));

  expect(
    readDaemonPID(join(ctx.dir, 'run', 'atc-daemon.sock'), {
      paths: ctx.paths,
      stateDir: ctx.stateDir,
      procRoot: ctx.procRoot,
    }),
  ).toBeNull();
});
