import { expect, test } from 'bun:test';
import type { RuntimeAuthBindingState } from '@atc/store';
import { buildMockRuntimeAuthBinding } from '@atc/store/testing';
import { planRebindStart } from './plan-rebind-start';

test.each<[RuntimeAuthBindingState, 'rebind' | 'blocked']>([
  ['provisioning', 'rebind'],
  ['ready', 'rebind'],
  ['revoked', 'rebind'],
  ['revocation_pending', 'blocked'],
  ['rollback_pending', 'blocked'],
  ['rebind_failed', 'rebind'],
])('it plans a rebind of a %s binding with its imp recorded as %s', (state, expected) => {
  const row = buildMockRuntimeAuthBinding({ state, impID: 'imp-1' });

  expect(planRebindStart(row)).toBe(expected);
});

test('it blocks a rebind of a provisioning binding that never recorded its imp', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'provisioning', impID: null });

  expect(planRebindStart(row)).toBe('blocked');
});

test('it blocks a rebind of a binding another rebind provisions', () => {
  const row = buildMockRuntimeAuthBinding({
    state: 'provisioning',
    impID: 'imp-1',
    rebind: { revision: 2, bindingHash: 'hash-2', bindingJSON: '{}', attemptID: 'attempt-3' },
  });

  expect(planRebindStart(row)).toBe('blocked');
});
