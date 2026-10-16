import { expect, test } from 'bun:test';
import type { RuntimeAuthBindingState } from '@atc/store';
import { buildMockRuntimeAuthBinding } from '@atc/store/testing';
import { planLaunchAdmission } from './plan-launch-admission';

test.each<[RuntimeAuthBindingState, 'admit' | 'blocked']>([
  ['provisioning', 'admit'],
  ['ready', 'admit'],
  ['revoked', 'blocked'],
  ['revocation_pending', 'blocked'],
  ['rollback_pending', 'blocked'],
  ['rebind_failed', 'blocked'],
])('it plans a launch of the provisioning attempt on a %s binding as %s', (state, expected) => {
  const row = buildMockRuntimeAuthBinding({ state, attemptID: 'attempt-1' });

  expect(planLaunchAdmission(row, 'attempt-1')).toBe(expected);
});

test('it blocks a launch on a binding another attempt provisions', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'provisioning', attemptID: 'attempt-2' });

  expect(planLaunchAdmission(row, 'attempt-1')).toBe('blocked');
});

test('it blocks a launch with no attempt on a provisioning binding', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'provisioning', attemptID: 'attempt-1' });

  expect(planLaunchAdmission(row, null)).toBe('blocked');
});

test('it blocks a launch on a binding a rebind provisions', () => {
  const row = buildMockRuntimeAuthBinding({
    state: 'provisioning',
    attemptID: 'attempt-1',
    rebind: { revision: 2, bindingHash: 'hash-2', bindingJSON: '{}', attemptID: 'attempt-3' },
  });

  expect(planLaunchAdmission(row, 'attempt-1')).toBe('blocked');
});

test('it admits a launch with no attempt on a ready binding', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'ready' });

  expect(planLaunchAdmission(row, null)).toBe('admit');
});

test('it blocks a launch on a host with no binding', () => {
  expect(planLaunchAdmission(null, 'attempt-1')).toBe('blocked');
});
