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
  { path: 'packages/app/src/events/run-events.ts', features: ['events-stream'] },
  { path: 'packages/app/src/send/run-send.ts', features: ['cli-send'] },
  { path: 'packages/app/src/message-get/run-message-get.ts', features: ['cli-send'] },
  { path: 'packages/app/src/gateway/run-gateway.ts', features: ['gateway-routing'] },
  { path: 'packages/gateway/src/index.ts', features: ['gateway-routing'] },
  { path: 'packages/execution/docker/src/index.ts', features: ['docker-target'] },
  {
    path: 'packages/app/src/tui/create-tui-host.ts',
    features: ['spawn-session', 'session-list-leader', 'kill-forget'],
  },
  {
    path: 'packages/app/src/mcp/run-mcp-http-server.ts',
    features: ['remote-mcp-http', 'gateway-routing'],
  },
  {
    path: 'packages/fleet-api/src/index.ts',
    features: ['mcp-fleet-tools', 'session-messages', 'remote-mcp-http', 'gateway-routing'],
  },
])('it flags only $features for a change to $path', async (row) => {
  const ctx = await setupTest();

  expect(ctx.collectFlagged(row.path)).toStrictEqual([...row.features]);
});

test.each([
  'packages/app/src/cli.ts',
  'packages/app/src/cli/run-atc-cli.ts',
  'packages/app/src/send/parse-send-args.ts',
  'packages/app/src/daemon/run-daemon.ts',
  'packages/app/src/plugins/shipped-harness-plugins.ts',
  'packages/app/src/remote-daemon/boot-remote-daemon-client.ts',
  'packages/daemon/src/start-daemon.ts',
  'packages/protocol/src/index.ts',
  'packages/contract/src/index.ts',
  'packages/harnesses/claude/src/index.ts',
  'packages/harnesses/grok/src/index.ts',
  'packages/execution/local/src/index.ts',
  'packages/sources/github/src/index.ts',
  'packages/reporters/src/index.ts',
])('it flags every feature for a change to the core file %s', async (path) => {
  const ctx = await setupTest();

  expect(ctx.collectFlagged(path)).toStrictEqual(ctx.featureNames);
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
