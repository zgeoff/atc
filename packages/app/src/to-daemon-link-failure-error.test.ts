import { expect, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { RemoteTokenError } from './remote-token-error';
import { toDaemonLinkFailureError } from './to-daemon-link-failure-error';

test.each([
  {
    name: 'a token the client cannot read',
    error: new RemoteTokenError('no token file'),
    kind: 'unauthorized',
  },
  {
    name: 'a token the daemon refuses',
    error: new DaemonError('unauthorized', 'a valid bearer token is needed'),
    kind: 'unauthorized',
  },
  {
    name: 'a daemon on another protocol',
    error: new DaemonError('protocol_mismatch', 'speaks v14'),
    kind: 'mismatched',
  },
  { name: 'a daemon that cannot be reached', error: new Error('ECONNREFUSED'), kind: 'down' },
] as const)('it classifies $name as $kind', (row) => {
  expect(toDaemonLinkFailureError(row.error)).toMatchObject({
    kind: row.kind,
    message: row.error.message,
  });
});
