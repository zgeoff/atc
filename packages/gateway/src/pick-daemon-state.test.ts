import { expect, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { GatewayError } from './gateway-error';
import { pickDaemonState } from './pick-daemon-state';
import type { DaemonState } from './pick-daemon-state';
import type { CallOutcome } from './wait-for-outcome';

test.each<[string, DaemonState, CallOutcome<unknown>]>([
  ['an answered handshake', 'up', { kind: 'answered', value: { build: 'atc/7.4.2+lq2x9a' } }],
  ['a handshake that timed out', 'down', { kind: 'timeout' }],
  [
    'a refused token',
    'unauthorized',
    {
      kind: 'failed',
      error: new GatewayError('daemon_unauthorized', 'refused', { daemon: 'harbor' }),
    },
  ],
  [
    'another state identity',
    'changed',
    {
      kind: 'failed',
      error: new GatewayError('daemon_unavailable', 'changed', {
        daemon: 'harbor',
        reason: 'daemon_changed',
      }),
    },
  ],
  [
    'another major version',
    'mismatched',
    {
      kind: 'failed',
      error: new GatewayError('daemon_unavailable', 'mismatched', {
        daemon: 'harbor',
        reason: 'daemon_mismatched',
      }),
    },
  ],
  [
    'an error the daemon answered',
    'refused',
    { kind: 'failed', error: new DaemonError('bad_args', 'no such method') },
  ],
  [
    'an unreachable daemon',
    'down',
    {
      kind: 'failed',
      error: new GatewayError('daemon_unavailable', 'unreachable', { daemon: 'harbor' }),
    },
  ],
])('it reports %s as %s', (_label, expected, outcome) => {
  expect(pickDaemonState(outcome)).toBe(expected);
});
