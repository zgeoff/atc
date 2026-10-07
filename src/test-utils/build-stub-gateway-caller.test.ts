import { expect, test } from 'bun:test';
import { buildStubFleetCaller } from './build-stub-fleet-caller';
import { buildStubGatewayCaller } from './build-stub-gateway-caller';

test('it refuses a request that requires the lacking feature as the gateway does', () => {
  const gateway = buildStubGatewayCaller(buildStubFleetCaller(), {
    daemon: 'old',
    lacking: 'session.forget.preconditions',
  });

  expect(
    gateway.sendRequest('session.forget', { session: 's1' }, [
      'session.forget',
      'session.forget.preconditions',
    ]),
  ).rejects.toMatchObject({
    code: 'daemon_outdated',
    data: { daemon: 'old', feature: 'session.forget.preconditions' },
  });
});

test('it sends nothing on for a request it refuses', async () => {
  const caller = buildStubFleetCaller();

  const gateway = buildStubGatewayCaller(caller, {
    daemon: 'old',
    lacking: 'session.forget.preconditions',
  });

  await gateway
    .sendRequest('session.forget', { session: 's1' }, ['session.forget.preconditions'])
    .catch(() => null);

  expect(caller.requests).toStrictEqual([]);
});

test('it passes every other request on unchanged', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's1' } }) });

  const gateway = buildStubGatewayCaller(caller, {
    daemon: 'old',
    lacking: 'session.forget.preconditions',
  });

  const got = await gateway.sendRequest('session.get', { session: 's1' }, ['report.get'], 'p-1');

  expect(got).toStrictEqual({ session: { id: 's1' } });

  expect(caller.requests).toStrictEqual([
    { m: 'session.get', p: { session: 's1' }, required: ['report.get'], principal: 'p-1' },
  ]);
});

test('it reports the features of the caller it wraps, the lacking one included', () => {
  const gateway = buildStubGatewayCaller(
    buildStubFleetCaller({ features: ['session.forget', 'session.forget.preconditions'] }),
    { daemon: 'old', lacking: 'session.forget.preconditions' },
  );

  expect(gateway.readFeatures()).resolves.toStrictEqual(
    new Set(['session.forget', 'session.forget.preconditions']),
  );
});
