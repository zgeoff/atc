import { LOCAL_TARGET } from '@atc/config';
import type { AttentionKind, FleetEntry } from '@atc/store';
import type { SessionID, SessionLifecycle } from '@atcx/contract';
import type { ErrorCode } from '@atcx/contract/light';
import { match } from 'ts-pattern';
import { LOCAL_TARGET_IDENTITY } from '../sessions/create-session-registry';
import type { SessionRegistry } from '../sessions/create-session-registry';
import { resolveRepoRoot } from '../sessions/resolve-repo-root';
import type { Session } from '../sessions/session';
import type { SessionCallbacks } from '../sessions/session-callbacks';
import type { SessionFleetWriter } from './create-session-fleet-writer';
import { isUnconfirmedBinding } from './is-unconfirmed-binding';
import { resolveRestoredTargetIdentity } from './resolve-restored-target-identity';

export interface SessionRestorer {
  readonly resolveRestoredEntry: (entry: FleetEntry) => Promise<FleetEntry>;

  readonly restore: (entry: FleetEntry, attention: AttentionKind | null) => Session;

  readonly isUnrestored: (id: SessionID) => boolean;

  readonly removeUnrestoredMark: (id: SessionID) => void;

  readonly updateRestoreRefusal: (session: Session, reason: string, code: string | null) => void;

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

  // A remote target's cwd is a path from another machine and cannot resolve to a repo here.
  // An exited row never runs again, so it needs no repo root either.
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

    restore: (entry, attention) => {
      const target = entry.target ?? LOCAL_TARGET.id;
      const targetIdentity = entry.targetIdentity ?? LOCAL_TARGET_IDENTITY;
      const targetRefusal = findTargetRefusal(entry);

      const exited =
        entry.exited === true || entry.agentSessionID === undefined || targetRefusal !== null;

      const suspended = exited && (entry.suspended === true || entry.desired === 'sleep');
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
        state: exited ? 'exited' : pickRestoredState(attention),
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
        spawner: entry.spawner ?? null,
        ...(entry.atcAccess === undefined ? {} : { atcAccess: entry.atcAccess }),
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
        ...(entry.agentHome === undefined ? {} : { agentHome: entry.agentHome }),
        ...(entry.trustedRoot === undefined ? {} : { trustedRoot: entry.trustedRoot }),
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

// A relaunched agent does not redraw a prompt shown before the restart, so a prompt restores as
// done. With no attention event the session may be mid-turn, so it lists as running.
function pickRestoredState(attention: AttentionKind | null): 'running' | 'done' {
  return match(attention)
    .with('turn-done', 'needs-input', () => 'done' as const)
    .with('prompt-submitted', null, () => 'running' as const)
    .exhaustive();
}
