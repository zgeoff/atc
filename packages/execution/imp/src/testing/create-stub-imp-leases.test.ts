import { expect, test } from 'bun:test';
import { createStubImpFleet } from './create-stub-imp-fleet';
import { createStubImpLeases } from './create-stub-imp-leases';

function setupTest() {
  const calls: string[] = [];

  const fleet = createStubImpFleet({
    principal: 'atc-daemon',
    now: () => 1_000_000,
    calls,
    createSpecs: [],
  });

  const leases = createStubImpLeases({ calls, fleet });

  return { fleet, leases };
}

test.each([
  ['hold', 60],
  ['atc-d1', 9],
  ['atc-d1', 3601],
])('it refuses a lease under the label %s for %d seconds', async (label, ttlSeconds) => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  expect(ctx.leases.acquireLease('imp-a', label, ttlSeconds)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test.each([10, 3600])('it grants a lease for %d seconds', async (ttlSeconds) => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  await expect(ctx.leases.acquireLease('imp-a', 'atc-d1', ttlSeconds)).toResolve();
});
