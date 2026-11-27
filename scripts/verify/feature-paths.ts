import { join } from 'node:path';
import { collectReachedFolders } from './collect-reached-folders.ts';
import { corePaths } from './core-paths.ts';
import { readWorkspacePackages } from './read-workspace-packages.ts';
import type { WorkspacePackage } from './types.ts';

// Globs are root-relative, as `git ls-files` prints them, and match with Bun.Glob. The local run
// starts `atc mcp --http` and the gateway for every journey, but a change that breaks either at
// start fails the journeys of their own features too, so neither is in the core list.
interface FeatureReach {
  // package folders, such as `packages/tui`, whose workspace dependencies the feature also holds
  readonly packages: readonly string[];
  readonly paths: readonly string[];
}

const workspace = await readWorkspace(join(import.meta.dir, '..', '..'));

const tui: FeatureReach = { packages: ['packages/tui'], paths: ['packages/app/src/tui/**'] };

// `atc mcp` over stdio runs from the package alone
const mcpStdio: FeatureReach = { packages: ['packages/mcp'], paths: [] };

export const featurePaths = {
  'docker-target': buildFeatureGlobs(workspace, {
    packages: ['packages/execution/docker'],
    paths: ['scripts/test-utils/run-docker-daemon.ts'],
  }),

  'spawn-session': buildFeatureGlobs(workspace, tui),
  'session-list-leader': buildFeatureGlobs(workspace, tui),
  'kill-forget': buildFeatureGlobs(workspace, tui),
  'events-stream': buildFeatureGlobs(workspace, {
    packages: [],
    paths: ['packages/app/src/events/**'],
  }),

  'mcp-fleet-tools': buildFeatureGlobs(workspace, mcpStdio),
  'session-messages': buildFeatureGlobs(workspace, mcpStdio),
  'cli-send': buildFeatureGlobs(workspace, {
    packages: [],
    paths: ['packages/app/src/{send,message-get}/**'],
  }),
  'remote-mcp-http': buildFeatureGlobs(workspace, {
    packages: ['packages/mcp'],
    paths: [
      'packages/app/src/{mcp,service-token}/**',

      // the local daemon connection of `atc mcp --http` opens its event channel through this
      'packages/app/src/events/open-watch-channel.ts',
    ],
  }),
  'gateway-routing': buildFeatureGlobs(workspace, {
    packages: ['packages/gateway', 'packages/mcp'],
    paths: ['packages/app/src/gateway.ts', 'packages/app/src/{gateway,auth,mcp,service-token}/**'],
  }),
} as const satisfies Record<string, readonly string[]>;

interface Workspace {
  readonly packages: readonly WorkspacePackage[];
  readonly coreFolders: readonly string[];
  readonly coreGlobs: readonly string[];
}

// Each feature holds the core list, the folders of its packages and of the workspace packages they
// depend on, from each `package.json` as this file loads, and its own paths.
function buildFeatureGlobs(workspaceFacts: Workspace, reach: FeatureReach): string[] {
  const ownFolders = collectReachedFolders(reach.packages, workspaceFacts.packages).filter(
    (folder) => !workspaceFacts.coreFolders.includes(folder),
  );

  return [
    ...workspaceFacts.coreGlobs,
    ...ownFolders.map((folder) => `${folder}/**`),
    ...reach.paths,
  ];
}

async function readWorkspace(rootDir: string): Promise<Workspace> {
  const packages = await readWorkspacePackages(rootDir);

  const coreFolders = collectReachedFolders(corePaths.packages, packages);

  return {
    packages,
    coreFolders,
    coreGlobs: [...coreFolders.map((folder) => `${folder}/**`), ...corePaths.globs],
  };
}

export const sharedPaths = [
  'scripts/verify/**',
  'scripts/test-utils/run-local-daemon.ts',
  'scripts/{with-test-home.sh,create-state-template.ts,remove-stale-test-homes.ts,stop-test-home-processes.ts}',
  'packages/app/src/test-utils/build-stub-tui-claude.ts',
] as const;

export const ignoredPaths = [
  // Never `**/*.md`: a package may read markdown at run time.
  'docs/**',
  'scripts/serve-stub-daemon.ts',
  'scripts/smoke-client.mjs',
  '**/README.md',
  'CHANGELOG.md',
  'AGENTS.md',
  'CLAUDE.md',
  'LICENSE',
  '**/*.test.ts',
  'e2e/**',
  'integration/**',

  // Bun never reads these when it runs the source.
  '**/tsconfig*.json',
  'bunfig.toml',
  'rig.config.ts',
  'knip.json',
  '.oxlintrc*.json',
  '.oxfmtrc.json',
  '.formatignore',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gitleaks.toml',
  '.git-blame-ignore-revs',
  '.coderabbit.yaml',
  'commitlint.config.js',
  'lefthook.yml',
  'audit-ignores.json',
  'bun-test-timings.json',
  'socket.yml',
  'review.json',
  'renovate.json',
  'patches/**',
  '.agents/**',
  '.claude/**',
  '.codex/**',
  '.github/**',
  '.vscode/**',

  'scripts/{build,check,collect,declaration,find,install,load,pack,pick,probe,publish,read,record,restore,run,stage,test,write}-*',
  'scripts/{deadcode.ts,with-e2e-paths.sh,disable-baseline.json}',
  'scripts/verify-gate/**',

  // The README hero builds from these files; no journey runs them.
  'scripts/storyboard/**',
  'scripts/{harmless-input-fields,is-breaking-marked}.ts',
  'scripts/test-utils/build-contract-schemas.ts',

  // A dependency bump merges on green CI, and the verify workflow skips a release pull request.
  '**/package.json',
  'bun.lock',
  '.bun-version',
  '.release-please-manifest.json',
  'release-please-config.json',

  // The journeys run the CLI's source, never the dev shim or an installed binary, and no journey configures an imp or a sprites target.
  'mods/**',
  'bin/atc',
  'install.sh',
  'packages/execution/imp/**',
  'packages/execution/sprites/**',
] as const;
