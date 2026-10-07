import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { startStubSourceDaemon } from './start-stub-source-daemon';

// A temp directory for the daemon's home and sockets. Disposal removes it.
function setupTest() {
  const tmp = setupTempDir('atc-stub-source-daemon-');

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it offers the fixture source on the socket its environment gives', async () => {
  using ctx = setupTest();

  await using daemons = new AsyncDisposableStack();

  const daemon = await startStubSourceDaemon({
    ...process.env,
    HOME: ctx.dir,
    XDG_RUNTIME_DIR: ctx.dir,
    ATC_TEST_FIXTURE_URL: join(ctx.dir, 'upstream.git'),
  });

  daemons.use(daemon);

  const client = await DaemonClient.open(join(ctx.dir, 'atc-daemon.sock'));

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  const listed = await client.sendRequest('agents.list');

  expect(listed['sources']).toPartiallyContain({ id: 'fixture', kind: 'git' });
});

test('it offers no sources when asked for none', async () => {
  using ctx = setupTest();

  await using daemons = new AsyncDisposableStack();

  const daemon = await startStubSourceDaemon({
    ...process.env,
    HOME: ctx.dir,
    XDG_RUNTIME_DIR: ctx.dir,
    ATC_TEST_SOURCES: 'none',
  });

  daemons.use(daemon);

  const client = await DaemonClient.open(join(ctx.dir, 'atc-daemon.sock'));

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  const listed = await client.sendRequest('agents.list');

  expect(listed['sources']).toStrictEqual([]);
});

test('it stops the daemon process on dispose', async () => {
  using ctx = setupTest();

  await using daemon = await startStubSourceDaemon({
    ...process.env,
    HOME: ctx.dir,
    XDG_RUNTIME_DIR: ctx.dir,
  });

  await daemon[Symbol.asyncDispose]();

  expect(() => process.kill(daemon.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

test('it rejects when the daemon exits before it listens', async () => {
  using ctx = setupTest();

  // A runtime directory that is a file leaves the daemon nowhere to write
  // its pid file or bind its sockets, so it exits at start.
  writeFileSync(join(ctx.dir, 'not-a-dir'), '');

  const starting = startStubSourceDaemon({
    ...process.env,
    HOME: ctx.dir,
    XDG_RUNTIME_DIR: join(ctx.dir, 'not-a-dir'),
  });

  await expect(starting).toReject();

  expect(starting).rejects.toThrow('the source daemon exited before it listened');
});
