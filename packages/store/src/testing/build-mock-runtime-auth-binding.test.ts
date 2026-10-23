import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { buildMockRuntimeAuthBinding } from './build-mock-runtime-auth-binding';

test('it builds a default runtime auth binding', () => {
  expect(buildMockRuntimeAuthBinding()).toStrictEqual({
    hostKey: expect.toBeString(),
    target: 'box',
    targetIdentity: expect.toBeString(),
    hostName: expect.toStartWith('atc-'),
    hostID: expect.toBeString(),
    revision: 1,
    bindingHash: expect.toBeString(),
    bindingJSON: '{}',
    state: 'ready',
    attemptID: expect.toBeString(),
    hostCreatedByAttempt: true,
    rebind: null,
    createdAt: expect.toBeNumber(),
    updatedAt: expect.toBeNumber(),
    revokedAt: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockRuntimeAuthBinding({
      hostKey: toSessionID('s-1'),
      state: 'rebind_failed',
      hostID: null,
    }),
  ).toStrictEqual({
    hostKey: toSessionID('s-1'),
    target: 'box',
    targetIdentity: expect.toBeString(),
    hostName: expect.toStartWith('atc-'),
    hostID: null,
    revision: 1,
    bindingHash: expect.toBeString(),
    bindingJSON: '{}',
    state: 'rebind_failed',
    attemptID: expect.toBeString(),
    hostCreatedByAttempt: true,
    rebind: null,
    createdAt: expect.toBeNumber(),
    updatedAt: expect.toBeNumber(),
    revokedAt: null,
  });
});

test('it stamps a default binding as updated when it was created', () => {
  const binding = buildMockRuntimeAuthBinding();

  expect(binding.updatedAt).toBe(binding.createdAt);
});
