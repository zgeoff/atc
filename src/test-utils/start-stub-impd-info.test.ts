import { expect, onTestFinished, test } from 'bun:test';
import { startStubImpdInfo } from './start-stub-impd-info';

test('it answers a call with the features the test sets, in the RPC body shape', async () => {
  const impd = startStubImpdInfo();

  impd.info.features = { leases: true };

  const response = await fetch(`${impd.url}/rpc/system/info`, { method: 'POST', body: '{}' });

  expect({ status: response.status, body: await response.json() }).toStrictEqual({
    status: 200,
    body: { json: { features: { leases: true } } },
  });
});

test('it records the path of each call in order', async () => {
  const impd = startStubImpdInfo();

  await fetch(`${impd.url}/rpc/system/info`, { method: 'POST', body: '{}' });
  await fetch(`${impd.url}/rpc/tokens/whoami`, { method: 'POST', body: '{}' });

  expect(impd.paths).toStrictEqual(['/rpc/system/info', '/rpc/tokens/whoami']);
});

test('it stops serving once disposed', async () => {
  const impd = startStubImpdInfo();

  await impd[Symbol.asyncDispose]();

  expect(fetch(`${impd.url}/rpc/system/info`)).rejects.toThrow();
});

test('it stops serving once the test finishes without a dispose', () => {
  const impd = startStubImpdInfo();

  onTestFinished(() => {
    expect(fetch(`${impd.url}/rpc/system/info`)).rejects.toThrow();
  });
});
