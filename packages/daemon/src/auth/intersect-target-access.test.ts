import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { buildSessionSetAccess } from './build-session-set-access';
import { buildTargetAccessFromGrants } from './build-target-access-from-grants';
import { intersectTargetAccess } from './intersect-target-access';

test('it uses only a target both accesses may use', () => {
  const access = intersectTargetAccess(
    buildTargetAccessFromGrants([
      { target: 'box', targetIdentity: 'remote:a' },
      { target: 'local', targetIdentity: 'local-pty' },
    ]),
    buildTargetAccessFromGrants([{ target: 'box', targetIdentity: 'remote:a' }]),
  );

  expect(access.canUse({ target: 'box', targetIdentity: 'remote:a' })).toBe(true);
  expect(access.canUse({ target: 'local', targetIdentity: 'local-pty' })).toBe(false);
});

test('it reaches only a session both accesses reach', () => {
  const access = intersectTargetAccess(
    buildSessionSetAccess(
      { target: 'box', targetIdentity: 'remote:a' },
      (id) => id === toSessionID('lead') || id === toSessionID('worker'),
    ),
    buildSessionSetAccess(
      { target: 'box', targetIdentity: 'remote:a' },
      (id) => id === toSessionID('worker'),
    ),
  );

  expect(access.canReach?.(toSessionID('worker'))).toBe(true);
  expect(access.canReach?.(toSessionID('lead'))).toBe(false);
});

test('it keeps the session set of one access when the other reaches whole trees', () => {
  const access = intersectTargetAccess(
    buildTargetAccessFromGrants([{ target: 'box', targetIdentity: 'remote:a' }]),
    buildSessionSetAccess(
      { target: 'box', targetIdentity: 'remote:a' },
      (id) => id === toSessionID('worker'),
    ),
  );

  expect(access.canReach?.(toSessionID('lead'))).toBe(false);
});

test('it reaches whole trees when neither access holds a session set', () => {
  const access = intersectTargetAccess(
    buildTargetAccessFromGrants([{ target: 'box', targetIdentity: 'remote:a' }]),
    buildTargetAccessFromGrants([{ target: 'box', targetIdentity: 'remote:a' }]),
  );

  expect(access.canReach).toBeNull();
});

test('it keeps the session set of a target access merged with a session-set access', () => {
  const access = buildTargetAccessFromGrants([{ target: 'box', targetIdentity: 'remote:a' }]).merge(
    buildSessionSetAccess(
      { target: 'box', targetIdentity: 'remote:a' },
      (id) => id === toSessionID('worker'),
    ),
  );

  expect(access.canReach?.(toSessionID('worker'))).toBe(true);
  expect(access.canReach?.(toSessionID('lead'))).toBe(false);
});
