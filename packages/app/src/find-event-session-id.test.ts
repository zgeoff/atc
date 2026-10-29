import { expect, test } from 'bun:test';
import { buildMockSessionDescriptor } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { findEventSessionID } from './find-event-session-id';

test('it finds the session of an event that carries its descriptor', () => {
  const session = buildMockSessionDescriptor({ id: toSessionID('on-local') });

  expect(findEventSessionID({ ev: 'SessionState', session })).toBe('on-local');
});

test('it finds the session of an event that carries its id', () => {
  expect(
    findEventSessionID({ ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'one' }),
  ).toBe('on-local');
});

test('it finds no session for an event about none', () => {
  expect(
    findEventSessionID({ ev: 'PermissionResolved', request: 'request-1', decision: 'allow' }),
  ).toBeNull();
});
