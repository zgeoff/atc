import { expect, test } from 'bun:test';
import { toAgentSessionID } from '@atcx/contract';
import { buildHeartbeatEvent } from './build-heartbeat-event';

test("it holds the agent's session id the line held", () => {
  expect(buildHeartbeatEvent('c-1')).toStrictEqual({
    kind: 'heartbeat',
    agentSessionID: toAgentSessionID('c-1'),
  });
});

test('it leaves out the session id of a line that held none', () => {
  expect(buildHeartbeatEvent(undefined)).toStrictEqual({ kind: 'heartbeat' });
});
