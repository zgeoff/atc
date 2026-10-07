import { expect, test } from 'bun:test';
import { buildMockKeyBindingClaim } from './build-mock-key-binding-claim';

test('it builds a default key binding claim', () => {
  expect(buildMockKeyBindingClaim()).toStrictEqual({
    principal: expect.toSatisfy((value: string) => /^[0-9A-Za-z]{12}$/u.test(value)),
    operation: 'session.spawn',
    key: expect.toSatisfy((value: string) => /^[0-9A-Za-z]{16}$/u.test(value)),
    daemon: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    daemonID: expect.toSatisfy((value: string) => /^[0-9a-f-]{36}$/u.test(value)),
    retentionMs: expect.toBeWithin(1000, 86_400_001),
    payloadHash: expect.toSatisfy((value: string) => /^[0-9a-f]{64}$/u.test(value)),
    claimID: expect.toSatisfy((value: string) => /^[0-9a-f-]{36}$/u.test(value)),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockKeyBindingClaim({
      principal: 'c1',
      operation: 'session.message',
      key: 'k',
      retentionMs: null,
    }),
  ).toStrictEqual({
    principal: 'c1',
    operation: 'session.message',
    key: 'k',
    daemon: expect.toBeString(),
    daemonID: expect.toBeString(),
    retentionMs: null,
    payloadHash: expect.toBeString(),
    claimID: expect.toBeString(),
  });
});
