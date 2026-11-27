import { hostname } from 'node:os';
import type { GitCredentialHosts, InvalidGitTransports, TargetConfigError } from '@atc/config';
import type { SourceProvider } from '@atc/plugin-api';
import { getHostCredentials } from '@atc/plugin-api';
import type { StateStore } from '@atc/store';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { buildConfigRevision } from '../fleet/build-config-revision';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildTargetList } from '../fleet/build-target-list';
import { buildAgentList } from '../sessions/build-agent-list';
import type { SessionManager } from '../sessions/create-session-manager';
import type { DaemonContext, LiveDefaults } from '../types';
import { checkRepositoryAccess } from '../workspace/check-repository-access';
import { requireGitTransports } from '../workspace/require-git-transports';

type AgentList = ReturnType<DaemonContext['collectAgents']>;

export interface SpawnCatalog {
  readonly collectAgents: () => AgentList;

  readonly readSpawnDirs: (access: TargetAccess | null) => Promise<string[]>;

  readonly findSource: (id: string) => SourceProvider | null;

  readonly collectAlternateGitURLs: (url: string) => readonly string[];

  readonly checkRepositoryAccess: (
    request: Omit<Parameters<typeof checkRepositoryAccess>[0], 'transports' | 'gitCredentials'>,
  ) => ReturnType<typeof checkRepositoryAccess>;
}

interface SpawnCatalogDeps {
  readonly manager: Pick<SessionManager, 'collectAdapters'>;
  readonly store: Pick<StateStore, 'readSpawnDirs'>;

  readonly build: string;
  readonly targets: readonly ExecutionTarget[];
  readonly defaults: Readonly<LiveDefaults>;
  readonly targetErrors: readonly TargetConfigError[];

  readonly sources: readonly SourceProvider[];
  readonly gitTransports: readonly string[] | InvalidGitTransports;
  readonly gitCredentials: GitCredentialHosts;
}

export function createSpawnCatalog(deps: SpawnCatalogDeps): SpawnCatalog {
  const manager = deps.manager;
  const store = deps.store;
  const build = deps.build;
  const targets = deps.targets;
  const targetErrors = deps.targetErrors;
  const sources = deps.sources;
  const gitTransports = deps.gitTransports;
  const gitCredentials = deps.gitCredentials;

  return {
    collectAgents: () => {
      const defaultTarget = deps.defaults.defaultTarget;
      const defaultAgent = deps.defaults.defaultAgent ?? 'claude';

      const agents = buildAgentList(
        manager.collectAdapters(),
        (bin) => Bun.which(bin) !== null,
        targets.flatMap((target) =>
          target.provider === null
            ? []
            : [
                {
                  id: target.id,
                  remote: target.provider.remote,
                  credentials: getHostCredentials(target.provider),
                },
              ],
        ),
      );

      return {
        daemon: {
          hostname: hostname(),
          platform: process.platform,
          arch: process.arch,
          build,
        },
        agents,
        targets: buildTargetList(targets, defaultTarget),
        spawnDefaults: { agent: defaultAgent, target: defaultTarget },
        configRevision: buildConfigRevision(targets, defaultTarget, targetErrors, {
          entries: agents,
          defaultAgent,
        }),
        targetErrors,
        sources: sources.map((source) => ({
          id: source.id,
          label: source.label,
          kind: source.kind,
        })),
      };
    },

    readSpawnDirs: async (access) => {
      const dirs = await store.readSpawnDirs();

      const reached = dirs.filter((directory) => access === null || access.canUse(directory.grant));

      return [...new Set(reached.map((directory) => directory.cwd))];
    },

    findSource: (id) => sources.find((source) => source.id === id) ?? null,

    collectAlternateGitURLs: (url) => [
      ...new Set(sources.flatMap((source) => source.findAlternateURLs?.(url) ?? [])),
    ],

    checkRepositoryAccess: (request) =>
      checkRepositoryAccess({
        ...request,
        transports: requireGitTransports(gitTransports),
        gitCredentials,
      }),
  };
}
