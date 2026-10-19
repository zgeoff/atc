import { renameSync, rmSync, writeFileSync } from 'node:fs';
import type { SessionID } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import type { FleetEntry, FleetEntryUpdate, FleetStore } from '@atc/store';
import type { SessionCallbacks } from '../sessions/session-callbacks';
import type { SessionRegistry } from '../sessions/session-registry';
import { toDaemonError } from '../sessions/to-daemon-error';

interface SessionFleetWriterDeps {
  readonly registry: Pick<
    SessionRegistry,
    'sessions' | 'removedIDs' | 'countStates' | 'sortSessions'
  >;
  readonly store: FleetStore;
  readonly statusPath: string;
  readonly callbacks: Pick<SessionCallbacks, 'onChange' | 'log' | 'findRecords'>;
}

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

  // the statusline command injected into sessions reads this file; it is written beside
  // its place and renamed over it, so a reader that opens it mid-write still sees the
  // whole previous file, never a truncated or empty one
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

  // a stored row the daemon has not restored yet stays as it is, so a write before a
  // restore keeps it restorable; deliberate kills rewrite the fleet and unexpected
  // deaths do not, so the last known fleet survives for a restore
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
        ...(s.pluginDirs === undefined ? {} : { pluginDirs: s.pluginDirs }),
        target: s.target,
        targetIdentity: s.targetIdentity,
        ...(s.desired === 'run' ? {} : { desired: s.desired }),
        ...(s.hostKey === s.id ? {} : { hostKey: s.hostKey }),
        ...(s.authRevision === undefined ? {} : { authRevision: s.authRevision }),
        ...(!live && s.suspended ? { suspended: true } : {}),
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

      await this.callbacks.findRecords()?.remove(id);
    }
  }

  // a failed write nobody awaits must not take the daemon down unhandled; a stale
  // ownership epoch surfaces on the next write a request awaits, and any other
  // failure is logged with the session whose change it was writing
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
