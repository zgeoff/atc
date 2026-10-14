import { expect, mock, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toSessionID } from '@atc/core/to-session-id';
import { runShellcheck } from '@atc/test-utils/run-shellcheck';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import type { ExecutionTarget } from './build-execution-targets';
import {
  HostDirClaims,
  REMOVE_DIR_SCRIPT,
  RESOLVE_DIR_SCRIPT,
  RESOLVE_HOME_SCRIPT,
  RESOLVE_UNLINKED_DIR_SCRIPT,
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
  ['resolves a host directory without a symlink in its missing parts', RESOLVE_UNLINKED_DIR_SCRIPT],
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

// Stands in for a host whose home is /home/guest and where a relative
// directory cannot be entered, as one removed inside the guest cannot.
function buildStaleRelativeProvider() {
  return buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    runCommand: (spec) => {
      if (spec.argv[2] === RESOLVE_HOME_SCRIPT) {
        return Promise.resolve({ exitCode: 0, stdout: '/home/guest\n', stderr: '' });
      }

      if (spec.cwd !== undefined && !spec.cwd.startsWith('/')) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'no such directory\n' });
      }

      return Promise.resolve({ exitCode: 0, stdout: `${spec.argv[4] ?? ''}\n\0`, stderr: '' });
    },
  });
}

test('it removes a claimed directory on the host when a stale relative directory resolves outside it from the home', async () => {
  const provider = buildStaleRelativeProvider();
  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: 'old-notes' }),
  ];

  const removed = await ctx.claims.removeClaimedDir(
    provider,
    toSessionID('spawn-1'),
    toSessionID('host-1'),
    'imp',
    '/home/guest/work/a',
  );

  expect(removed).toBeTrue();

  expect(provider.commands.at(-1)).toStrictEqual({
    argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', '/home/guest/work/a', '/home/guest/work/a\nx'],
    cwd: '/',
    host: toSessionID('host-1'),
  });
});

test('it keeps a claimed directory on the host when a stale relative directory resolves inside it from the home', async () => {
  const provider = buildStaleRelativeProvider();
  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: 'work/a/inner' }),
  ];

  const removed = await ctx.claims.removeClaimedDir(
    provider,
    toSessionID('spawn-1'),
    toSessionID('host-1'),
    'imp',
    '/home/guest/work/a',
  );

  expect(removed).toBeFalse();
  expect(provider.commands.map((c) => c.argv[2])).not.toContain(REMOVE_DIR_SCRIPT);
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

    const removed = await ctx.claims.removeClaimedDir(
      provider,
      toSessionID('spawn-1'),
      toSessionID('host-1'),
      'imp',
      '/home/guest/work/a',
    );

    expect(removed).toBeFalse();
    expect(provider.commands.map((c) => c.argv[2])).not.toContain(REMOVE_DIR_SCRIPT);
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

  const removed = await ctx.claims.removeClaimedDir(
    provider,
    toSessionID('spawn-1'),
    toSessionID('host-1'),
    'imp',
    '/home/guest/work/a',
  );

  expect(removed).toBeFalse();
  expect(provider.commands.map((c) => c.argv[2])).not.toContain(REMOVE_DIR_SCRIPT);
});

test('it keeps a claimed directory on the host when a stale relative directory is a symlink whose target lay inside it', async () => {
  const tmp = setupTempDir('atc-host-dir-claims-');
  const home = join(tmp.dir, 'home');
  const workspace = join(home, 'work', 'a');

  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'keep.txt'), 'kept\n');

  // The link's target was removed inside the guest, so the session listed
  // in it can no longer enter it.
  symlinkSync(join(workspace, 'inner'), join(home, 'alias'));

  const provider = buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    runCommand: async (spec) => {
      const proc = Bun.spawn([...spec.argv], {
        cwd: resolve(home, spec.cwd ?? '.'),
        env: { PATH: process.env['PATH'] ?? '', HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      return { exitCode, stdout, stderr };
    },
  });

  const ctx = setupTest({ targets: [buildMockExecutionTarget({ id: 'imp', provider })] });

  ctx.registry.sessions = [
    buildMockSession({ hostKey: toSessionID('host-1'), target: 'imp', cwd: 'alias' }),
  ];

  const removed = await ctx.claims.removeClaimedDir(
    provider,
    toSessionID('spawn-1'),
    toSessionID('host-1'),
    'imp',
    workspace,
  );

  expect(removed).toBeFalse();
  expect(readFileSync(join(workspace, 'keep.txt'), 'utf8')).toBe('kept\n');
});
