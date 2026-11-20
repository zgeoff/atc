import { afterAll } from 'bun:test';
import { startTestImpd } from '@impz/testing';
import type { TestImpd, TestImpdOptions } from '@impz/testing';

const running = new Map<string, Promise<TestImpd>>();

afterAll(async () => {
  const starting = [...running.values()];

  running.clear();

  const stopped = starting.map(async (promise) => {
    const impd = await promise;

    await impd.stop();
  });

  await Promise.all(stopped);
});

// Starts one impd for each set of options and keeps it for the rest of the
// file, which stops it in afterAll. Each acquire clears the faults and removes
// the imps, secrets and tokens an earlier test made, and keeps the root token.
export async function acquireSharedImpd(options: TestImpdOptions = {}): Promise<TestImpd> {
  const key = JSON.stringify(options);
  const starting = running.get(key) ?? startSeededImpd(options);

  running.set(key, starting);

  const impd = await starting;

  impd.clearFaults();

  const imps = await impd.client.imps.list();
  const secrets = await impd.client.secrets.list();
  const tokens = await impd.client.tokens.list();

  await Promise.all(imps.map((imp) => impd.client.imps.destroy({ name: imp.name })));
  await Promise.all(secrets.map((secret) => impd.client.secrets.delete({ name: secret.name })));
  await Promise.all(tokens.map((token) => impd.client.tokens.delete({ name: token.name })));

  return impd;
}

async function startSeededImpd(options: TestImpdOptions): Promise<TestImpd> {
  const impd = await startTestImpd(options);

  await impd.seedImage('ubuntu');

  return impd;
}
