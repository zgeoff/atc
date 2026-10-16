import { expect, test } from 'bun:test';
import type { RuntimeAuthBindingState } from '@atc/store';
import { buildMockRuntimeAuthBinding } from '@atc/store/testing';
import { planReadyUpdate } from './plan-ready-update';

test.each<[RuntimeAuthBindingState, 'ready' | 'keep']>([
  ['provisioning', 'ready'],
  ['ready', 'keep'],
  ['revoked', 'keep'],
  ['revocation_pending', 'keep'],
  ['rollback_pending', 'keep'],
  ['rebind_failed', 'keep'],
])('it plans a %s binding of the starting attempt as %s', (state, expected) => {
  const row = buildMockRuntimeAuthBinding({ state, attemptID: 'attempt-1' });

  expect(planReadyUpdate(row, 'attempt-1')).toBe(expected);
});

test('it keeps a binding another attempt provisions', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'provisioning', attemptID: 'attempt-2' });

  expect(planReadyUpdate(row, 'attempt-1')).toBe('keep');
});

test('it keeps a binding a rebind provisions', () => {
  const row = buildMockRuntimeAuthBinding({
    state: 'provisioning',
    attemptID: 'attempt-1',
    rebind: { revision: 2, bindingHash: 'hash-2', bindingJSON: '{}', attemptID: 'attempt-3' },
  });

  expect(planReadyUpdate(row, 'attempt-1')).toBe('keep');
});

test('it keeps a host with no binding', () => {
  expect(planReadyUpdate(null, 'attempt-1')).toBe('keep');
});
