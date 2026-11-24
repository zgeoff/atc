import { expect, test } from 'bun:test';
import { FLEET_CONTRACT, LOCAL_FLEET_CONTRACT } from '@atcx/contract';
import { createFleetClient } from './create-fleet-client';
import { createFleetRouter } from './create-fleet-router';
import { buildStubFleetCaller } from './test-utils/build-stub-fleet-caller';

test('it calls a procedure of the router as the principal the context names', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ stopped: true }) });
  const principal = { id: 'service:ci', name: 'ci' };

  const client = createFleetClient(createFleetRouter({ caller, contract: FLEET_CONTRACT }), {
    principal,
    scopes: ['kill'],
  });

  const answer = await client.session.kill({ session: 'build-box.k3f9.s7-m4x2p' });

  expect(answer).toStrictEqual({ stopped: true });

  expect(caller.requests).toStrictEqual([
    {
      method: 'session.kill',
      params: { session: 'build-box.k3f9.s7-m4x2p', stopOnly: true },
      principal,
    },
  ]);
});

test('it refuses a call whose scope the context lacks', () => {
  const caller = buildStubFleetCaller();

  const client = createFleetClient(createFleetRouter({ caller, contract: FLEET_CONTRACT }), {
    principal: null,
    scopes: ['read'],
  });

  expect(client.session.kill({ session: 's1' })).rejects.toMatchObject({
    code: 'insufficient_scope',
  });
});

test('it holds no daemons procedure for a local router', () => {
  const caller = buildStubFleetCaller();

  const client = createFleetClient(createFleetRouter({ caller, contract: LOCAL_FLEET_CONTRACT }), {
    principal: null,
    scopes: ['read'],
  });

  expect(client.daemons).toBeUndefined();
});
