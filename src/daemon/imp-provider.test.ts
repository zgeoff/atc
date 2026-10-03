import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { ImpProvider } from './imp-provider';
import type { ImpTargetOptions } from './imp-provider';
import { verifyBrokerAuthority } from './verify-broker-authority';

// An imp provider over a fixture imp port whose target names a guest atc
// that no imp holds, so every prepare that needs atc fails its guest setup.
// The target takes any further options a test gives.
function setupTest(target: ImpTargetOptions = {}) {
  const tmp = setupTempDir('atc-imp-provider-');

  const port = new FixtureImpPort();

  const provider = new ImpProvider(port, {
    guestDir: join(tmp.dir, 'g'),
    guestATC: join(tmp.dir, 'missing-atc'),
    ...target,
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

test('it names each imp under the atc- prefix when the target sets none', async () => {
  using ctx = setupTest();

  await ctx.provider.prepareHost({ host: 's1', daemonID: 'd1' });

  expect({ prefix: ctx.provider.impPrefix, imps: ctx.port.collectImpNames() }).toStrictEqual({
    prefix: 'atc-',
    imps: ['atc-s1'],
  });
});

test("it names each imp under the target's configured prefix", async () => {
  using ctx = setupTest({ impPrefix: 'harness-' });

  await ctx.provider.prepareHost({ host: 's1', daemonID: 'd1' });

  expect(ctx.port.collectImpNames()).toStrictEqual(['harness-s1']);
});

test("it lets a token scoped to the target's configured prefix activate the broker for its imps", async () => {
  using ctx = setupTest({ impPrefix: 'harness-' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'harness-runtime',
    scope: 'manage',
    imps: ['harness-*'],
    grantable: ['glm'],
  });

  const verified = verifyBrokerAuthority(
    ctx.port,
    { impNames: [ctx.provider.getImpName('s1')], secrets: ['glm'] },
    ctx.provider.impPrefix,
  );

  await expect(verified).toResolve();
});

test("it refuses a token scoped beyond the target's configured prefix", () => {
  using ctx = setupTest({ impPrefix: 'harness-' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const verified = verifyBrokerAuthority(
    ctx.port,
    { impNames: [ctx.provider.getImpName('s1')], secrets: ['glm'] },
    ctx.provider.impPrefix,
  );

  expect(verified).rejects.toMatchObject({ code: 'auth_token_too_broad' });
});
