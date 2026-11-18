import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { PROTOCOL_VERSION } from '@atcx/contract/light';
import { findEventSession } from './find-event-session';

test('it finds the session an event names by its session id', () => {
  expect(
    findEventSession({ version: PROTOCOL_VERSION, ev: 'SessionRemoved', sessionID: 's-1' }),
  ).toBe(toSessionID('s-1'));
});

test("it finds the session an event carries by the session's id", () => {
  expect(
    findEventSession({ version: PROTOCOL_VERSION, ev: 'SessionAdded', session: { id: 's-2' } }),
  ).toBe(toSessionID('s-2'));
});

test('it finds no session for an event about no one session', () => {
  expect(findEventSession({ version: PROTOCOL_VERSION, ev: 'DaemonRestarted' })).toBeNull();
});
