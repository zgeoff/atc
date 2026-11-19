import { tmpdir } from 'node:os';
import type { InvalidGitTransports } from '@atc/config';
import type { AgentID, Clock } from '@atc/core';
import { normalizePluginDir } from '@atc/plugin-api';
import type { DaemonAnswer } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { StateStore } from '@atc/store';
import type { SessionDescriptor, SessionID, SpawnWorkspaceSource } from '@atcx/contract';
import { resolveHomeDir } from '@atcx/contract/light';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { IdempotencyLedger, KeyedRequest } from '../transport/create-idempotency-ledger';
import type { SpawnParams } from '../types';
import { buildDefaultWorkspaceDir } from '../workspace/build-default-workspace-dir';
import { materializeWorkspace } from '../workspace/materialize-workspace';
import { readHostGitIdentity } from '../workspace/read-host-git-identity';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';
import { createSpawnReplay } from './create-spawn-replay';
import { mintSessionID } from './mint-session-id';
import { requirePluginDirsOnTarget } from './require-plugin-dirs-on-target';
import type { SpawnHostAccess, SpawnMaterializer } from './spawn-materializer';

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

  readonly gitTransports: readonly string[] | InvalidGitTransports;

  readonly defaultTarget: string | null;

  readonly workspaceRoots?: Readonly<{
    root: string | null;
    targetRoots: ReadonlyMap<string, string>;
  }>;

  readonly homeDir?: string;
}

export interface SpawnService {
  readonly spawnSession: (
    plan: () => SpawnParams,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
  ) => Promise<DaemonAnswer<'session.spawn'>>;

  readonly resolveSpawnParent: (id: SessionID) => SessionID | 'missing';

  readonly resolveSpawnTarget: (requested: string | undefined) => string;

  readonly requireWorkspaceTarget: (target: string) => void;

  readonly buildDefaultWorkspaceDir: (
    target: string,
    source: Extract<SpawnWorkspaceSource, { kind: 'git' }>,
  ) => string;

  readonly requireAgentTarget: (agent: AgentID, target: string) => void;

  readonly requirePluginDirs: (
    target: string,
    configured: readonly string[],
    requested: readonly string[],
  ) => string[];
}

interface MaterializeSpawnWorkspaceOptions {
  readonly params: SpawnParams;
  readonly id: SessionID;
  readonly source: SpawnWorkspaceSource;
  readonly host: SpawnHostAccess;
  readonly targetIdentity: string;
}

export function createSpawnService(deps: SpawnServiceDeps): SpawnService {
  const manager = deps.manager;
  const store = deps.store;
  const clock = deps.clock;
  const ledger = deps.ledger;
  const findRuntime = deps.findRuntime;
  const gitTransports = deps.gitTransports;
  const defaultTarget = deps.defaultTarget;
  const workspaceRoots = deps.workspaceRoots;
  const homeDir = deps.homeDir;
  const replay = createSpawnReplay({ manager: deps.manager, store: deps.store });

  const materializeSpawnWorkspace = async (options: MaterializeSpawnWorkspaceOptions) => {
    const binding = { target: options.params.target, targetIdentity: options.targetIdentity };
    const bound = manager.requireExecution(binding, 'run');

    return materializeWorkspace(
      {
        sessionID: options.id,
        target: options.params.target,
        directory: options.params.cwd,
        source: options.source,
        inPlace: bound.provider.kind === 'local-pty',
        autoDir: options.params.autoDir,
      },
      {
        requireProvider: (capability) => manager.requireExecution(binding, capability).provider,
        store,
        log: (line) => {
          manager.log(line);
        },
        readyHost: options.host.readyHost,
        removeClaim: options.host.removeClaim,
        stagingRoot: tmpdir(),
        timer: options.host.timer,
        gitTransports,
        clock,

        cloneOnTarget: bound.provider.cloneOnTarget === true,
        ...(bound.provider.hostGitIdentity === true
          ? { gitIdentity: await readHostGitIdentity() }
          : {}),
      },
    );
  };

  const getDescriptor = (id: SessionID): SessionDescriptor => {
    const descriptor = manager.collectDescriptors().find((x) => x.id === id);

    if (descriptor === undefined) {
      throw new Error(`descriptor for unknown session ${id}`);
    }

    return descriptor;
  };

  const startSpawnedSession = async (
    params: SpawnParams,
    id: SessionID,
    materialize: SpawnMaterializer | null,
    requireInReach: () => void,
  ): Promise<SessionDescriptor> => {
    const answered: { descriptor: SessionDescriptor | null } = { descriptor: null };

    await manager.spawn({
      cwd: params.cwd,
      name: params.name,
      prompt: params.prompt,
      cols: params.cols,
      rows: params.rows,
      resume: params.resume,
      namedBy: params.namedBy,
      agent: params.agent,
      parent: params.parent,
      spawner: params.spawner,
      atcAccess: params.atcAccess,
      overrides: params.overrides,
      id,
      target: params.target,
      materialize,
      requireInReach,
      autoDir: params.autoDir,
      scope: params.scope,
      answer: (session) => {
        const runtime = findRuntime(session.id);

        if (runtime !== undefined) {
          runtime.pendingLastUsed = true;
        }

        void store.recordSpawnDir(
          session.cwd,
          { target: session.target, targetIdentity: session.targetIdentity },
          clock.now(),
        );

        answered.descriptor = getDescriptor(session.id);
      },
    });

    if (answered.descriptor === null) {
      throw new Error(`the spawn of session ${id} returned without its answer`);
    }

    return answered.descriptor;
  };

  const startSpawn = async (
    params: SpawnParams,
    id: SessionID,
    requireInReach: () => void,
  ): Promise<DaemonAnswer<'session.spawn'>> => {
    const source = params.workspace;
    let warnings: readonly string[] = [];

    const materialize: SpawnMaterializer | null =
      source === null
        ? null
        : async (host, targetIdentity) => {
            const prepared = await materializeSpawnWorkspace({
              params,
              id,
              source,
              host,
              targetIdentity,
            });

            if (prepared.kind !== 'ready') {
              return null;
            }

            warnings = prepared.warnings;

            return prepared;
          };

    const session = await startSpawnedSession(params, id, materialize, requireInReach);

    return warnings.length === 0 ? { session } : { session, warnings };
  };

  return {
    spawnSession: (plan, keyed, access) => {
      const startInReach = (params: SpawnParams, id: SessionID) =>
        startSpawn(params, id, () => {
          if (
            access !== null &&
            params.parent !== null &&
            !isTreeInReach(manager.sessions, params.parent, access)
          ) {
            throw new DaemonError('no_such_session', `no session '${params.parent}'`);
          }
        });

      if (keyed === null) {
        return startInReach(plan(), mintSessionID());
      }

      const effectRef = mintSessionID();

      return ledger.run({
        operation: 'session.spawn',
        keyed,
        effectRef,
        start: () => startInReach(plan(), effectRef),
        settle: () => manager.writeFleet(),
        replay: (record) => replay.loadReplay(record, access),
        findEffectTarget: () => {
          const session = manager.sessions.find((x) => x.id === effectRef);

          return session === undefined
            ? null
            : { target: session.target, targetIdentity: session.targetIdentity };
        },
      });
    },

    resolveSpawnParent: (id) => {
      const owner = manager.sessions.find((x) => x.id === id);

      if (owner === undefined) {
        return 'missing';
      }

      return owner.parent ?? owner.id;
    },

    resolveSpawnTarget: (requested) => {
      const target = requested ?? defaultTarget;
      const refusal = manager.findExecutionRefusal({ target, targetIdentity: null }, 'spawn');

      if (refusal !== null) {
        throw refusal;
      }

      if (target === null) {
        throw new Error('a spawn without a target passed its checks');
      }

      return target;
    },

    requireWorkspaceTarget: (target) => {
      manager.requireExecution({ target, targetIdentity: null }, 'transfer');
      manager.requireExecution({ target, targetIdentity: null }, 'run');
    },

    buildDefaultWorkspaceDir: (target, source) =>
      buildDefaultWorkspaceDir(source, {
        root: workspaceRoots?.targetRoots.get(target) ?? workspaceRoots?.root ?? null,
        remote: manager.requireExecution({ target, targetIdentity: null }, 'run').provider.remote,
        home: homeDir ?? resolveHomeDir(),
      }),

    requireAgentTarget: (agent, target) => {
      manager.requireAgentTarget(agent, target);
    },

    requirePluginDirs: (target, configured, requested) => {
      const home = homeDir ?? resolveHomeDir();
      const expanded = requested.map((directory) => normalizePluginDir(directory, home));
      const dirs = [...configured, ...expanded];

      if (dirs.length > 0) {
        const provider = manager.requireExecution(
          { target, targetIdentity: null },
          'spawn',
        ).provider;

        requirePluginDirsOnTarget(dirs, target, provider.remote);
      }

      return expanded;
    },
  };
}
