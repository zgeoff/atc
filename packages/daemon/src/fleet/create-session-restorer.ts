import { LOCAL_TARGET } from '@atc/config';
import type { FleetEntry } from '@atc/store';
import type { SessionID, SessionLifecycle } from '@atcx/contract';
import type { ErrorCode } from '@atcx/contract/light';
import { LOCAL_TARGET_IDENTITY } from '../sessions/create-session-registry';
import type { SessionRegistry } from '../sessions/create-session-registry';
import { resolveRepoRoot } from '../sessions/resolve-repo-root';
import type { Session } from '../sessions/session';
import type { SessionCallbacks } from '../sessions/session-callbacks';
import type { SessionFleetWriter } from './create-session-fleet-writer';
import { isUnconfirmedBinding } from './is-unconfirmed-binding';
import { resolveRestoredTargetIdentity } from './resolve-restored-target-identity';

// a restored session lists without a terminal, so the fleet lists before any harness starts
export interface SessionRestorer {
  // Checks the configured target before resolving an unversioned binding
  // against an existing host. Invalid config never reaches the provider.
  readonly resolveRestoredEntry: (entry: FleetEntry) => Promise<FleetEntry>;

  // Registers a fleet entry without a terminal, so the fleet lists before
  // adoption. Exited entries stay exited until revived by hand.
  readonly restore: (entry: FleetEntry) => Session;

  // Whether a restore registered the session and neither a terminal nor a
  // headless turn has started for it since.
  readonly isUnrestored: (id: SessionID) => boolean;

  // Counts the session as a live headless session from now on, so a later
  // restore never starts a terminal beside the headless turn it runs.
  readonly removeUnrestoredMark: (id: SessionID) => void;

  // Lists why a restore could not start a session's terminal, in place of
  // the wait it listed before, with the refusal's code when no later try
  // lifts it.
  readonly updateRestoreRefusal: (session: Session, reason: string, code: string | null) => void;

  // Publishes a checked binding and clears the refusal from its earlier
  // restore before a terminal adoption can fail for a different reason.
  readonly updateRestoredIdentity: (session: Session, identity: string) => void;
}

interface SessionRestorerDeps {
  readonly registry: Pick<
    SessionRegistry,
    | 'sessions'
    | 'targets'
    | 'unrestored'
    | 'findAdapter'
    | 'findExecutionRefusal'
    | 'hasHostLifecycle'
  >;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'writeStatus'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent' | 'getClock'>;
}

export function createSessionRestorer(deps: SessionRestorerDeps): SessionRestorer {
  const registry = deps.registry;
  const fleet = deps.fleet;
  const callbacks = deps.callbacks;

  // An exited row never runs again until revived, and a row on a remote
  // target holds a path from another machine, so neither resolves a
  // repository on this one: the directory is its own root.
  const pickRestoredRepoRoot = (cwd: string, exited: boolean, target: string): string => {
    if (exited || registry.targets.get(target)?.provider?.remote === true) {
      return cwd;
    }

    return resolveRepoRoot(cwd);
  };

  const findTargetRefusal = (entry: FleetEntry): string | null => {
    const target = entry.target ?? LOCAL_TARGET.id;
    const targetIdentity = entry.targetIdentity ?? LOCAL_TARGET_IDENTITY;
    const refusal = registry.findExecutionRefusal({ target, targetIdentity }, 'spawn');

    if (refusal === null) {
      return null;
    }

    const bound = registry.targets.get(target);
    const isUnconfirmed = bound !== undefined && isUnconfirmedBinding(bound, targetIdentity);

    return formatTargetRefusal(refusal.code, target, isUnconfirmed);
  };

  // The host state a restored session lists with: asleep when the harness
  // was left inside a sleeping host, unknown for any other remote host until
  // the daemon reaches it, and none on the daemon's own machine.
  const pickRestoredVM = (target: string, suspended: boolean): SessionLifecycle['vm'] => {
    if (!registry.hasHostLifecycle(target)) {
      return 'none';
    }

    return suspended ? 'asleep' : 'unknown';
  };

  return {
    resolveRestoredEntry: async (entry) => {
      const target = entry.target ?? LOCAL_TARGET.id;

      if (registry.findExecutionRefusal({ target, targetIdentity: null }, 'spawn') !== null) {
        return entry;
      }

      const targetIdentity = await resolveRestoredTargetIdentity(
        registry.targets.get(target),
        entry,
      );

      return targetIdentity === undefined || targetIdentity === entry.targetIdentity
        ? entry
        : { ...entry, targetIdentity };
    },

    restore: (entry) => {
      const target = entry.target ?? LOCAL_TARGET.id;
      const targetIdentity = entry.targetIdentity ?? LOCAL_TARGET_IDENTITY;
      const targetRefusal = findTargetRefusal(entry);

      // A session whose target this daemon cannot use comes back exited, so
      // nothing runs it anywhere else: neither a terminal nor a headless turn.
      const exited =
        entry.exited === true || entry.agentSessionID === undefined || targetRefusal !== null;

      // A harness kept inside a host that went to sleep, whether the operator
      // or the host's own owner put it there, comes back asleep, so a restore
      // leaves the host asleep until a revive wakes it.
      const suspended = exited && (entry.suspended === true || entry.desired === 'sleep');

      // An entry whose agent is no longer registered still gets its row, so a
      // backend dropped from the config shows as itself instead of vanishing or
      // reviving under another agent. Adopting a terminal for it is refused.
      let lastMsg = 'waiting to restore';

      if (suspended) {
        lastMsg = 'asleep';
      } else if (entry.exited !== true && entry.agentSessionID === undefined) {
        lastMsg = 'nothing to resume';
      } else if (entry.exited !== true && targetRefusal !== null) {
        lastMsg = targetRefusal;
      } else if (exited) {
        lastMsg = 'killed';
      } else if (registry.findAdapter(entry.agent) === null) {
        lastMsg = `no adapter for '${entry.agent}'`;
      }

      const parent = entry.parent ?? null;

      const session: Session = {
        id: entry.sessionID,
        name: entry.name,
        cwd: entry.cwd,
        kind: 'headless',
        pty: null,
        state: exited ? 'exited' : 'running',
        unread: false,
        lastMsg,
        ...(entry.agentSessionID === undefined ? {} : { agentSessionID: entry.agentSessionID }),
        agent: entry.agent,
        pinned: entry.pinned ?? false,
        lastAttachedAt: entry.lastAttachedAt ?? callbacks.getClock().now(),
        repoRoot: pickRestoredRepoRoot(entry.cwd, exited, target),
        namedBy: 'auto',
        createdAt: callbacks.getClock().now(),
        parent:
          parent !== null && registry.sessions.some((existing) => existing.id === parent)
            ? parent
            : null,
        ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
        ...(entry.result === undefined ? {} : { result: entry.result }),
        ...(entry.transcriptPath === undefined ? {} : { transcriptPath: entry.transcriptPath }),
        ...(entry.model === undefined ? {} : { model: entry.model }),
        ...(entry.effort === undefined ? {} : { effort: entry.effort }),
        ...(entry.pluginDirs === undefined ? {} : { pluginDirs: entry.pluginDirs }),
        target,
        targetIdentity,
        ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
        withheldEnv: entry.withheldEnv ?? [],
        desired: entry.desired ?? 'run',
        suspended,
        vm: pickRestoredVM(target, suspended),
        attachment: registry.hasHostLifecycle(target) ? 'detached' : 'local',
        hostKey: entry.hostKey ?? entry.sessionID,
        bridgeEpoch: 0,
        ...(entry.authRevision === undefined ? {} : { authRevision: entry.authRevision }),
      };

      registry.sessions.push(session);

      if (!exited) {
        registry.unrestored.add(session.id);
      }

      fleet.writeStatus();
      callbacks.onEvent('added', session);

      return session;
    },

    isUnrestored: (id) => registry.unrestored.has(id),

    removeUnrestoredMark: (id) => {
      registry.unrestored.delete(id);
    },

    updateRestoreRefusal: (session, reason, code) => {
      session.lastMsg = reason;

      if (code === null) {
        delete session.restoreRefusal;
      } else {
        session.restoreRefusal = { code, message: reason };
      }

      callbacks.onEvent('state', session);
      fleet.emitChange();
    },

    updateRestoredIdentity: (session, identity) => {
      if (session.targetIdentity === identity) {
        return;
      }

      session.targetIdentity = identity;
      session.lastMsg = 'waiting to restore';

      callbacks.onEvent('state', session);
    },
  };
}

// A target refusal as a session's last message, short enough for a list row.
function formatTargetRefusal(code: ErrorCode, target: string, isUnconfirmed: boolean): string {
  if (code === 'target_config_invalid') {
    return `target '${target}' misconfigured`;
  }

  if (code === 'unknown_target') {
    return `no target '${target}'`;
  }

  if (code === 'target_changed') {
    if (isUnconfirmed) {
      return `target '${target}' binding unverified`;
    }

    return `target '${target}' changed`;
  }

  if (code === 'target_unavailable') {
    return `target '${target}' unavailable`;
  }

  return `target '${target}' cannot start a terminal`;
}
