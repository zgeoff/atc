import { expect, test } from 'bun:test';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubBridgeContext } from './build-stub-bridge-context';

test('it finds no live session', () => {
  expect(buildStubBridgeContext().findSession(toSessionID('s1'))).toBeUndefined();
});

test('it records every report', async () => {
  const recorded = await buildStubBridgeContext().applyReport(toSessionID('s1'), {}, 'r-1');

  expect(recorded).toBeTrue();
});

test('it attaches every tap', () => {
  expect(buildStubBridgeContext().attachTap({ sendEvent: () => {} }, toSessionID('s1'))).toBe('ok');
});

test('it answers every ack as for an unknown message', async () => {
  const acked = await buildStubBridgeContext().ackMessage(
    { sendEvent: () => {} },
    toSessionID('s1'),
    toMessageID('m-1'),
  );

  expect(acked).toBe('unknown');
});

test('it replaces the member an override names', () => {
  const context = buildStubBridgeContext({ attachTap: () => 'missing' });

  expect(context.attachTap({ sendEvent: () => {} }, toSessionID('s1'))).toBe('missing');
});
