import { expect, test } from 'bun:test';
import { AtcError } from '@atcx/contract/light';
import { pickSnapshotStatus } from './pick-snapshot-status';

test.each([
  ['a session the daemon does not know', new AtcError('no_such_session', 'no session'), 404],
  ['a session that ended', new AtcError('session_dead', 'the session ended'), 409],
  ['any other daemon refusal', new AtcError('internal', 'the daemon failed'), 503],
  ['a dropped connection', new Error('the connection closed'), 503],
] as const)('it answers a snapshot that fails for %s with %d', (_label, error, status) => {
  expect(pickSnapshotStatus(error)).toBe(status);
});
