import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { spawnGrokSession } from './spawn-grok-session';
import { startTUIHarness } from './start-tui-harness';

test('it spawns a Grok session under the name given in the client home', async () => {
  await using tui = startTUIHarness();

  tui.boot();

  await tui.waitFor('atc — control tower');

  await spawnGrokSession(tui, 'driven');

  const daemon = await DaemonClient.open(join(tui.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([{ name: 'driven', cwd: tui.home, agent: 'grok' }]);
});
