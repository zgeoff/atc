import { expect, test } from 'bun:test';
import { buildMockExecutionHostServices } from '@atc/plugin-api/test-utils/build-mock-execution-host-services';
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

test('it names no shared place, so a local target has daemon scope', () => {
  expect(LOCAL_PTY_PLUGIN.place).toBeUndefined();
});

test('it creates a local PTY provider for a target', () => {
  const provider = LOCAL_PTY_PLUGIN.create(
    { id: 'local', options: {}, env: {} },
    buildMockExecutionHostServices(),
    { authProfiles: new Map() },
  );

  expect(provider.kind).toBe('local-pty');
});
