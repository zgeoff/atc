import { expect, test } from 'bun:test';
import { waitFor } from '@atc/test-utils';
import { buildStubRestoreImpProvider } from './build-stub-restore-imp-provider';

test('it reports itself as a remote imp with the imp capabilities and guest layout', async () => {
  const provider = buildStubRestoreImpProvider();

  expect(provider.kind).toBe('imp');
  expect(provider.remote).toBeTrue();

  const guest = await provider.readGuest?.();

  expect(guest).toStrictEqual({ directory: '/tmp/atc', atc: null });

  expect(provider.capabilities).toStrictEqual({
    spawn: true,
    attach: true,
    input: true,
    resize: true,
    kill: true,
    transfer: true,
    run: true,
    headless: false,
    suspend: true,
    destroy: true,
  });
});

test('it declares the workspace flags an imp declares', () => {
  expect(buildStubRestoreImpProvider()).toContainEntries([
    ['cloneOnTarget', true],
    ['hostGitIdentity', true],
    ['guestWorkspaceTrust', true],
  ]);
});

test('it names the imp of a host key under the atc- prefix', () => {
  expect(buildStubRestoreImpProvider().getImpName('s-1')).toBe('atc-s-1');
});

test('it finds an existing host only once its imp exists and records each check', async () => {
  const provider = buildStubRestoreImpProvider();

  const before = await provider.checkExistingHost('s-1');

  provider.createHost('s-1');

  const after = await provider.checkExistingHost('s-1');

  expect(before).toBeFalse();
  expect(after).toBeTrue();
  expect(provider.checked).toStrictEqual(['s-1', 's-1']);
});

test('it creates the imp of a host a prepare finds missing and only that one', async () => {
  const provider = buildStubRestoreImpProvider();

  provider.createHost('s-kept');

  await provider.prepareHost({ host: 's-kept', daemonID: 'd-1' });
  await provider.prepareHost({ host: 's-new', daemonID: 'd-1' });
  await provider.prepareHost({ host: 's-new', daemonID: 'd-1' });

  expect(provider.created).toStrictEqual(['s-new']);
});

test('it refuses the next prepare as a lease refusal and leaves no imp behind', () => {
  const provider = buildStubRestoreImpProvider();

  provider.refuseNextPrepare('UNAVAILABLE');

  const refused = provider.prepareHost({ host: 's-1', daemonID: 'd-1' });

  expect(refused).rejects.toMatchObject({
    code: 'host_unavailable',
    message: 'imp atc-s-1 cannot be used: impd refused the lease (UNAVAILABLE)',
    data: { provider: 'imp', problem: 'unavailable' },
  });

  expect(provider.created).toStrictEqual([]);
});

test('it lets the prepare after a refusal go through', async () => {
  const provider = buildStubRestoreImpProvider();

  provider.refuseNextPrepare('LEASED');

  await provider.prepareHost({ host: 's-1', daemonID: 'd-1' }).catch(() => {});
  await provider.prepareHost({ host: 's-1', daemonID: 'd-1' });

  expect(provider.created).toStrictEqual(['s-1']);
});

test('it holds each prepare until the hold stops', async () => {
  const provider = buildStubRestoreImpProvider();

  provider.startPrepareHold();

  const preparing = provider.prepareHost({ host: 's-1', daemonID: 'd-1' });

  await waitFor(() => {
    expect(provider.countHeldPrepares()).toBe(1);
  });

  const createdWhileHeld = [...provider.created];

  provider.stopPrepareHold();

  await preparing;

  expect(createdWhileHeld).toStrictEqual([]);
  expect(provider.created).toStrictEqual(['s-1']);
  expect(provider.countHeldPrepares()).toBe(0);
});

test('it records each prepare request, refused or not', async () => {
  const provider = buildStubRestoreImpProvider();

  provider.refuseNextPrepare('UNAVAILABLE');

  await provider.prepareHost({ host: 's-1', daemonID: 'd-1' }).catch(() => {});

  expect(provider.prepared).toStrictEqual([{ host: 's-1', daemonID: 'd-1' }]);
});
