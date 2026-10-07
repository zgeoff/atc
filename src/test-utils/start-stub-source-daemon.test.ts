import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { startStubSourceDaemon } from './start-stub-source-daemon';

function setupTest() {
  return setupTempDir('atc-stub-source-daemon-');
}

test('it offers the fixture source on the socket its environment gives', async () => {
  await using ctx = setupTest();

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
  await using ctx = setupTest();

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
  await using ctx = setupTest();

  const daemon = await startStubSourceDaemon({
    ...process.env,
    HOME: ctx.dir,
    XDG_RUNTIME_DIR: ctx.dir,
  });

  onTestFinished(() => daemon[Symbol.asyncDispose]());

  await daemon[Symbol.asyncDispose]();

  expect(() => process.kill(daemon.pid, 0)).toThrow();
});
