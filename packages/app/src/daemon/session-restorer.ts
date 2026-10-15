import { LOCAL_TARGET } from '@atc/config';
import type { SessionID } from '@atc/core';
import type { SessionLifecycle } from '@atc/protocol';
import type { ErrorCode } from '@atc/protocol/wire';
import type { FleetEntry } from '@atc/store';
import { resolveRepoRoot } from '../shared/resolve-repo-root';
import { resolveRestoredTargetIdentity } from './resolve-restored-target-identity';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionFleetWriter } from './session-fleet-writer';
import { LOCAL_TARGET_IDENTITY } from './session-registry';
import type { SessionRegistry } from './session-registry';

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

/**
 * Brings a fleet row back as a listed session without a terminal, so the
 * fleet lists before any harness starts, and tracks which restored
 * sessions still wait for one.
 */
export class SessionRestorer {
  private readonly registry: SessionRestorerDeps['registry'];

  private readonly fleet: SessionRestorerDeps['fleet'];

  private readonly callbacks: SessionRestorerDeps['callbacks'];

  constructor(deps: SessionRestorerDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.callbacks = deps.callbacks;
  }

  // An exited row never runs again until revived, and a row on a remote
  // target holds a path from another machine, so neither resolves a
  // repository on this one: the directory is its own root.
  private pickRestoredRepoRoot(cwd: string, exited: boolean, target: string): string {
    if (exited || this.registry.targets.get(target)?.provider?.remote === true) {
      return cwd;
    }

    return resolveRepoRoot(cwd);
  }

  // Checks the configured target before resolving an unversioned binding
  // against an existing host. Invalid config never reaches the provider.
  async resolveRestoredEntry(entry: FleetEntry): Promise<FleetEntry> {
    const target = entry.target ?? LOCAL_TARGET.id;

    if (this.registry.findExecutionRefusal({ target, targetIdentity: null }, 'spawn') !== null) {
      return entry;
    }

    const targetIdentity = await resolveRestoredTargetIdentity(
      this.registry.targets.get(target),
      entry,
    );

    return targetIdentity === undefined || targetIdentity === entry.targetIdentity
      ? entry
      : { ...entry, targetIdentity };
  }

  // Registers a fleet entry without a terminal, so the fleet lists before
  // adoption. Exited entries stay exited until revived by hand.
  restore(entry: FleetEntry): Session {
    const target = entry.target ?? LOCAL_TARGET.id;
    const targetIdentity = entry.targetIdentity ?? LOCAL_TARGET_IDENTITY;
    const refusal = this.registry.findExecutionRefusal({ target, targetIdentity }, 'spawn');

    const targetRefusal =
      refusal === null ? null : formatTargetRefusal(refusal.code, target, targetIdentity);

    // A session whose target this daemon cannot use comes back exited, so
    // nothing runs it anywhere else: neither a terminal nor a headless turn.
    const exited =
      entry.exited === true || entry.agentSessionID === undefined || targetRefusal !== null;

    // An entry whose agent is no longer registered still gets its row, so a
    // backend dropped from the config shows as itself instead of vanishing or
    // reviving under another agent. Adopting a terminal for it is refused.
    let lastMsg = 'waiting to restore';

    if (exited && entry.desired === 'sleep') {
      lastMsg = 'asleep';
    } else if (entry.exited !== true && entry.agentSessionID === undefined) {
      lastMsg = 'nothing to resume';
    } else if (entry.exited !== true && targetRefusal !== null) {
      lastMsg = targetRefusal;
    } else if (exited) {
      lastMsg = 'killed';
    } else if (this.registry.findAdapter(entry.agent) === null) {
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
      lastAttachedAt: entry.lastAttachedAt ?? this.callbacks.getClock().now(),
      repoRoot: this.pickRestoredRepoRoot(entry.cwd, exited, target),
      namedBy: 'auto',
      createdAt: this.callbacks.getClock().now(),
      parent:
        parent !== null && this.registry.sessions.some((s) => s.id === parent) ? parent : null,
      ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
      ...(entry.result === undefined ? {} : { result: entry.result }),
      ...(entry.transcriptPath === undefined ? {} : { transcriptPath: entry.transcriptPath }),
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.effort === undefined ? {} : { effort: entry.effort }),
      target,
      targetIdentity,
      ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
      withheldEnv: entry.withheldEnv ?? [],
      desired: entry.desired ?? 'run',
      suspended: exited && entry.desired === 'sleep',
      vm: this.pickRestoredVM(target, entry.desired),
      attachment: this.registry.hasHostLifecycle(target) ? 'detached' : 'local',
      hostKey: entry.hostKey ?? entry.sessionID,
      bridgeEpoch: 0,
      ...(entry.authRevision === undefined ? {} : { authRevision: entry.authRevision }),
    };

    this.registry.sessions.push(session);

    if (!exited) {
      this.registry.unrestored.add(session.id);
    }

    this.fleet.writeStatus();
    this.callbacks.onEvent('added', session);

    return session;
  }

  // Whether a restore registered the session and neither a terminal nor a
  // headless turn has started for it since.
  isUnrestored(id: SessionID): boolean {
    return this.registry.unrestored.has(id);
  }

  // Counts the session as a live headless session from now on, so a later
  // restore never starts a terminal beside the headless turn it runs.
  removeUnrestoredMark(id: SessionID): void {
    this.registry.unrestored.delete(id);
  }

  // Lists why a restore could not start a session's terminal, in place of
  // the wait it listed before, with the refusal's code when no later try
  // lifts it.
  updateRestoreRefusal(s: Session, reason: string, code: string | null): void {
    s.lastMsg = reason;

    if (code === null) {
      delete s.restoreRefusal;
    } else {
      s.restoreRefusal = { code, message: reason };
    }

    this.callbacks.onEvent('state', s);
    this.fleet.emitChange();
  }

  // Publishes a checked binding and clears the refusal from its earlier
  // restore before a terminal adoption can fail for a different reason.
  updateRestoredIdentity(s: Session, identity: string): void {
    if (s.targetIdentity === identity) {
      return;
    }

    s.targetIdentity = identity;
    s.lastMsg = 'waiting to restore';

    this.callbacks.onEvent('state', s);
  }

  // The host state a restored session lists with: asleep when the operator
  // left it asleep, unknown for any other remote host until the daemon
  // reaches it, and none on the daemon's own machine.
  private pickRestoredVM(
    target: string,
    desired: 'sleep' | 'stop' | undefined,
  ): SessionLifecycle['vm'] {
    if (!this.registry.hasHostLifecycle(target)) {
      return 'none';
    }

    return desired === 'sleep' ? 'asleep' : 'unknown';
  }
}

// A target refusal as a session's last message, short enough for a list row.
function formatTargetRefusal(code: ErrorCode, target: string, identity: string): string {
  if (code === 'target_config_invalid') {
    return `target '${target}' misconfigured`;
  }

  if (code === 'unknown_target') {
    return `no target '${target}'`;
  }

  if (code === 'target_changed') {
    if (/^imp:[\da-f]{16}$/.test(identity)) {
      return `target '${target}' binding unverified`;
    }

    return `target '${target}' changed`;
  }

  if (code === 'target_unavailable') {
    return `target '${target}' unavailable`;
  }

  return `target '${target}' cannot start a terminal`;
}
