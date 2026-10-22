import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getRecord, getString, waitForEvent } from '@atc/test-utils';
import { startStubAgentDaemon } from './start-stub-agent-daemon';

test('it binds a Claude session that reports its start through the stand-in', async () => {
  const stub = await startStubAgentDaemon();

  const ok = await stub.daemon.client.sendRequest('session.spawn', {
    cwd: stub.home,
    cols: 80,
    rows: 24,
  });

  const changed = await waitForEvent(stub.daemon.events, {
    ev: 'SessionState',
    session: { state: 'needs_you' },
  });

  expect(changed).toMatchObject({
    session: { id: getString(getRecord(ok, 'session'), 'id'), agentSessionID: 'fake-1' },
  });

  expect(stub.agents.sessions.map((session) => session.kind)).toStrictEqual(['claude']);
});

test("it resolves a spawn's plugin folder under ~ in the stand-ins' home", async () => {
  const stub = await startStubAgentDaemon();

  mkdirSync(join(stub.home, 'plugins', 'band'), { recursive: true });

  const ok = await stub.daemon.client.sendRequest('session.spawn', {
    cwd: stub.home,
    pluginDirs: ['~/plugins/band'],
    cols: 80,
    rows: 24,
  });

  const resolved = join(stub.home, 'plugins', 'band');

  expect(ok).toMatchObject({ session: { pluginDirs: [resolved] } });
});

test('it refuses a message to a started session without a tap once the grace it sets has run out', async () => {
  const stub = await startStubAgentDaemon({ tapGraceMs: 0 });

  const ok = await stub.daemon.client.sendRequest('session.spawn', {
    cwd: stub.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(stub.daemon.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  expect(
    stub.daemon.client.sendRequest('session.message', { session: id, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it registers the agents the config builds from the stand-in executables', async () => {
  const stub = await startStubAgentDaemon({
    agents: (bins) => ({ grok: { bin: bins.grok } }),
  });

  await stub.daemon.client.sendRequest('session.spawn', {
    cwd: stub.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(stub.daemon.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  expect(stub.agents.sessions.map((session) => session.kind)).toStrictEqual(['grok']);
});
