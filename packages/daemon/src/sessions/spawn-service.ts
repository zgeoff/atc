import { tmpdir } from 'node:os';
import type { InvalidGitTransports } from '@atc/config';
import { resolveHomeDir } from '@atc/config/host';
import type { AgentID, Clock, SessionID } from '@atc/core';
import { normalizePluginDir } from '@atc/plugin-api';
import type { DaemonAnswer, SessionDescriptor, SpawnWorkspaceSource } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { StateStore } from '@atc/store';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { SpawnParams } from '../daemon-context';
import type { IdempotencyLedger, KeyedRequest } from '../transport/create-idempotency-ledger';
import { buildDefaultWorkspaceDir } from '../workspace/build-default-workspace-dir';
import { materializeWorkspace } from '../workspace/materialize-workspace';
import { readHostGitIdentity } from '../workspace/read-host-git-identity';
import type { SessionRuntime } from './create-session-runtime';
import { mintSessionID } from './mint-session-id';
import { requirePluginDirsOnTarget } from './require-plugin-dirs-on-target';
import type { SessionManager } from './sessions';
import type { SpawnHostAccess, SpawnMaterializer } from './spawn-materializer';
import { SpawnReplay } from './spawn-replay';

interface SpawnServiceDeps {
  readonly manager: Pick<
    SessionManager,
    | 'sessions'
    | 'collectDescriptors'
    | 'spawn'
    | 'writeFleet'
    | 'requireExecution'
    | 'findExecutionRefusal'
    | 'requireAgentTarget'
    | 'log'
  >;
  readonly store: Pick<StateStore, 'loadFleet' | 'recordSpawnDir'> &
    Parameters<typeof materializeWorkspace>[1]['store'];
  readonly clock: Clock;
  readonly ledger: Pick<IdempotencyLedger, 'run'>;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  // The transports a git workspace source may use, or the invalid list the
  // config holds, which refuses every git operation.
  readonly gitTransports: readonly string[] | InvalidGitTransports;

  // The target a spawn without one runs on, or null when the config gives
  // none, which refuses such a spawn.
  readonly defaultTarget: string | null;

  // The root a git workspace without a directory lands under on any target
  // without its own, and each target's own root, by target id; the default
  // root under the target user's home when absent.
  readonly workspaceRoots?: Readonly<{
    root: string | null;
    targetRoots: ReadonlyMap<string, string>;
  }>;

  // The home a git workspace without a directory lands under on a target on
  // the daemon's own machine when no root applies, and the one a plugin
  // folder starting with ~ is under; the daemon user's home when absent.
  readonly homeDir?: string;
}

export class SpawnService {
  private readonly manager: SpawnServiceDeps['manager'];

  private readonly store: SpawnServiceDeps['store'];

  private readonly clock: Clock;

  private readonly ledger: SpawnServiceDeps['ledger'];

  private readonly findRuntime: SpawnServiceDeps['findRuntime'];

  private readonly gitTransports: SpawnServiceDeps['gitTransports'];

  private readonly defaultTarget: string | null;

  private readonly workspaceRoots: SpawnServiceDeps['workspaceRoots'];

  private readonly homeDir: string | undefined;

  private readonly replay: SpawnReplay;

  constructor(deps: SpawnServiceDeps) {
    this.manager = deps.manager;
    this.store = deps.store;
    this.clock = deps.clock;
    this.ledger = deps.ledger;
    this.findRuntime = deps.findRuntime;
    this.gitTransports = deps.gitTransports;
    this.defaultTarget = deps.defaultTarget;
    this.workspaceRoots = deps.workspaceRoots;
    this.homeDir = deps.homeDir;

    this.replay = new SpawnReplay({ manager: deps.manager, store: deps.store });
  }

  spawnSession(
    plan: () => SpawnParams,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
  ): Promise<DaemonAnswer<'session.spawn'>> {
    const startInReach = (params: SpawnParams, id: SessionID) =>
      this.startSpawn(params, id, () => {
        if (
          access !== null &&
          params.parent !== null &&
          !isTreeInReach(this.manager.sessions, params.parent, access)
        ) {
          throw new DaemonError('no_such_session', `no session '${params.parent}'`);
        }
      });

    if (keyed === null) {
      return startInReach(plan(), mintSessionID());
    }

    const effectRef = mintSessionID();

    return this.ledger.run({
      operation: 'session.spawn',
      keyed,
      effectRef,
      start: () => startInReach(plan(), effectRef),
      settle: () => this.manager.writeFleet(),
      replay: (record) => this.replay.loadReplay(record, access),
      findEffectTarget: () => {
        const session = this.manager.sessions.find((x) => x.id === effectRef);

        return session === undefined
          ? null
          : { target: session.target, targetIdentity: session.targetIdentity };
      },
    });
  }

  // The session a spawn under the given session lands under: that session,
  // or its own parent for a sub-session, so a set stays one level deep.
  resolveSpawnParent(id: SessionID): SessionID | 'missing' {
    const owner = this.manager.sessions.find((x) => x.id === id);

    if (owner === undefined) {
      return 'missing';
    }

    return owner.parent ?? owner.id;
  }

  // The target a spawn runs on: the one it names, else the default. Throws
  // the refusal for a target the spawn cannot run on, and for a spawn
  // without a target when the config gives no default.
  resolveSpawnTarget(requested: string | undefined): string {
    const target = requested ?? this.defaultTarget;
    const refusal = this.manager.findExecutionRefusal({ target, targetIdentity: null }, 'spawn');

    if (refusal !== null) {
      throw refusal;
    }

    if (target === null) {
      throw new Error('a spawn without a target passed its checks');
    }

    return target;
  }

  // Throws the refusal for a target that cannot both transfer an archive
  // and run a command.
  requireWorkspaceTarget(target: string): void {
    this.manager.requireExecution({ target, targetIdentity: null }, 'transfer');
    this.manager.requireExecution({ target, targetIdentity: null }, 'run');
  }

  buildDefaultWorkspaceDir(
    target: string,
    source: Extract<SpawnWorkspaceSource, { kind: 'git' }>,
  ): string {
    return buildDefaultWorkspaceDir(source, {
      root: this.workspaceRoots?.targetRoots.get(target) ?? this.workspaceRoots?.root ?? null,
      remote: this.manager.requireExecution({ target, targetIdentity: null }, 'run').provider
        .remote,
      home: this.homeDir ?? resolveHomeDir(),
    });
  }

  requireAgentTarget(agent: AgentID, target: string): void {
    this.manager.requireAgentTarget(agent, target);
  }

  // returns the requested folders in their normal form, which the session
  // keeps for every later launch
  requirePluginDirs(
    target: string,
    configured: readonly string[],
    requested: readonly string[],
  ): string[] {
    const home = this.homeDir ?? resolveHomeDir();
    const expanded = requested.map((directory) => normalizePluginDir(directory, home));
    const dirs = [...configured, ...expanded];

    if (dirs.length > 0) {
      const provider = this.manager.requireExecution(
        { target, targetIdentity: null },
        'spawn',
      ).provider;

      requirePluginDirsOnTarget(dirs, target, provider.remote);
    }

    return expanded;
  }

  // A spawn that fails unwinds its own steps before it throws, so a failed
  // start leaves nothing running and a keyed retry spawns once. When an
  // undo fails too, the session may still stand, and the throw says so.
  private async startSpawn(
    params: SpawnParams,
    id: SessionID,
    requireInReach: () => void,
  ): Promise<DaemonAnswer<'session.spawn'>> {
    const source = params.workspace;
    let warnings: readonly string[] = [];

    const materialize: SpawnMaterializer | null =
      source === null
        ? null
        : async (host, targetIdentity) => {
            const prepared = await this.materializeSpawnWorkspace(
              params,
              id,
              source,
              host,
              targetIdentity,
            );

            if (prepared.kind !== 'ready') {
              return null;
            }

            warnings = prepared.warnings;

            return prepared;
          };

    const session = await this.startSpawnedSession(params, id, materialize, requireInReach);

    return warnings.length === 0 ? { session } : { session, warnings };
  }

  // Materializes a spawn's workspace on the host its spawn readies once the
  // source resolves, under the target identity the spawn bound, and every
  // provider call passes the execution gate against that binding.
  private async materializeSpawnWorkspace(
    params: SpawnParams,
    id: SessionID,
    source: SpawnWorkspaceSource,
    host: SpawnHostAccess,
    targetIdentity: string,
  ) {
    const binding = { target: params.target, targetIdentity };
    const bound = this.manager.requireExecution(binding, 'run');

    return materializeWorkspace(
      {
        sessionID: id,
        target: params.target,
        directory: params.cwd,
        source,
        inPlace: bound.provider.kind === 'local-pty',
        autoDir: params.autoDir,
      },
      {
        requireProvider: (capability) =>
          this.manager.requireExecution(binding, capability).provider,
        store: this.store,
        log: (line) => {
          this.manager.log(line);
        },
        readyHost: host.readyHost,
        removeClaim: host.removeClaim,
        stagingRoot: tmpdir(),
        timer: host.timer,
        gitTransports: this.gitTransports,
        clock: this.clock,

        cloneOnTarget: bound.provider.cloneOnTarget === true,
        ...(bound.provider.hostGitIdentity === true
          ? { gitIdentity: await readHostGitIdentity() }
          : {}),
      },
    );
  }

  // the answer is built as the spawn's last step, so a failure there takes
  // the spawn back like any other step's
  private async startSpawnedSession(
    params: SpawnParams,
    id: SessionID,
    materialize: SpawnMaterializer | null,
    requireInReach: () => void,
  ): Promise<SessionDescriptor> {
    const answered: { descriptor: SessionDescriptor | null } = { descriptor: null };

    await this.manager.spawn(
      params.cwd,
      params.name,
      params.prompt,
      params.cols,
      params.rows,
      params.resume,
      params.namedBy,
      params.agent,
      params.parent,
      params.overrides,
      id,
      params.target,
      materialize,
      requireInReach,
      params.autoDir,
      params.scope,
      (session) => {
        const runtime = this.findRuntime(session.id);

        if (runtime !== undefined) {
          runtime.pendingLastUsed = true;
        }

        void this.store.recordSpawnDir(
          session.cwd,
          { target: session.target, targetIdentity: session.targetIdentity },
          this.clock.now(),
        );

        answered.descriptor = this.getDescriptor(session.id);
      },
    );

    if (answered.descriptor === null) {
      throw new Error(`the spawn of session ${id} returned without its answer`);
    }

    return answered.descriptor;
  }

  private getDescriptor(id: SessionID): SessionDescriptor {
    const descriptor = this.manager.collectDescriptors().find((x) => x.id === id);

    if (descriptor === undefined) {
      throw new Error(`descriptor for unknown session ${id}`);
    }

    return descriptor;
  }
}
