import { hostname } from 'node:os';
import type { InvalidGitTransports, TargetConfigError } from '@atc/config';
import type { AgentID } from '@atc/core';
import type { SourceProvider } from '@atc/plugin-api';
import type { StateStore } from '@atc/store';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import type { DaemonContext } from '../daemon-context';
import { buildConfigRevision } from '../fleet/build-config-revision';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildTargetList } from '../fleet/build-target-list';
import { buildAgentList } from '../sessions/build-agent-list';
import type { SessionManager } from '../sessions/sessions';
import { checkRepositoryAccess } from '../workspace/check-repository-access';
import { requireGitTransports } from '../workspace/require-git-transports';

type AgentList = ReturnType<DaemonContext['collectAgents']>;

export interface SpawnCatalog {
  // An agent counts as installed when its binary is on the daemon's PATH,
  // which only a target whose provider runs the agent here needs. A target
  // without a provider starts nothing.
  readonly collectAgents: () => AgentList;

  // Each directory once, under an access only those spawned on targets it
  // may use.
  readonly readSpawnDirs: (access: TargetAccess | null) => Promise<string[]>;

  readonly findSource: (id: string) => SourceProvider | null;

  readonly collectAlternateGitURLs: (url: string) => readonly string[];

  // Throws the refusal of every git operation when the config holds an
  // invalid transport list.
  readonly checkRepositoryAccess: (
    request: Omit<Parameters<typeof checkRepositoryAccess>[0], 'transports'>,
  ) => ReturnType<typeof checkRepositoryAccess>;
}

interface SpawnCatalogDeps {
  readonly manager: Pick<SessionManager, 'collectAdapters'>;
  readonly store: Pick<StateStore, 'readSpawnDirs'>;

  // The build string the daemon answers its handshake with.
  readonly build: string;
  readonly targets: readonly ExecutionTarget[];
  readonly defaultTarget: string | null;
  readonly targetErrors: readonly TargetConfigError[];

  // The agent a spawn without one runs; `claude` when absent.
  readonly defaultAgent?: AgentID;

  // The sources the spawn picker offers, in order.
  readonly sources: readonly SourceProvider[];
  readonly gitTransports: readonly string[] | InvalidGitTransports;
}

export function createSpawnCatalog(deps: SpawnCatalogDeps): SpawnCatalog {
  const manager = deps.manager;
  const store = deps.store;
  const build = deps.build;
  const targets = deps.targets;
  const defaultTarget = deps.defaultTarget;
  const targetErrors = deps.targetErrors;
  const defaultAgent = deps.defaultAgent ?? 'claude';
  const sources = deps.sources;
  const gitTransports = deps.gitTransports;

  // A digest of the target config, which changes with any target or error.
  const configRevision = buildConfigRevision(deps.targets, deps.defaultTarget, deps.targetErrors);

  return {
    collectAgents: () => ({
      daemon: {
        hostname: hostname(),
        platform: process.platform,
        arch: process.arch,
        build,
      },
      agents: buildAgentList(
        manager.collectAdapters(),
        (bin) => Bun.which(bin) !== null,
        targets.flatMap((target) =>
          target.provider === null
            ? []
            : [
                {
                  id: target.id,
                  remote: target.provider.remote,
                  brokerAuth: target.provider.brokerAuth !== undefined,
                },
              ],
        ),
      ),
      targets: buildTargetList(targets, defaultTarget),
      spawnDefaults: { agent: defaultAgent, target: defaultTarget },
      configRevision,
      targetErrors,
      sources: sources.map((source) => ({
        id: source.id,
        label: source.label,
        kind: source.kind,
      })),
    }),

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
      }),
  };
}
