import { expect, test } from 'bun:test';
import { buildMockHostServices } from '@atc/test-utils';
import { LOCAL_PTY_PLUGIN } from './local-pty-plugin';

test('it reads a target slice with its id, options, and environment', () => {
  const schema = LOCAL_PTY_PLUGIN.configSchema({
    authProfiles: new Map(),
    entryID: 'local',
    foreignFields: new Set(),
  });

  expect(
    schema.safeParse({ id: 'local', options: {}, env: { HOME: '/home/u' } }).data,
  ).toStrictEqual({ id: 'local', options: {}, env: { HOME: '/home/u' } });
});

test('it creates a local PTY provider for a target', () => {
  const provider = LOCAL_PTY_PLUGIN.create(
    { id: 'local', options: {}, env: {} },
    buildMockHostServices(),
    { authProfiles: new Map() },
  );

  expect(provider.kind).toBe('local-pty');
});
