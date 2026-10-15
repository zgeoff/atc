import { expect, test } from 'bun:test';
import { toAgentSessionID } from '@atc/core';
import { buildTurnDoneEvent } from './build-turn-done-event';

test('it holds the last message as the result and the detail', () => {
  expect(
    buildTurnDoneEvent({ kind: 'heartbeat', agentSessionID: toAgentSessionID('c-1') }, 'done'),
  ).toStrictEqual({
    kind: 'turn-done',
    agentSessionID: toAgentSessionID('c-1'),
    detail: 'done',
    result: 'done',
  });
});

test('it bounds the detail and keeps the whole result', () => {
  const event = buildTurnDoneEvent({ kind: 'heartbeat' }, 'x'.repeat(700));

  expect(event.result).toBe('x'.repeat(700));
  expect(event.detail).toHaveLength(600);
});

test('it leaves out the result of an empty last message', () => {
  expect(buildTurnDoneEvent({ kind: 'heartbeat' }, '')).toStrictEqual({ kind: 'turn-done' });
});

test('it leaves out the result of a line with no last message', () => {
  expect(buildTurnDoneEvent({ kind: 'heartbeat' }, undefined)).toStrictEqual({
    kind: 'turn-done',
  });
});
