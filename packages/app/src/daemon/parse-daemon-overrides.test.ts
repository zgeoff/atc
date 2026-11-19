import { expect, test } from 'bun:test';
import { parseDaemonOverrides } from './parse-daemon-overrides';

test('it parses no override from an environment that sets none', () => {
  expect(parseDaemonOverrides({})).toStrictEqual({});
});

test('it parses the queue size and the tap grace the environment sets', () => {
  expect(parseDaemonOverrides({ ATC_QUEUE_BYTES: '4096', ATC_TAP_GRACE_MS: '0' })).toStrictEqual({
    queueBytes: 4096,
    tapGraceMs: 0,
  });
});

test.each([
  ['a queue size of 0', { ATC_QUEUE_BYTES: '0' }],
  ['a queue size that is no number', { ATC_QUEUE_BYTES: 'large' }],
  ['a negative tap grace', { ATC_TAP_GRACE_MS: '-1' }],
  ['a tap grace that is no number', { ATC_TAP_GRACE_MS: 'soon' }],
])('it leaves the default for %s', (_, env) => {
  expect(parseDaemonOverrides(env)).toStrictEqual({});
});
