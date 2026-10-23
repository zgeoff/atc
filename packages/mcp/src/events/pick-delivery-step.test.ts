import { expect, test } from 'bun:test';
import { pickDeliveryStep } from './pick-delivery-step';

test.each([
  [
    'HTTP 200 on the first attempt',
    { kind: 'answered', status: 200, body: '' },
    1,
    { kind: 'done' },
  ],
  [
    'HTTP 204 on the last attempt',
    { kind: 'answered', status: 204, body: '' },
    4,
    { kind: 'done' },
  ],
  ['HTTP 410', { kind: 'answered', status: 410, body: '' }, 1, { kind: 'drop' }],
  ['HTTP 413', { kind: 'answered', status: 413, body: '' }, 1, { kind: 'abandon' }],
  [
    'HTTP 500 on the first attempt',
    { kind: 'answered', status: 500, body: '' },
    1,
    { kind: 'retry', delayMs: 30_000 },
  ],
  [
    'HTTP 429 on the second attempt',
    { kind: 'answered', status: 429, body: '' },
    2,
    { kind: 'retry', delayMs: 120_000 },
  ],
  [
    'a timeout on the third attempt',
    { kind: 'failed', reason: 'timeout' },
    3,
    { kind: 'retry', delayMs: 480_000 },
  ],
  [
    'a refused connection on the fourth attempt',
    { kind: 'failed', reason: 'connection_refused' },
    4,
    { kind: 'abandon' },
  ],
  [
    'HTTP 503 on the fourth attempt',
    { kind: 'answered', status: 503, body: '' },
    4,
    { kind: 'abandon' },
  ],
] as const)('it picks the step after %s', (_, outcome, attempt, expected) => {
  expect(pickDeliveryStep(outcome, attempt)).toStrictEqual(expected);
});
