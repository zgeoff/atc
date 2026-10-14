import { expect, mock, test } from 'bun:test';
import { toSessionID } from '@atc/core/to-session-id';
import { runShellcheck } from '@atc/test-utils/run-shellcheck';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import type { ExecutionTarget } from './build-execution-targets';
import {
  HostDirClaims,
  REMOVE_DIR_SCRIPT,
  RESOLVE_DIR_SCRIPT,
  RESOLVE_HOME_SCRIPT,
} from './host-dir-claims';
import { SessionRegistry } from './session-registry';
import { buildStubMemoryProvider } from './testing/build-stub-memory-provider';

interface SetupConfig {
  readonly targets: readonly ExecutionTarget[];
}

function setupTest(config: SetupConfig) {
  const registry = new SessionRegistry({
    fallback: null,
    adapters: [],
    targets: config.targets,
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  const claims = new HostDirClaims({ registry });

  return { registry, claims };
}

test.each([
  ['resolves a host directory', RESOLVE_DIR_SCRIPT],
  ['removes a host directory', REMOVE_DIR_SCRIPT],
  ['resolves the host home', RESOLVE_HOME_SCRIPT],
])('it %s through a script that passes shellcheck', async (_label, script) => {
  const result = await runShellcheck(script);

  expect(result).toStrictEqual({ exitCode: 0, findings: [] });
});

test('it refuses a workspace inside the directory of a session listed on the same host', () => {
  const ctx = setupTest({
    targets: [buildMockExecutionTarget({ id: 'imp', provider: buildStubMemoryProvider() })],
  });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: '/work/a' }),
  ];

  expect(() => {
    ctx.claims.claimWorkspace(toSessionID('spawn-1'), toSessionID('host-1'), 'imp', '/work/a/b');
  }).toThrow(expect.objectContaining({ code: 'workspace_overlap' }));
});

test('it refuses the second of two overlapping workspace claims on one host', () => {
  const ctx = setupTest({
    targets: [buildMockExecutionTarget({ id: 'imp', provider: buildStubMemoryProvider() })],
  });

  ctx.claims.claimWorkspace(toSessionID('spawn-1'), toSessionID('host-1'), 'imp', '/work');

  expect(() => {
    ctx.claims.claimWorkspace(toSessionID('spawn-2'), toSessionID('host-1'), 'imp', '/work/b');
  }).toThrow(expect.objectContaining({ code: 'workspace_overlap' }));
});

test('it passes an overlapping workspace claim once the earlier claim is released', () => {
  const ctx = setupTest({
    targets: [buildMockExecutionTarget({ id: 'imp', provider: buildStubMemoryProvider() })],
  });

  ctx.claims.claimWorkspace(toSessionID('spawn-1'), toSessionID('host-1'), 'imp', '/work');
  ctx.claims.releaseWorkspace(toSessionID('spawn-1'));
  ctx.claims.claimWorkspace(toSessionID('spawn-2'), toSessionID('host-1'), 'imp', '/work/b');

  expect([...ctx.claims.reservations]).toStrictEqual([
    [
      toSessionID('spawn-2'),
      {
        hostKey: toSessionID('host-1'),
        target: 'imp',
        dir: '/work/b',
        resolved: null,
        kind: 'workspace',
      },
    ],
  ]);
});

test('it refuses a plain directory around a workspace still being built on the same host', () => {
  const ctx = setupTest({
    targets: [buildMockExecutionTarget({ id: 'imp', provider: buildStubMemoryProvider() })],
  });

  ctx.claims.claimWorkspace(toSessionID('spawn-1'), toSessionID('host-1'), 'imp', '/work/a');

  expect(() => {
    ctx.claims.claimPlainDir(toSessionID('spawn-2'), toSessionID('host-1'), 'imp', '/work');
  }).toThrow(expect.objectContaining({ code: 'workspace_overlap' }));
});

test('it resolves a host directory through its nearest existing directory', async () => {
  const provider = buildStubMemoryProvider({
    runCommand: () => Promise.resolve({ exitCode: 0, stdout: '/real/work\n\0/new', stderr: '' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  const resolved = await ctx.claims.resolveHostDir(provider, toSessionID('host-1'), '/work/new');

  expect(resolved).toBe('/real/work/new');
});

test('it refuses to resolve a host directory when the host command fails', () => {
  const provider = buildStubMemoryProvider({
    runCommand: () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'no such host' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  expect(ctx.claims.resolveHostDir(provider, toSessionID('host-1'), '/work')).rejects.toMatchObject(
    { code: 'host_unavailable' },
  );
});

test('it resolves the host home without its trailing newline', async () => {
  const provider = buildStubMemoryProvider({
    runCommand: () => Promise.resolve({ exitCode: 0, stdout: '/home/imp\n', stderr: '' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  const home = await ctx.claims.resolveHostHome(provider, toSessionID('host-1'));

  expect(home).toBe('/home/imp');
});

test('it refuses a relative host home', () => {
  const provider = buildStubMemoryProvider({
    runCommand: () => Promise.resolve({ exitCode: 0, stdout: 'imp\n', stderr: '' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  expect(ctx.claims.resolveHostHome(provider, toSessionID('host-1'))).rejects.toMatchObject({
    code: 'host_unavailable',
  });
});

test('it keeps a claimed directory that holds the directory of another session listed on the host', async () => {
  const provider = buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    runCommand: (spec) =>
      Promise.resolve({ exitCode: 0, stdout: `${spec.argv[4] ?? ''}\n\0`, stderr: '' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: '/work/a/inner' }),
  ];

  const removed = await ctx.claims.removeClaimedDir(
    provider,
    toSessionID('spawn-1'),
    toSessionID('host-1'),
    'imp',
    '/work/a',
  );

  expect(removed).toBeFalse();
  expect(provider.commands.map((c) => c.argv[2])).toStrictEqual([RESOLVE_DIR_SCRIPT]);
});

test('it removes a claimed directory on the host when no other session lies inside it', async () => {
  const provider = buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    runCommand: (spec) =>
      Promise.resolve({ exitCode: 0, stdout: `${spec.argv[4] ?? ''}\n\0`, stderr: '' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: '/work/b' }),
  ];

  const removed = await ctx.claims.removeClaimedDir(
    provider,
    toSessionID('spawn-1'),
    toSessionID('host-1'),
    'imp',
    '/work/a',
  );

  expect(removed).toBeTrue();

  expect(provider.commands.at(-1)).toStrictEqual({
    argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', '/work/a', '/work/a\nx'],
    cwd: '/',
    host: toSessionID('host-1'),
  });
});
