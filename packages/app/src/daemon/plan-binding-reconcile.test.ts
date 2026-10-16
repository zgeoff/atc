import { expect, test } from 'bun:test';
import type { RuntimeAuthBindingState } from '@atc/store';
import { buildMockRuntimeAuthBinding } from '@atc/store/testing';
import { planBindingReconcile } from './plan-binding-reconcile';

test.each<[RuntimeAuthBindingState, 'settle_rebind' | 'remove_attempt' | 'keep']>([
  ['provisioning', 'remove_attempt'],
  ['ready', 'keep'],
  ['revoked', 'keep'],
  ['revocation_pending', 'keep'],
  ['rollback_pending', 'remove_attempt'],
  ['rebind_failed', 'keep'],
])(
  'it plans an unlisted %s binding with no rebind and a reachable broker as %s',
  (state, expected) => {
    const row = buildMockRuntimeAuthBinding({ state });

    expect(planBindingReconcile(row, { isOrphan: true, hasHost: true })).toBe(expected);
  },
);

test.each<[RuntimeAuthBindingState, 'settle_rebind' | 'remove_attempt' | 'keep']>([
  ['provisioning', 'settle_rebind'],
  ['ready', 'keep'],
  ['revoked', 'keep'],
  ['revocation_pending', 'keep'],
  ['rollback_pending', 'remove_attempt'],
  ['rebind_failed', 'settle_rebind'],
])(
  'it plans an unlisted %s binding with a rebind and a reachable broker as %s',
  (state, expected) => {
    const row = buildMockRuntimeAuthBinding({
      state,
      rebind: { revision: 2, bindingHash: 'hash-2', bindingJSON: '{}', attemptID: 'attempt-3' },
    });

    expect(planBindingReconcile(row, { isOrphan: true, hasHost: true })).toBe(expected);
  },
);

test('it keeps a provisioning binding a fleet entry lists', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'provisioning' });

  expect(planBindingReconcile(row, { isOrphan: false, hasHost: true })).toBe('keep');
});

test('it keeps an unlisted provisioning binding whose target has no broker here', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'provisioning' });

  expect(planBindingReconcile(row, { isOrphan: true, hasHost: false })).toBe('keep');
});

test('it keeps an unlisted binding pending its rollback whose target has no broker here', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'rollback_pending' });

  expect(planBindingReconcile(row, { isOrphan: true, hasHost: false })).toBe('keep');
});
