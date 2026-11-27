import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { collectFeatureScopes, isGlobMatch } from '@wringer/core';
import { createVerifyRegistry } from './create-verify-registry.ts';
import { readWorkspacePackages } from './read-workspace-packages.ts';

async function setupTest() {
  const rootDir = join(import.meta.dir, '..', '..');
  const registry = createVerifyRegistry();
  const scopes = collectFeatureScopes(registry);

  const trackedText = await Bun.$`git ls-files`.cwd(rootDir).text();

  return {
    rootDir,
    featureNames: registry.features.map((feature) => feature.name),
    trackedPaths: trackedText.trim().split('\n'),
    readPackages: () => readWorkspacePackages(rootDir),
    isIgnored: (path: string) => isGlobMatch(path, registry.ignore),
    collectFlagged: (path: string) =>
      isGlobMatch(path, registry.ignore)
        ? []
        : scopes.filter((scope) => isGlobMatch(path, scope.globs)).map((scope) => scope.name),
  };
}

test.each([
  { path: 'packages/app/src/send/run-send.ts', features: ['cli-send'] },
  { path: 'packages/app/src/message-get/run-message-get.ts', features: ['cli-send'] },
  { path: 'packages/execution/docker/src/index.ts', features: ['docker-target'] },
  {
    path: 'packages/execution/docker/src/test-utils/create-stand-in-image.ts',
    features: ['docker-target'],
  },
  {
    path: 'packages/tui/src/index.ts',
    features: ['spawn-session', 'session-list-leader', 'kill-forget'],
  },
  {
    path: 'packages/app/src/tui/create-tui-host.ts',
    features: ['spawn-session', 'session-list-leader', 'kill-forget'],
  },
])('it flags only $features for a change to $path', async (row) => {
  const ctx = await setupTest();

  expect(ctx.collectFlagged(row.path)).toStrictEqual([...row.features]);
});

test.each([
  'packages/app/src/events/run-events.ts',
  'packages/app/src/events/open-watch-channel.ts',
  'packages/app/src/mcp/run-mcp-http-server.ts',
  'packages/app/src/service-token/load-service-token-file.ts',
  'packages/app/src/gateway.ts',
  'packages/app/src/gateway/run-gateway.ts',
  'packages/app/src/auth/run-clients.ts',
  'packages/gateway/src/registry/load-gateway-registry.ts',
])('it flags every local feature for a change to %s, which each local up starts', async (path) => {
  const ctx = await setupTest();

  expect(ctx.collectFlagged(path)).toStrictEqual([
    'spawn-session',
    'session-list-leader',
    'kill-forget',
    'events-stream',
    'mcp-fleet-tools',
    'session-messages',
    'cli-send',
    'remote-mcp-http',
    'gateway-routing',
  ]);
});

test('it flags every feature for a change to a package file that the verify CLI loads', async () => {
  const ctx = await setupTest();

  const built = await Bun.build({
    entrypoints: [join(ctx.rootDir, 'scripts', 'verify', 'verify.ts')],
    target: 'bun',
    metafile: true,
  });

  const loaded = Object.keys(built.metafile?.inputs ?? {}).filter((path) =>
    path.startsWith('packages/'),
  );

  expect(
    loaded.filter((path) => ctx.collectFlagged(path).length < ctx.featureNames.length),
  ).toStrictEqual([]);
});

test('it reaches every workspace package folder from a feature', async () => {
  const ctx = await setupTest();
  const packages = await ctx.readPackages();

  const unreached = packages
    .map((entry) => entry.folder)
    .filter((folder) => {
      const runPaths = ctx.trackedPaths.filter(
        (path) => path.startsWith(`${folder}/`) && !ctx.isIgnored(path),
      );

      return runPaths.length > 0 && runPaths.every((path) => ctx.collectFlagged(path).length === 0);
    });

  expect(unreached).toStrictEqual([]);
});

test('it maps every tracked file to a feature or the ignore list', async () => {
  const ctx = await setupTest();

  expect(
    ctx.trackedPaths.filter(
      (path) => !ctx.isIgnored(path) && ctx.collectFlagged(path).length === 0,
    ),
  ).toStrictEqual([]);
});
