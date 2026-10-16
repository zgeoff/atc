import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { buildMockRuntimeAuthBinding } from './build-mock-runtime-auth-binding';

test('it builds a default runtime auth binding', () => {
  expect(buildMockRuntimeAuthBinding()).toStrictEqual({
    hostKey: expect.toBeString(),
    target: 'imp',
    targetIdentity: expect.toBeString(),
    impName: expect.toStartWith('atc-'),
    impID: expect.toBeString(),
    revision: 1,
    bindingHash: expect.toBeString(),
    bindingJSON: '{}',
    state: 'ready',
    attemptID: expect.toBeString(),
    impCreatedByAttempt: true,
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
      impID: null,
    }),
  ).toStrictEqual({
    hostKey: toSessionID('s-1'),
    target: 'imp',
    targetIdentity: expect.toBeString(),
    impName: expect.toStartWith('atc-'),
    impID: null,
    revision: 1,
    bindingHash: expect.toBeString(),
    bindingJSON: '{}',
    state: 'rebind_failed',
    attemptID: expect.toBeString(),
    impCreatedByAttempt: true,
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
