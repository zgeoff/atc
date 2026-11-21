import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@zgeoff/testing';
import type { ImpCreateSpec } from '../port/imp-port';
import { createStubImpFleet } from './create-stub-imp-fleet';

function setupTest() {
  const now = 1_000_000;
  const calls: string[] = [];
  const createSpecs: ImpCreateSpec[] = [];
  const fleet = createStubImpFleet({ principal: 'atc-daemon', now: () => now, calls, createSpecs });

  registerTestCleanup(async () => {
    for (const name of fleet.collectImpNames()) {
      await fleet.destroyImp(name);
    }
  });

  return { fleet, calls, createSpecs, now };
}

test('it creates an imp that runs after a cold boot at its start', async () => {
  const ctx = setupTest();

  const view = await ctx.fleet.createImp({ name: 'imp-a' });

  expect({
    name: view.name,
    state: view.state,
    coldBoots: ctx.fleet.getImp('imp-a').coldBoots,
  }).toStrictEqual({
    name: 'imp-a',
    state: 'running',
    coldBoots: [
      { bootId: ctx.fleet.getBootID('imp-a'), cause: 'start', at: new Date(ctx.now).toISOString() },
    ],
  });
});

test('it records the spec and the call of each create', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  expect({ calls: ctx.calls, specs: ctx.createSpecs }).toStrictEqual({
    calls: ['imps.create imp-a'],
    specs: [{ name: 'imp-a' }],
  });
});

test('it refuses to create an imp whose name is taken', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  expect(ctx.fleet.createImp({ name: 'imp-a' })).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('it reads null for an imp it does not hold', async () => {
  const ctx = setupTest();

  const view = await ctx.fleet.readImp('imp-a');

  expect(view).toBeNull();
});

test('it reads the live leases of an imp for its own principal and counts the others', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  ctx.fleet
    .getImp('imp-a')
    .leases.set('own', { principal: 'atc-daemon', label: 'atc-d1', until: ctx.now + 1 });

  ctx.fleet
    .getImp('imp-a')
    .leases.set('other', { principal: 'someone', label: 'hold', until: ctx.now + 1 });

  ctx.fleet
    .getImp('imp-a')
    .leases.set('expired', { principal: 'atc-daemon', label: 'old', until: ctx.now });

  const view = await ctx.fleet.readImp('imp-a');

  expect({
    own: view?.leases.map((lease) => lease.owner.label),
    others: view?.otherLeaseCount,
  }).toStrictEqual({
    own: ['atc-d1'],
    others: 1,
  });
});

test('it puts an unleased imp to sleep and wakes it from memory', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });
  await ctx.fleet.suspendImp('imp-a');

  const asleep = ctx.fleet.findState('imp-a');

  ctx.fleet.updateAwake(ctx.fleet.getImp('imp-a'));

  expect({ asleep, awake: ctx.fleet.findState('imp-a') }).toStrictEqual({
    asleep: 'sleeping',
    awake: 'running',
  });
});

test('it keeps the boot of an imp that wakes from sleep', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  const boot = ctx.fleet.getBootID('imp-a');

  await ctx.fleet.suspendImp('imp-a');

  ctx.fleet.updateAwake(ctx.fleet.getImp('imp-a'));

  expect(ctx.fleet.getBootID('imp-a')).toBe(boot);
});

test('it refuses to put a leased imp to sleep and names its leases', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  ctx.fleet
    .getImp('imp-a')
    .leases.set('own', { principal: 'atc-daemon', label: 'atc-d1', until: ctx.now + 1 });

  expect(ctx.fleet.suspendImp('imp-a')).rejects.toMatchObject({
    code: 'LEASED',
    data: { otherCount: 0 },
  });
});

test('it puts a leased imp to sleep when forced, and drops its leases', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  ctx.fleet
    .getImp('imp-a')
    .leases.set('own', { principal: 'atc-daemon', label: 'atc-d1', until: ctx.now + 1 });

  ctx.fleet.suspendWithForce('imp-a');

  expect({
    state: ctx.fleet.findState('imp-a'),
    leases: ctx.fleet.getImp('imp-a').leases.size,
  }).toStrictEqual({
    state: 'sleeping',
    leases: 0,
  });
});

test('it refuses to put an imp it does not hold to sleep', () => {
  const ctx = setupTest();

  expect(ctx.fleet.suspendImp('imp-a')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it boots an imp cold with a new boot and the cause, newest first', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  const first = ctx.fleet.getBootID('imp-a');

  ctx.fleet.bootImpCold('imp-a', 'watchdog');

  expect({
    changed: ctx.fleet.getBootID('imp-a') !== first,
    causes: ctx.fleet.getImp('imp-a').coldBoots.map((boot) => boot.cause),
  }).toStrictEqual({ changed: true, causes: ['watchdog', 'start'] });
});

test('it keeps the last four cold boots', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  for (let boot = 0; boot < 5; boot += 1) {
    ctx.fleet.bootImpCold('imp-a', 'watchdog');
  }

  expect(ctx.fleet.getImp('imp-a').coldBoots).toHaveLength(4);
});

test('it removes a destroyed imp', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });
  await ctx.fleet.destroyImp('imp-a');

  expect(ctx.fleet.collectImpNames()).toStrictEqual([]);
});

test('it refuses to destroy an imp it does not hold', () => {
  const ctx = setupTest();

  expect(ctx.fleet.destroyImp('imp-a')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it fails every destroy with the code it is given and keeps the imp', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  ctx.fleet.setDestroyFailure('SERVICE_UNAVAILABLE');

  await ctx.fleet.destroyImp('imp-a').catch(() => null);

  ctx.fleet.setDestroyFailure(null);

  expect(ctx.fleet.collectImpNames()).toStrictEqual(['imp-a']);
});

test('it holds destroys until the hold stops', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  ctx.fleet.startDestroyHold();

  const destroyed = ctx.fleet.destroyImp('imp-a');
  const held = { held: ctx.fleet.countHeldDestroys(), names: ctx.fleet.collectImpNames() };

  ctx.fleet.stopDestroyHold();

  await destroyed;

  expect({ held, after: ctx.fleet.collectImpNames() }).toStrictEqual({
    held: { held: 1, names: ['imp-a'] },
    after: [],
  });
});

test('it throws naming an imp it does not hold', () => {
  const ctx = setupTest();

  expect(() => ctx.fleet.getImp('imp-a')).toThrowWithMessage(Error, 'no imp imp-a');
});

test('it throws naming a session it does not hold', async () => {
  const ctx = setupTest();

  await ctx.fleet.createImp({ name: 'imp-a' });

  expect(() => ctx.fleet.getGeneration('imp-a', 'agent')).toThrowWithMessage(
    Error,
    'no session agent on imp imp-a',
  );
});
