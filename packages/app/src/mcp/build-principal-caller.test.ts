import { expect, test } from 'bun:test';
import { buildStubFleetCaller } from '../test-utils/build-stub-fleet-caller';
import { buildPrincipalCaller } from './build-principal-caller';

test('it sends a request as the principal', async () => {
  const caller = buildStubFleetCaller();

  await buildPrincipalCaller(caller, { id: 'client-a', name: 'Lantern Notes' }).sendRequest(
    'session.list',
  );

  expect(caller.requests).toStrictEqual([
    { method: 'session.list', principal: { id: 'client-a', name: 'Lantern Notes' } },
  ]);
});

test('it sends a request as the principal over the principal the request asks for', async () => {
  const caller = buildStubFleetCaller();

  await buildPrincipalCaller(caller, { id: 'client-a', name: 'Lantern Notes' }).sendRequest(
    'session.spawn',
    { cwd: '/tmp' },
    { id: 'client-b', name: 'Tide Charts' },
  );

  expect(caller.requests).toStrictEqual([
    {
      method: 'session.spawn',
      params: { cwd: '/tmp' },
      principal: { id: 'client-a', name: 'Lantern Notes' },
    },
  ]);
});

test('it reports the features of the caller behind it', () => {
  const caller = buildStubFleetCaller({ features: ['fleet.daemons'] });

  expect(
    buildPrincipalCaller(caller, { id: 'client-a', name: 'Lantern Notes' }).readFeatures(),
  ).resolves.toStrictEqual(new Set(['fleet.daemons']));
});
