import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';

// A home and a runtime directory in a temp directory for the daemon
// process each test starts, which stops before the directory goes; `env` points the daemon's config, state, and
// sockets there.
function setupTest() {
  const tmp = setupTempDir('atc-run-source-');
  const home = join(tmp.dir, 'home');
  const runtime = join(tmp.dir, 'run');

  mkdirSync(home);
  mkdirSync(runtime, { mode: 0o700 });

  return {
    dir: tmp.dir,
    daemonSocketPath: join(runtime, 'atc-daemon.sock'),
    env: {
      ...process.env,
      HOME: home,
      XDG_RUNTIME_DIR: runtime,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
    },
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test('it offers the built-in sources and then the fixture source', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn([process.execPath, join(import.meta.dir, 'run-source-daemon.ts')], {
    env: {
      ...ctx.env,
      ATC_TEST_SOURCES: 'fixture',
      ATC_TEST_FIXTURE_URL: 'https://git.example/upstream.git',
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  await proc.stdout.getReader().read();

  const client = await DaemonClient.open(ctx.daemonSocketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const agents = await client.sendRequest('agents.list');

  expect(agents['sources']).toStrictEqual([
    { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
    { id: 'github', label: 'GitHub repository', kind: 'git' },
    { id: 'git', label: 'git URL', kind: 'git' },
    { id: 'fixture', label: 'fixture repository', kind: 'git' },
  ]);
});

test('it offers no sources when told none', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn([process.execPath, join(import.meta.dir, 'run-source-daemon.ts')], {
    env: { ...ctx.env, ATC_TEST_SOURCES: 'none' },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  await proc.stdout.getReader().read();

  const client = await DaemonClient.open(ctx.daemonSocketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const agents = await client.sendRequest('agents.list');

  expect(agents['sources']).toStrictEqual([]);
});

test('it lists the fixture repository at the fixture URL', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn([process.execPath, join(import.meta.dir, 'run-source-daemon.ts')], {
    env: {
      ...ctx.env,
      ATC_TEST_SOURCES: 'fixture',
      ATC_TEST_FIXTURE_URL: 'https://git.example/upstream.git',
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  await proc.stdout.getReader().read();

  const client = await DaemonClient.open(ctx.daemonSocketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const listed = await client.sendRequest('sources.list', { source: 'fixture', target: 'local' });

  expect(listed).toStrictEqual({
    source: 'fixture',
    scope: null,
    candidates: [
      {
        label: 'upstream',
        detail: 'fixture',
        pick: { kind: 'git', url: 'https://git.example/upstream.git' },
      },
    ],
  });
});

test('it lists the fixture repository under the scope it is given', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn([process.execPath, join(import.meta.dir, 'run-source-daemon.ts')], {
    env: {
      ...ctx.env,
      ATC_TEST_SOURCES: 'fixture',
      ATC_TEST_FIXTURE_URL: 'https://git.example/upstream.git',
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  await proc.stdout.getReader().read();

  const client = await DaemonClient.open(ctx.daemonSocketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const listed = await client.sendRequest('sources.list', {
    source: 'fixture',
    target: 'local',
    scope: 'acme',
  });

  expect(listed).toStrictEqual({
    source: 'fixture',
    scope: 'acme',
    candidates: [
      {
        label: 'acme/upstream',
        detail: 'fixture',
        pick: { kind: 'git', url: 'https://git.example/upstream.git' },
      },
    ],
  });
});

test('it appends each listing it serves to the source log', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn([process.execPath, join(import.meta.dir, 'run-source-daemon.ts')], {
    env: {
      ...ctx.env,
      ATC_TEST_SOURCES: 'fixture',
      ATC_TEST_FIXTURE_URL: 'https://git.example/upstream.git',
      ATC_TEST_SOURCE_LOG: join(ctx.dir, 'lists.log'),
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  await proc.stdout.getReader().read();

  const client = await DaemonClient.open(ctx.daemonSocketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');
  await client.sendRequest('sources.list', { source: 'fixture', target: 'local' });
  await client.sendRequest('sources.list', { source: 'fixture', target: 'local', scope: 'acme' });

  expect(readFileSync(join(ctx.dir, 'lists.log'), 'utf8')).toBe(
    '{"scope":null,"target":"local"}\n{"scope":"acme","target":"local"}\n',
  );
});

test.each([
  ['pick upstream', { kind: 'git', url: 'https://git.example/upstream.git' }],
  ['in acme', { kind: 'browse', scope: 'acme' }],
  ['something else', { kind: 'none' }],
])('it reads the input %p as %p', async (input, expected) => {
  using ctx = setupTest();

  await using proc = Bun.spawn([process.execPath, join(import.meta.dir, 'run-source-daemon.ts')], {
    env: {
      ...ctx.env,
      ATC_TEST_SOURCES: 'fixture',
      ATC_TEST_FIXTURE_URL: 'https://git.example/upstream.git',
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  await proc.stdout.getReader().read();

  const client = await DaemonClient.open(ctx.daemonSocketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const interpreted = await client.sendRequest('sources.interpret', {
    source: 'fixture',
    target: 'local',
    input,
  });

  expect(interpreted).toStrictEqual(expected);
});

test('it stops with exit code 0 on SIGTERM', async () => {
  using ctx = setupTest();

  await using proc = Bun.spawn([process.execPath, join(import.meta.dir, 'run-source-daemon.ts')], {
    env: { ...ctx.env, ATC_TEST_SOURCES: 'none' },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  await proc.stdout.getReader().read();

  proc.kill('SIGTERM');

  const exitCode = await proc.exited;

  expect(exitCode).toBe(0);
});
