import { expect, test } from 'bun:test';
import { buildStubFleetCaller } from '../test-utils/build-stub-fleet-caller';
import { buildPrincipalCaller } from './build-principal-caller';

test('it sends a request as the principal, only to a daemon that limits it to that principal', async () => {
  const caller = buildStubFleetCaller();

  await buildPrincipalCaller(caller, 'client-a').sendRequest('session.list');

  expect(caller.requests).toStrictEqual([
    { m: 'session.list', required: ['request.principal'], principal: 'client-a' },
  ]);
});

test('it sends a request as the principal over the principal the request asks for, keeping the features it requires', async () => {
  const caller = buildStubFleetCaller();

  await buildPrincipalCaller(caller, 'client-a').sendRequest(
    'session.spawn',
    { cwd: '/tmp' },
    ['spawn.target'],
    'client-b',
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp' },
      required: ['spawn.target', 'request.principal'],
      principal: 'client-a',
    },
  ]);
});

test('it reports the features of the daemon behind it', () => {
  const caller = buildStubFleetCaller({ features: ['report.get'] });

  expect(buildPrincipalCaller(caller, 'client-a').readFeatures()).resolves.toStrictEqual(
    new Set(['report.get']),
  );
});
