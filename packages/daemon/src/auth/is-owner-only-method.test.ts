import { expect, test } from 'bun:test';
import { isOwnerOnlyMethod } from './is-owner-only-method';

test.each([
  ['daemon.quit', true],
  ['daemon.backup', true],
  ['fleet.restore', true],
  ['session.auth.revoke', true],
  ['session.auth.rebind', true],
  ['session.list', false],
  ['session.spawn', false],
  ['events.subscribe', false],
  ['daemon.nuke', false],
])('it reads %s as owner-only: %p', (method, ownerOnly) => {
  expect(isOwnerOnlyMethod(method)).toBe(ownerOnly);
});
