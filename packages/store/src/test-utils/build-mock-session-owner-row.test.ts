import { expect, test } from 'bun:test';
import { buildMockSessionOwnerRow } from './build-mock-session-owner-row';

test('it builds a default owner row at the first ownership epoch', () => {
  expect(buildMockSessionOwnerRow()).toStrictEqual({
    session_id: expect.toBeString(),
    daemon_id: expect.toBeString(),
    owner_epoch: 1,
    updated_at: 0,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockSessionOwnerRow({ session_id: 's-1', daemon_id: 'd-1', owner_epoch: 3 }),
  ).toStrictEqual({ session_id: 's-1', daemon_id: 'd-1', owner_epoch: 3, updated_at: 0 });
});
