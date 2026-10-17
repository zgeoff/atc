import { hostname } from 'node:os';
import type { InvalidGitTransports, TargetConfigError } from '@atc/config';
import type { AgentID } from '@atc/core';
import type { SourceProvider } from '@atc/plugin-api';
import type { StateStore } from '@atc/store';
import type { TargetAccess } from '../auth/target-access';
import type { DaemonContext } from '../daemon-context';
import { buildConfigRevision } from '../fleet/build-config-revision';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildTargetList } from '../fleet/build-target-list';
import { buildAgentList } from '../sessions/build-agent-list';
import type { SessionManager } from '../sessions/sessions';
import { checkRepositoryAccess } from '../workspace/check-repository-access';
import { requireGitTransports } from '../workspace/require-git-transports';

interface SpawnCatalogDeps {
  readonly mgr: Pick<SessionManager, 'collectAdapters'>;
  readonly store: Pick<StateStore, 'collectSpawnDirs'>;

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

type AgentList = ReturnType<DaemonContext['collectAgents']>;

export class SpawnCatalog {
  private readonly mgr: SpawnCatalogDeps['mgr'];

  private readonly store: SpawnCatalogDeps['store'];

  private readonly build: string;

  private readonly targets: readonly ExecutionTarget[];

  private readonly defaultTarget: string | null;

  private readonly targetErrors: readonly TargetConfigError[];

  private readonly defaultAgent: AgentID;

  private readonly sources: readonly SourceProvider[];

  private readonly gitTransports: SpawnCatalogDeps['gitTransports'];

  // A digest of the target config, which changes with any target or error.
  private readonly configRevision: string;

  constructor(deps: SpawnCatalogDeps) {
    this.mgr = deps.mgr;
    this.store = deps.store;
    this.build = deps.build;
    this.targets = deps.targets;
    this.defaultTarget = deps.defaultTarget;
    this.targetErrors = deps.targetErrors;
    this.defaultAgent = deps.defaultAgent ?? 'claude';
    this.sources = deps.sources;
    this.gitTransports = deps.gitTransports;
    this.configRevision = buildConfigRevision(deps.targets, deps.defaultTarget, deps.targetErrors);
  }

  // An agent counts as installed when its binary is on the daemon's PATH.
  collectAgents(): AgentList {
    return {
      daemon: {
        hostname: hostname(),
        platform: process.platform,
        arch: process.arch,
        build: this.build,
      },
      agents: buildAgentList(
        this.mgr.collectAdapters(),
        (bin) => Bun.which(bin) !== null,
        this.targets.some((target) => target.provider?.brokerAuth !== undefined),
      ),
      targets: buildTargetList(this.targets, this.defaultTarget),
      spawnDefaults: { agent: this.defaultAgent, target: this.defaultTarget },
      configRevision: this.configRevision,
      targetErrors: this.targetErrors,
      sources: this.sources.map((source) => ({
        id: source.id,
        label: source.label,
        kind: source.kind,
      })),
    };
  }

  // Each directory once, under an access only those spawned on targets it
  // may use.
  async collectSpawnDirs(access: TargetAccess | null): Promise<string[]> {
    const dirs = await this.store.collectSpawnDirs();

    const reached = dirs.filter((dir) => access === null || access.canUse(dir.grant));

    return [...new Set(reached.map((dir) => dir.cwd))];
  }

  findSource(id: string): SourceProvider | null {
    return this.sources.find((source) => source.id === id) ?? null;
  }

  collectAlternateGitURLs(url: string): readonly string[] {
    return [...new Set(this.sources.flatMap((source) => source.findAlternateURLs?.(url) ?? []))];
  }

  // Throws the refusal of every git operation when the config holds an
  // invalid transport list.
  checkRepositoryAccess(
    request: Omit<Parameters<typeof checkRepositoryAccess>[0], 'transports'>,
  ): ReturnType<typeof checkRepositoryAccess> {
    return checkRepositoryAccess({
      ...request,
      transports: requireGitTransports(this.gitTransports),
    });
  }
}
