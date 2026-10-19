import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import type { AgentAdapter, ExecutionProvider } from '@atc/plugin-api';
import { buildMockAgentAdapter, setupTempDir } from '@atc/test-utils';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { requireSessionPluginDirs } from './require-session-plugin-dirs';

function setupTest() {
  const tmp = setupTempDir('atc-session-plugin-dirs-');

  return { dir: tmp.dir };
}

test("it accepts a session whose agent's folders and own folders are all folders", () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'shared'));
  mkdirSync(join(ctx.dir, 'band'));

  const adapter: AgentAdapter = buildMockAgentAdapter({
    profile: {
      label: 'Claude',
      kind: 'claude',
      bin: 'sh',
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
      pluginDirs: [join(ctx.dir, 'shared')],
    },
  });

  const provider: ExecutionProvider = buildStubMemoryProvider({ kind: 'local-pty' });

  expect(() => {
    requireSessionPluginDirs(
      { findAdapter: () => adapter, findProvider: () => provider },
      buildMockSession({ id: toSessionID('s-1'), pluginDirs: [join(ctx.dir, 'band')] }),
    );
  }).not.toThrow();
});

test("it refuses a session whose agent's configured folder is gone, naming the path", () => {
  const ctx = setupTest();

  const adapter: AgentAdapter = buildMockAgentAdapter({
    profile: {
      label: 'Claude',
      kind: 'claude',
      bin: 'sh',
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
      pluginDirs: [join(ctx.dir, 'shared')],
    },
  });

  const provider: ExecutionProvider = buildStubMemoryProvider({ kind: 'local-pty' });

  expect(() => {
    requireSessionPluginDirs(
      { findAdapter: () => adapter, findProvider: () => provider },
      buildMockSession({ id: toSessionID('s-1') }),
    );
  }).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: `plugin folder '${join(ctx.dir, 'shared')}' does not exist`,
    }),
  );
});

test('it refuses a session whose own folder is gone, naming the path', () => {
  const ctx = setupTest();
  const provider: ExecutionProvider = buildStubMemoryProvider({ kind: 'local-pty' });

  expect(() => {
    requireSessionPluginDirs(
      { findAdapter: () => buildMockAgentAdapter(), findProvider: () => provider },
      buildMockSession({ id: toSessionID('s-1'), pluginDirs: [join(ctx.dir, 'band')] }),
    );
  }).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: `plugin folder '${join(ctx.dir, 'band')}' does not exist`,
    }),
  );
});

test("it refuses a session on a remote target when only its agent's config sets folders", () => {
  const adapter: AgentAdapter = buildMockAgentAdapter({
    profile: {
      label: 'Claude',
      kind: 'claude',
      bin: 'sh',
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
      pluginDirs: ['/opt/plugins/shared'],
    },
  });

  const provider: ExecutionProvider = buildStubMemoryProvider({ kind: 'imp-like', remote: true });

  expect(() => {
    requireSessionPluginDirs(
      { findAdapter: () => adapter, findProvider: () => provider },
      buildMockSession({ id: toSessionID('s-1'), target: 'box' }),
    );
  }).toThrow(expect.objectContaining({ code: 'unsupported' }));
});

test('it refuses a session with folders whose target has no provider, as on a remote target', () => {
  expect(() => {
    requireSessionPluginDirs(
      { findAdapter: () => buildMockAgentAdapter(), findProvider: () => null },
      buildMockSession({
        id: toSessionID('s-1'),
        target: 'box',
        pluginDirs: ['/opt/plugins/band'],
      }),
    );
  }).toThrow(expect.objectContaining({ code: 'unsupported' }));
});

test('it accepts a session without folders whose target has no provider', () => {
  expect(() => {
    requireSessionPluginDirs(
      { findAdapter: () => buildMockAgentAdapter(), findProvider: () => null },
      buildMockSession({ id: toSessionID('s-1'), target: 'box' }),
    );
  }).not.toThrow();
});
