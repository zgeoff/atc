import { expect, test } from 'bun:test';
import { toMessageID, toSessionID } from '@atc/core';
import { buildStubBridgeContext } from './build-stub-bridge-context';

test('it finds no live session', () => {
  expect(buildStubBridgeContext().findSession(toSessionID('s1'))).toBeUndefined();
});

test('it records every note', async () => {
  const recorded = await buildStubBridgeContext().applyNote(toSessionID('s1'), {}, 'r-1');

  expect(recorded).toBeTrue();
});

test('it attaches every tap', () => {
  expect(
    buildStubBridgeContext().attachTap({ sendEvent: () => {} }, toSessionID('s1'), false),
  ).toBe('ok');
});

test('it answers every ack as for an unknown message', async () => {
  const acked = await buildStubBridgeContext().ackMessage(
    { sendEvent: () => {} },
    toSessionID('s1'),
    toMessageID('m-1'),
  );

  expect(acked).toBe('unknown');
});

test('it answers every notice ack as for an unknown notice', async () => {
  const acked = await buildStubBridgeContext().ackNotice(
    { sendEvent: () => {} },
    toSessionID('s1'),
    toMessageID('m-1'),
  );

  expect(acked).toBe('unknown');
});

test('it replaces the member an override names', () => {
  const context = buildStubBridgeContext({ attachTap: () => 'missing' });

  expect(context.attachTap({ sendEvent: () => {} }, toSessionID('s1'), false)).toBe('missing');
});
