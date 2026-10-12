import { expect, test } from 'bun:test';
import { buildNeedsInputEvent } from './build-needs-input-event';

test('it holds what the agent asks as the message and the detail', () => {
  expect(buildNeedsInputEvent({ kind: 'heartbeat' }, 'allow Bash?')).toStrictEqual({
    kind: 'needs-input',
    message: 'allow Bash?',
    detail: 'allow Bash?',
  });
});

test('it bounds the detail and keeps the whole message', () => {
  const event = buildNeedsInputEvent({ kind: 'heartbeat' }, 'x'.repeat(700));

  expect(event.message).toBe('x'.repeat(700));
  expect(event.detail).toHaveLength(600);
});

test('it leaves out the message of an empty notice', () => {
  expect(buildNeedsInputEvent({ kind: 'heartbeat' }, '')).toStrictEqual({ kind: 'needs-input' });
});

test('it leaves out the message of a line with none', () => {
  expect(buildNeedsInputEvent({ kind: 'heartbeat' }, undefined)).toStrictEqual({
    kind: 'needs-input',
  });
});
