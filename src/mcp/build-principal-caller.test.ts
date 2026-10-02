import { expect, test } from 'bun:test';
import type { DaemonFeature } from '../protocol/daemon-features';
import { buildPrincipalCaller } from './build-principal-caller';
import type { FleetCaller } from './types';

test('it sends every request as the principal, only to a daemon that limits it to that principal', async () => {
  const sent: unknown[] = [];

  const caller: FleetCaller = {
    sendRequest: (m, p, required, principal) => {
      sent.push({ m, p, required, principal });

      return Promise.resolve({});
    },
    readFeatures: () => Promise.resolve(new Set<DaemonFeature>()),
  };

  const limited = buildPrincipalCaller(caller, 'client-a');

  await limited.sendRequest('session.list');
  await limited.sendRequest('session.spawn', { cwd: '/tmp' }, ['spawn.target'], 'client-b');

  expect(sent).toStrictEqual([
    { m: 'session.list', p: undefined, required: ['request.principal'], principal: 'client-a' },
    {
      m: 'session.spawn',
      p: { cwd: '/tmp' },
      required: ['spawn.target', 'request.principal'],
      principal: 'client-a',
    },
  ]);
});
