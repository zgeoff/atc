import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { InvalidGitTransports } from '@atc/config';
import { resolveHomeDir } from '@atc/config/host';
import type { AgentID, Clock, SessionID } from '@atc/core';
import { expandHome } from '@atc/core';
import type { DaemonAnswer, SessionDescriptor, SpawnWorkspaceSource } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { StateStore } from '@atc/store';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { TargetAccess } from '../auth/target-access';
import type { SpawnParams } from '../daemon-context';
import type { IdempotencyLedger, KeyedRequest } from '../transport/idempotency-ledger';
import { buildDefaultWorkspaceDir } from '../workspace/build-default-workspace-dir';
import { materializeWorkspace } from '../workspace/materialize-workspace';
import { readHostGitIdentity } from '../workspace/read-host-git-identity';
import { mintSessionID } from './mint-session-id';
import { requirePluginDirsOnTarget } from './require-plugin-dirs-on-target';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';
import type { SpawnHostAccess, SpawnMaterializer } from './spawn-materializer';
import { SpawnReplay } from './spawn-replay';

interface SpawnServiceDeps {
  readonly mgr: Pick<
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
  private readonly mgr: SpawnServiceDeps['mgr'];

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
    this.mgr = deps.mgr;
    this.store = deps.store;
    this.clock = deps.clock;
    this.ledger = deps.ledger;
    this.findRuntime = deps.findRuntime;
    this.gitTransports = deps.gitTransports;
    this.defaultTarget = deps.defaultTarget;
    this.workspaceRoots = deps.workspaceRoots;
    this.homeDir = deps.homeDir;

    this.replay = new SpawnReplay({ mgr: deps.mgr, store: deps.store });
  }

  spawnSession(
    plan: () => SpawnParams,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
  ): Promise<DaemonAnswer<'session.spawn'>> {
    const startInReach = (p: SpawnParams, id: SessionID) =>
      this.startSpawn(p, id, () => {
        if (
          access !== null &&
          p.parent !== null &&
          !isTreeInReach(this.mgr.sessions, p.parent, access)
        ) {
          throw new DaemonError('no_such_session', `no session '${p.parent}'`);
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
      settle: () => this.mgr.writeFleet(),
      replay: (record) => this.replay.loadReplay(record, access),
      findEffectTarget: () => {
        const s = this.mgr.sessions.find((x) => x.id === effectRef);

        return s === undefined ? null : { target: s.target, targetIdentity: s.targetIdentity };
      },
    });
  }

  // The session a spawn under the given session lands under: that session,
  // or its own parent for a sub-session, so a set stays one level deep.
  resolveSpawnParent(id: SessionID): SessionID | 'missing' {
    const owner = this.mgr.sessions.find((x) => x.id === id);

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
    const refusal = this.mgr.findExecutionRefusal({ target, targetIdentity: null }, 'spawn');

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
    this.mgr.requireExecution({ target, targetIdentity: null }, 'transfer');
    this.mgr.requireExecution({ target, targetIdentity: null }, 'run');
  }

  buildDefaultWorkspaceDir(
    target: string,
    source: Extract<SpawnWorkspaceSource, { kind: 'git' }>,
  ): string {
    return buildDefaultWorkspaceDir(source, {
      root: this.workspaceRoots?.targetRoots.get(target) ?? this.workspaceRoots?.root ?? null,
      remote: this.mgr.requireExecution({ target, targetIdentity: null }, 'run').provider.remote,
      home: this.homeDir ?? resolveHomeDir(),
    });
  }

  requireAgentTarget(agent: AgentID, target: string): void {
    this.mgr.requireAgentTarget(agent, target);
  }

  // A folder named twice, such as with and without a trailing slash, reaches
  // the agent once, so each path is returned in its normal form.
  requirePluginDirs(
    target: string,
    configured: readonly string[],
    requested: readonly string[],
  ): string[] {
    const home = this.homeDir ?? resolveHomeDir();
    const expanded = requested.map((dir) => resolve(expandHome(dir, home)));
    const dirs = [...configured, ...expanded];

    if (dirs.length > 0) {
      const provider = this.mgr.requireExecution(
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
    p: SpawnParams,
    id: SessionID,
    requireInReach: () => void,
  ): Promise<DaemonAnswer<'session.spawn'>> {
    const source = p.workspace;
    let warnings: readonly string[] = [];

    const materialize: SpawnMaterializer | null =
      source === null
        ? null
        : async (host, targetIdentity) => {
            const prepared = await this.materializeSpawnWorkspace(
              p,
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

    const session = await this.startSpawnedSession(p, id, materialize, requireInReach);

    return warnings.length === 0 ? { session } : { session, warnings };
  }

  // Materializes a spawn's workspace on the host its spawn readies once the
  // source resolves, under the target identity the spawn bound, and every
  // provider call passes the execution gate against that binding.
  private async materializeSpawnWorkspace(
    p: SpawnParams,
    id: SessionID,
    source: SpawnWorkspaceSource,
    host: SpawnHostAccess,
    targetIdentity: string,
  ) {
    const binding = { target: p.target, targetIdentity };
    const bound = this.mgr.requireExecution(binding, 'run');

    return materializeWorkspace(
      {
        sessionID: id,
        target: p.target,
        dir: p.cwd,
        source,
        inPlace: bound.provider.kind === 'local-pty',
        autoDir: p.autoDir,
      },
      {
        requireProvider: (capability) => this.mgr.requireExecution(binding, capability).provider,
        store: this.store,
        log: (line) => {
          this.mgr.log(line);
        },
        readyHost: host.readyHost,
        removeClaim: host.removeClaim,
        stagingRoot: tmpdir(),
        timer: host.timer,
        gitTransports: this.gitTransports,
        clock: this.clock,

        // An imp fetches from the repository host over its own network,
        // so its workspace never crosses the daemon's link.
        cloneOnTarget: bound.provider.kind === 'imp',

        // An imp image holds no git identity, so its checkout takes the
        // daemon host's; a local target reads the user's own config.
        ...(bound.provider.kind === 'imp' ? { gitIdentity: await readHostGitIdentity() } : {}),
      },
    );
  }

  // the answer is built as the spawn's last step, so a failure there takes
  // the spawn back like any other step's
  private async startSpawnedSession(
    p: SpawnParams,
    id: SessionID,
    materialize: SpawnMaterializer | null,
    requireInReach: () => void,
  ): Promise<SessionDescriptor> {
    const answered: { descriptor: SessionDescriptor | null } = { descriptor: null };

    await this.mgr.spawn(
      p.cwd,
      p.name,
      p.prompt,
      p.cols,
      p.rows,
      p.resume,
      p.namedBy,
      p.agent,
      p.parent,
      p.overrides,
      id,
      p.target,
      materialize,
      requireInReach,
      p.autoDir,
      p.scope,
      (s) => {
        const runtime = this.findRuntime(s.id);

        if (runtime !== undefined) {
          runtime.pendingLastUsed = true;
        }

        void this.store.recordSpawnDir(
          s.cwd,
          { target: s.target, targetIdentity: s.targetIdentity },
          this.clock.now(),
        );

        answered.descriptor = this.getDescriptor(s.id);
      },
    );

    if (answered.descriptor === null) {
      throw new Error(`the spawn of session ${id} returned without its answer`);
    }

    return answered.descriptor;
  }

  private getDescriptor(id: SessionID): SessionDescriptor {
    const d = this.mgr.collectDescriptors().find((x) => x.id === id);

    if (d === undefined) {
      throw new Error(`descriptor for unknown session ${id}`);
    }

    return d;
  }
}
