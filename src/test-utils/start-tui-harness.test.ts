import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { KEYS } from './keys';
import { startTUIHarness } from './start-tui-harness';

test('it boots the client in its home and captures the home screen', async () => {
  await using tui = startTUIHarness();

  tui.boot();

  await tui.waitFor('atc — control tower');

  expect(tui.read()).toInclude('atc — control tower');
});

test('it rejects a wait for text the client never draws with the tail of the capture', async () => {
  await using tui = startTUIHarness();

  tui.boot();

  await tui.waitFor('atc — control tower');

  expect(tui.waitFor('never drawn', 100)).rejects.toThrowWithMessage(
    Error,
    /^timed out waiting for "never drawn"; tail: ".*atc — control tower/su,
  );
});

test('it forgets what the client drew on reset', async () => {
  await using tui = startTUIHarness();

  tui.boot();

  await tui.waitFor('atc — control tower');

  tui.reset();

  expect(tui.read()).not.toInclude('atc — control tower');
});

test('it writes the fake binaries and transports with the fields given laid over them', () => {
  const tui = startTUIHarness();

  onTestFinished(() => tui[Symbol.asyncDispose]());

  tui.writeConfig({ leader: 'ctrl-]', workspaces: { sources: ['git'] } });

  expect(JSON.parse(readFileSync(tui.configPath, 'utf8'))).toStrictEqual({
    claudeBin: join(tui.home, 'fake-claude'),
    claudeArgs: [],
    grokBin: join(tui.home, 'fake-grok'),
    grokArgs: [],
    codexBin: join(tui.home, 'fake-codex'),
    codexArgs: [],
    gateways: [],
    workspaces: { gitTransports: ['https', 'ssh', 'http', 'file'], sources: ['git'] },
    leader: 'ctrl-]',
  });
});

test('it reads a decision the client logs without drawing it', async () => {
  await using tui = startTUIHarness();

  tui.boot();

  await tui.waitFor('atc — control tower');

  tui.reset();
  tui.write(KEYS.ctrlSpace);

  await tui.waitFor('no sessions — n to spawn');

  tui.write('H');

  expect(tui.waitForClientLog('ignored H on a session that cannot eject')).resolves.toBeUndefined();
});

test('it resolves the exit code of the client it booted', async () => {
  await using tui = startTUIHarness();

  tui.boot();

  await tui.waitFor('atc — control tower');

  tui.write('q');

  const exitCode = await tui.waitForExit();

  expect(exitCode).toBe(0);
});

test('it stops the daemon the client started on dispose', async () => {
  const tui = startTUIHarness();

  onTestFinished(() => tui[Symbol.asyncDispose]());

  tui.boot();

  await tui.waitFor('atc — control tower');

  const pid = Number(readFileSync(join(tui.home, 'atc-daemon.pid'), 'utf8'));

  await tui[Symbol.asyncDispose]();

  expect(() => process.kill(pid, 0)).toThrow();
});

test('it removes its home on dispose', async () => {
  const tui = startTUIHarness();

  onTestFinished(() => tui[Symbol.asyncDispose]());

  tui.boot();

  await tui.waitFor('atc — control tower');
  await tui[Symbol.asyncDispose]();

  expect(existsSync(tui.home)).toBe(false);
});

test('it starts a daemon offering the fixture source on the socket the client dials', async () => {
  await using tui = startTUIHarness();

  await tui.startSourceDaemon({ ATC_TEST_FIXTURE_URL: join(tui.home, 'upstream.git') });

  const daemon = await DaemonClient.open(join(tui.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('agents.list');

  expect(listed['sources']).toPartiallyContain({ id: 'fixture', kind: 'git' });
});

test('it starts a daemon offering no sources when asked for none', async () => {
  await using tui = startTUIHarness();

  await tui.startSourceDaemon({ ATC_TEST_SOURCES: 'none' });

  const daemon = await DaemonClient.open(join(tui.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('agents.list');

  expect(listed['sources']).toStrictEqual([]);
});
