import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { ImpProvider } from './imp-provider';

// An imp provider over a fixture imp port whose target names a guest atc
// that no imp holds, so every prepare that needs atc fails its guest setup.
function setupTest() {
  const tmp = setupTempDir('atc-imp-provider-');

  const port = new FixtureImpPort();

  const provider = new ImpProvider(port, {
    guestDir: join(tmp.dir, 'g'),
    guestATC: join(tmp.dir, 'missing-atc'),
  });

  return {
    port,
    provider,
    [Symbol.dispose]() {
      provider.dispose();
      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it destroys the imp a failed prepare created, since no session holds it', async () => {
  using ctx = setupTest();

  const prepared = ctx.provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(prepared).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { problem: 'no_guest_atc' },
  });

  await prepared.catch(() => null);

  expect(ctx.port.collectImpNames()).toBeEmpty();
});

test('it keeps an imp that existed before a failed prepare and gives back only its own lease', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.acquireOtherLease('atc-s1', 'token:other', 'build', 60);

  const prepared = ctx.provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  await prepared.catch(() => null);

  const imp = await ctx.port.readImp('atc-s1');

  expect(imp).toMatchObject({ name: 'atc-s1', leases: [], otherLeaseCount: 1 });
});
