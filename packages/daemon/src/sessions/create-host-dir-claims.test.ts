import { expect, mock, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setupTempDir, waitFor } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubLocalProvider } from '../testing/build-stub-local-provider';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { buildStubStaleRelativeProvider } from '../testing/build-stub-stale-relative-provider';
import {
  REMOVE_DIR_SCRIPT,
  RESOLVE_DIR_SCRIPT,
  createHostDirClaims,
} from './create-host-dir-claims';
import { createSessionRegistry } from './create-session-registry';

interface SetupConfig {
  readonly targets: readonly ExecutionTarget[];
}

function setupTest(config: SetupConfig) {
  const registry = createSessionRegistry({
    fallback: null,
    adapters: [],
    targets: config.targets,
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  const claims = createHostDirClaims({ registry });

  return { registry, claims };
}

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
        directory: '/work/b',
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

test('it refuses a workspace claim on a shared host while a removal runs there', async () => {
  const removing = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();

  const provider = buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    runCommand: (spec) =>
      spec.argv[2] === REMOVE_DIR_SCRIPT
        ? removing.promise
        : Promise.resolve({ exitCode: 0, stdout: `${spec.argv[4] ?? ''}\n\0`, stderr: '' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  const removal = ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('forgotten-1'),
    hostKey: toSessionID('host-1'),
    target: 'imp',
    directory: '/work/a',
  });

  await waitFor(() => {
    expect(provider.commands.map((command) => command.argv[2])).toContain(REMOVE_DIR_SCRIPT);
  });

  expect(() => {
    ctx.claims.claimWorkspace(toSessionID('spawn-1'), toSessionID('host-1'), 'imp', '/work/a/b');
  }).toThrow(expect.objectContaining({ code: 'workspace_overlap' }));

  removing.resolve({ exitCode: 0, stdout: '', stderr: '' });

  await removal;
});

test('it refuses a workspace landing on the daemon host inside a directory a removal is emptying', async () => {
  const removing = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();

  const provider = buildStubMemoryProvider({
    runCommand: (spec) =>
      spec.argv[2] === REMOVE_DIR_SCRIPT
        ? removing.promise
        : Promise.resolve({ exitCode: 0, stdout: `${spec.argv[4] ?? ''}\n\0`, stderr: '' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'local', provider })] });

  const removal = ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('forgotten-1'),
    hostKey: toSessionID('forgotten-1'),
    target: 'local',
    directory: '/work/a',
  });

  await waitFor(() => {
    expect(provider.commands.map((command) => command.argv[2])).toContain(REMOVE_DIR_SCRIPT);
  });

  expect(() => {
    ctx.claims.claimMachineDir(toSessionID('spawn-1'), 'local', '/work/a/nested');
  }).toThrow(expect.objectContaining({ code: 'workspace_overlap' }));

  removing.resolve({ exitCode: 0, stdout: '', stderr: '' });

  await removal;
});

test('it refuses a plain claim on a shared host while a removal hold runs there', async () => {
  const provider = buildStubMemoryProvider({ capabilities: { suspend: true, destroy: true } });
  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });
  const deciding = Promise.withResolvers<void>();

  const hold = ctx.claims.withRemovalHold(
    {
      id: toSessionID('forgotten-1'),
      hostKey: toSessionID('host-1'),
      target: 'imp',
      directory: '/work/a',
    },
    () => deciding.promise,
  );

  expect(() => {
    ctx.claims.claimPlainDir(toSessionID('spawn-1'), toSessionID('host-1'), 'imp', '/work/a');
  }).toThrow(expect.objectContaining({ code: 'workspace_overlap' }));

  deciding.resolve();

  await hold;
});

test('it passes a claim on the daemon host inside a directory once its removal hold ends', async () => {
  const provider = buildStubMemoryProvider();
  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'local', provider })] });

  await ctx.claims.withRemovalHold(
    {
      id: toSessionID('forgotten-1'),
      hostKey: toSessionID('forgotten-1'),
      target: 'local',
      directory: '/work/a',
    },
    () => Promise.resolve(),
  );

  expect(() => {
    ctx.claims.claimMachineDir(toSessionID('spawn-1'), 'local', '/work/a/nested');
  }).not.toThrow();
});

test('it keeps a directory on the daemon host that a workspace spawn claimed inside it first', async () => {
  const provider = buildStubMemoryProvider({
    runCommand: (spec) =>
      Promise.resolve({ exitCode: 0, stdout: `${spec.argv[4] ?? ''}\n\0`, stderr: '' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'local', provider })] });

  ctx.claims.claimMachineDir(toSessionID('spawn-1'), 'local', '/work/a/nested');

  const removed = await ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('forgotten-1'),
    hostKey: toSessionID('forgotten-1'),
    target: 'local',
    directory: '/work/a',
  });

  expect(removed).toBeFalse();
  expect(provider.commands.map((command) => command.argv[2])).not.toContain(REMOVE_DIR_SCRIPT);
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

  const removed = await ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('spawn-1'),
    hostKey: toSessionID('host-1'),
    target: 'imp',
    directory: '/work/a',
  });

  expect(removed).toBeFalse();
  expect(provider.commands.map((command) => command.argv[2])).toStrictEqual([RESOLVE_DIR_SCRIPT]);
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

  const removed = await ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('spawn-1'),
    hostKey: toSessionID('host-1'),
    target: 'imp',
    directory: '/work/a',
  });

  expect(removed).toBeTrue();

  expect(provider.commands.at(-1)).toStrictEqual({
    argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', '/work/a', '/work/a\nx'],
    cwd: '/',
    host: toSessionID('host-1'),
  });
});

test('it removes a claimed directory on the host when a stale relative directory resolves outside it from the home', async () => {
  const provider = buildStubStaleRelativeProvider();
  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: 'old-notes' }),
  ];

  const removed = await ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('spawn-1'),
    hostKey: toSessionID('host-1'),
    target: 'imp',
    directory: '/home/guest/work/a',
  });

  expect(removed).toBeTrue();

  expect(provider.commands.at(-1)).toStrictEqual({
    argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', '/home/guest/work/a', '/home/guest/work/a\nx'],
    cwd: '/',
    host: toSessionID('host-1'),
  });
});

test('it keeps a claimed directory on the host when a stale relative directory resolves inside it from the home', async () => {
  const provider = buildStubStaleRelativeProvider();
  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: 'work/a/inner' }),
  ];

  const removed = await ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('spawn-1'),
    hostKey: toSessionID('host-1'),
    target: 'imp',
    directory: '/home/guest/work/a',
  });

  expect(removed).toBeFalse();
  expect(provider.commands.map((command) => command.argv[2])).not.toContain(REMOVE_DIR_SCRIPT);
});

test.each([
  ['an absolute directory', '/srv/gone'],
  ['a relative directory with a parent step', 'link/../gone'],
])(
  'it keeps a claimed directory on the host when %s the host cannot resolve may lie anywhere',
  async (_label, cwd) => {
    const provider = buildStubMemoryProvider({
      capabilities: { suspend: true, destroy: true },
      runCommand: (spec) => {
        const result =
          spec.argv[2] === RESOLVE_DIR_SCRIPT
            ? { exitCode: 1, stdout: '', stderr: 'permission denied\n' }
            : { exitCode: 0, stdout: '/home/guest\n', stderr: '' };

        return Promise.resolve(result);
      },
    });

    const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

    ctx.registry.sessions = [
      buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd }),
    ];

    const removed = await ctx.claims.removeClaimedDir({
      provider,
      id: toSessionID('spawn-1'),
      hostKey: toSessionID('host-1'),
      target: 'imp',
      directory: '/home/guest/work/a',
    });

    expect(removed).toBeFalse();
    expect(provider.commands.map((command) => command.argv[2])).not.toContain(REMOVE_DIR_SCRIPT);
  },
);

test('it keeps a claimed directory on the host when the host home cannot be resolved for a stale relative directory', async () => {
  const provider = buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    runCommand: () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'host unavailable\n' }),
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: 'old-notes' }),
  ];

  const removed = await ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('spawn-1'),
    hostKey: toSessionID('host-1'),
    target: 'imp',
    directory: '/home/guest/work/a',
  });

  expect(removed).toBeFalse();
  expect(provider.commands.map((command) => command.argv[2])).not.toContain(REMOVE_DIR_SCRIPT);
});

test('it keeps a claimed directory on the host when a stale relative directory is a symlink whose target lay inside it', async () => {
  const temporaryDirectory = setupTempDir('atc-host-dir-claims-');
  const home = join(temporaryDirectory.path, 'home');
  const workspace = join(home, 'work', 'a');

  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'keep.txt'), 'kept\n');

  // The link's target was removed inside the guest, so the session listed
  // in it can no longer enter it.
  symlinkSync(join(workspace, 'inner'), join(home, 'alias'));

  const provider = buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    runCommand: async (spec) => {
      const subprocess = Bun.spawn([...spec.argv], {
        cwd: resolve(home, spec.cwd ?? '.'),
        env: { PATH: process.env['PATH'] ?? '', HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);

      return { exitCode, stdout, stderr };
    },
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: 'alias' }),
  ];

  const removed = await ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('spawn-1'),
    hostKey: toSessionID('host-1'),
    target: 'imp',
    directory: workspace,
  });

  expect(removed).toBeFalse();
  expect(readFileSync(join(workspace, 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it keeps a directory on the daemon host that a held session reaches through a symlink', async () => {
  const provider = buildStubLocalProvider();
  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'local', provider })] });
  const temporaryDirectory = setupTempDir('atc-held-claims-');
  const workspace = join(temporaryDirectory.path, 'workspace');
  const alias = join(temporaryDirectory.path, 'alias');

  mkdirSync(join(workspace, 'inner'), { recursive: true });
  writeFileSync(join(workspace, 'keep.txt'), 'kept\n');
  symlinkSync(join(workspace, 'inner'), alias);

  ctx.claims.holdSessions([
    buildMockSession({ id: toSessionID('held-1'), target: 'local', cwd: alias }),
  ]);

  const removed = await ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('forgotten-1'),
    hostKey: toSessionID('forgotten-1'),
    target: 'local',
    directory: workspace,
  });

  expect(removed).toBeFalse();
  expect(readFileSync(join(workspace, 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it removes a directory on the daemon host once the session that reached it is released', async () => {
  const provider = buildStubLocalProvider();
  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'local', provider })] });
  const temporaryDirectory = setupTempDir('atc-held-claims-');
  const workspace = join(temporaryDirectory.path, 'workspace');
  const alias = join(temporaryDirectory.path, 'alias');

  mkdirSync(join(workspace, 'inner'), { recursive: true });
  symlinkSync(join(workspace, 'inner'), alias);

  const held = buildMockSession({ id: toSessionID('held-1'), target: 'local', cwd: alias });

  ctx.claims.holdSessions([held]);
  ctx.claims.releaseSessions([held]);

  const removed = await ctx.claims.removeClaimedDir({
    provider,
    id: toSessionID('forgotten-1'),
    hostKey: toSessionID('forgotten-1'),
    target: 'local',
    directory: workspace,
  });

  expect(removed).toBeTrue();
});
