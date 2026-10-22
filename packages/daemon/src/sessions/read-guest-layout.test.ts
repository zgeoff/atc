import { expect, test } from 'bun:test';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { readGuestLayout } from './read-guest-layout';

test('it reads the guest layout the provider declares', async () => {
  const provider = buildStubMemoryProvider({
    kind: 'box',
    remote: true,
    guest: { directory: '/var/lib/orchard-scratch/atc', atc: null },
  });

  const guest = await readGuestLayout(provider, 's-1');

  expect(guest).toStrictEqual({ directory: '/var/lib/orchard-scratch/atc', atc: null });
});

test('it refuses a provider that declares no guest layout', () => {
  const provider = buildStubMemoryProvider({ kind: 'box', remote: true });

  expect(readGuestLayout(provider, 's-1')).rejects.toMatchObject({
    code: 'unsupported_operation',
    message: "the box provider declares no folder for atc's files on its host",
    data: { provider: 'box', problem: 'no_guest_layout' },
  });
});
