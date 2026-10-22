import { expect, test } from 'bun:test';
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
