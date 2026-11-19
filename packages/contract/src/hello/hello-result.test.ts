import { expect, test } from 'bun:test';
import { HELLO_RESULT_SCHEMA } from './hello-result';

test('it reads a hello from a daemon that lists no features as one with none', () => {
  expect(
    HELLO_RESULT_SCHEMA.parse({
      daemon: 'atc/7.0.4+lq2x9a',
      daemonID: 'd-41',
      limits: { maxLine: 1_048_576, maxChunk: 65_536 },
      idempotency: { completedRetentionMs: 86_400_000 },
      lastUsedAgent: 'claude',
      peerSession: null,
    }),
  ).toStrictEqual({
    daemon: 'atc/7.0.4+lq2x9a',
    daemonID: 'd-41',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    idempotency: { completedRetentionMs: 86_400_000 },
    lastUsedAgent: 'claude',
    peerSession: null,
    features: [],
  });
});
