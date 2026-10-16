import { expect, test } from 'bun:test';
import { buildMockIdempotencyRecord } from './build-mock-idempotency-record';

test('it builds a default idempotency record', () => {
  expect(buildMockIdempotencyRecord()).toStrictEqual({
    principal: expect.toBeString(),
    operation: expect.toBeString(),
    key: expect.toBeString(),
    payloadHash: expect.toBeString(),
    state: 'completed',
    effectRef: expect.toBeString(),
    result: null,
    effectTarget: null,
    createdAt: expect.toBeNumber(),
    updatedAt: expect.toBeNumber(),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockIdempotencyRecord({
      operation: 'session.spawn',
      effectRef: 's-1',
      effectTarget: { target: 'local', targetIdentity: 'local-pty:test' },
    }),
  ).toStrictEqual({
    principal: expect.toBeString(),
    operation: 'session.spawn',
    key: expect.toBeString(),
    payloadHash: expect.toBeString(),
    state: 'completed',
    effectRef: 's-1',
    result: null,
    effectTarget: { target: 'local', targetIdentity: 'local-pty:test' },
    createdAt: expect.toBeNumber(),
    updatedAt: expect.toBeNumber(),
  });
});

test('it stamps a default record as updated when it was created', () => {
  const record = buildMockIdempotencyRecord();

  expect(record.updatedAt).toBe(record.createdAt);
});
