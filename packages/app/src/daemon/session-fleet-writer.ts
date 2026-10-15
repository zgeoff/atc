import { renameSync, rmSync, writeFileSync } from 'node:fs';
import type { SessionID } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import type { FleetEntry, FleetEntryUpdate, FleetStore } from '@atc/store';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionRegistry } from './session-registry';
import { toDaemonError } from './to-daemon-error';

interface SessionFleetWriterDeps {
  readonly registry: Pick<
    SessionRegistry,
    'sessions' | 'removedIDs' | 'countStates' | 'sortSessions'
  >;
  readonly store: FleetStore;
  readonly statusPath: string;
  readonly callbacks: Pick<SessionCallbacks, 'onChange' | 'log' | 'getRecords'>;
}

/**
 * Writes the fleet the registry lists: the store's rows, continuously, so
 * a crash or a quit leaves a restorable fleet, and the status file the
 * statusline reporters read.
 */
export class SessionFleetWriter {
  private readonly store: FleetStore;

  readonly statusPath: string;

  private readonly registry: SessionFleetWriterDeps['registry'];

  private readonly callbacks: SessionFleetWriterDeps['callbacks'];

  constructor(deps: SessionFleetWriterDeps) {
    this.registry = deps.registry;
    this.store = deps.store;
    this.statusPath = deps.statusPath;
    this.callbacks = deps.callbacks;
  }

  emitChange() {
    this.writeStatus();
    this.callbacks.onChange();
  }

  // Consumed by the injected statusline command so wrangled sessions render
  // fleet state inside their own status line. The file is written beside
  // its place and renamed over it, so a reader that opens it mid-write
  // still sees the whole previous file, never a truncated or empty one.
  writeStatus() {
    const c = this.registry.countStates();
    const urgent = this.registry.sortSessions().find((s) => s.state === 'needs_you');
    const tmpPath = `${this.statusPath}.${process.pid}.tmp`;

    try {
      writeFileSync(tmpPath, JSON.stringify({ ...c, urgent: urgent?.name ?? null }));
      renameSync(tmpPath, this.statusPath);
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {}
    }
  }

  // Persisted continuously so a crash (or quit) leaves a restorable fleet.
  // A write covers the listed sessions and the ones dropped on purpose
  // since the last write; a stored row the daemon has not restored yet
  // stays as it is, so a write before `R` keeps it restorable. Deliberate
  // kills rewrite the fleet; unexpected session/atc deaths do not, so the
  // last known fleet survives for `R` restore. Sessions whose
  // terminal is gone persist as exited entries, so the killed archive
  // survives a daemon restart too. A session the agent has not yet given
  // its own session id persists as well, under its atc session id alone.
  async writeFleet(): Promise<void> {
    const fleet: FleetEntry[] = [];

    for (const s of this.registry.sessions) {
      const live = s.pty !== null || (s.kind === 'headless' && s.state !== 'exited');

      fleet.push({
        sessionID: s.id,
        name: s.name,
        cwd: s.cwd,
        ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
        agent: s.agent,
        ...(s.pinned ? { pinned: true } : {}),
        lastAttachedAt: s.lastAttachedAt,
        ...(live ? {} : { exited: true }),
        ...(s.parent === null ? {} : { parent: s.parent }),
        ...(s.prompt === undefined ? {} : { prompt: s.prompt }),
        ...(s.result === undefined ? {} : { result: s.result }),
        ...(s.transcriptPath === undefined ? {} : { transcriptPath: s.transcriptPath }),
        ...(s.model === undefined ? {} : { model: s.model }),
        ...(s.effort === undefined ? {} : { effort: s.effort }),
        target: s.target,
        targetIdentity: s.targetIdentity,
        ...(s.desired === 'run' ? {} : { desired: s.desired }),
        ...(s.hostKey === s.id ? {} : { hostKey: s.hostKey }),
        ...(s.authRevision === undefined ? {} : { authRevision: s.authRevision }),
      });
    }

    const removed = [...this.registry.removedIDs];

    try {
      await this.store.writeFleet(fleet, removed);
    } catch (error) {
      throw toDaemonError(error);
    }

    for (const id of removed) {
      this.registry.removedIDs.delete(id);

      await this.callbacks.getRecords()?.remove(id);
    }
  }

  // A write nobody awaits that fails leaves the stored rows as they were,
  // and must not take the daemon down unhandled. A stale ownership epoch is
  // expected and surfaces on the next write a request awaits; any other
  // failure is logged with the session whose change it was writing.
  async tryWriteFleet(sessionID: SessionID): Promise<boolean> {
    try {
      await this.writeFleet();
    } catch (error) {
      this.logStoreFailure(sessionID, error);

      return false;
    }

    return true;
  }

  async tryUpdateFleetEntry(id: SessionID, fields: FleetEntryUpdate): Promise<boolean> {
    try {
      await this.store.updateFleetEntry(id, fields);
    } catch (error) {
      this.logStoreFailure(id, toDaemonError(error));

      return false;
    }

    return true;
  }

  private logStoreFailure(sessionID: SessionID, error: unknown): void {
    if (error instanceof DaemonError && error.code === 'stale_epoch') {
      return;
    }

    const code = error instanceof DaemonError ? error.code : 'internal';
    const message = error instanceof Error ? error.message : String(error);

    this.callbacks.log(`atc fleet write for session ${sessionID} failed (${code}): ${message}`);
  }
}
