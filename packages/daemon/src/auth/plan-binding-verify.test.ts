import { expect, test } from 'bun:test';
import type { RuntimeAuthBindingState } from '@atc/store';
import { buildMockRuntimeAuthBinding } from '@atc/store/testing';
import { planBindingVerify } from './plan-binding-verify';

test.each<[RuntimeAuthBindingState, 'verify' | 'rebind' | 'blocked']>([
  ['provisioning', 'blocked'],
  ['ready', 'verify'],
  ['revoked', 'blocked'],
  ['revocation_pending', 'blocked'],
  ['rollback_pending', 'blocked'],
  ['rebind_failed', 'blocked'],
])('it plans the check of an unchanged %s binding as %s', (state, expected) => {
  const row = buildMockRuntimeAuthBinding({ state });

  expect(planBindingVerify(row, false, true)).toBe(expected);
});

test.each<[RuntimeAuthBindingState, 'verify' | 'rebind' | 'blocked']>([
  ['provisioning', 'blocked'],
  ['ready', 'rebind'],
  ['revoked', 'blocked'],
  ['revocation_pending', 'blocked'],
  ['rollback_pending', 'blocked'],
  ['rebind_failed', 'rebind'],
])(
  'it plans the check of a changed %s binding on a target that rebinds as %s',
  (state, expected) => {
    const row = buildMockRuntimeAuthBinding({ state });

    expect(planBindingVerify(row, true, true)).toBe(expected);
  },
);

test('it verifies a changed ready binding on a target that never rebinds', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'ready' });

  expect(planBindingVerify(row, true, false)).toBe('verify');
});

test('it blocks a changed failed-rebind binding on a target that never rebinds', () => {
  const row = buildMockRuntimeAuthBinding({ state: 'rebind_failed' });

  expect(planBindingVerify(row, true, false)).toBe('blocked');
});
