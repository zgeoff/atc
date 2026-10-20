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
    const counts = this.registry.countStates();
    const urgent = this.registry.sortSessions().find((session) => session.state === 'needs_you');
    const tmpPath = `${this.statusPath}.${process.pid}.tmp`;

    try {
      writeFileSync(tmpPath, JSON.stringify({ ...counts, urgent: urgent?.name ?? null }));
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

    for (const session of this.registry.sessions) {
      const live =
        session.pty !== null || (session.kind === 'headless' && session.state !== 'exited');

      fleet.push({
        sessionID: session.id,
        name: session.name,
        cwd: session.cwd,
        ...(session.agentSessionID === undefined ? {} : { agentSessionID: session.agentSessionID }),
        agent: session.agent,
        ...(session.pinned ? { pinned: true } : {}),
        lastAttachedAt: session.lastAttachedAt,
        ...(live ? {} : { exited: true }),
        ...(session.parent === null ? {} : { parent: session.parent }),
        ...(session.prompt === undefined ? {} : { prompt: session.prompt }),
        ...(session.result === undefined ? {} : { result: session.result }),
        ...(session.transcriptPath === undefined ? {} : { transcriptPath: session.transcriptPath }),
        ...(session.model === undefined ? {} : { model: session.model }),
        ...(session.effort === undefined ? {} : { effort: session.effort }),
        ...(session.pluginDirs === undefined ? {} : { pluginDirs: session.pluginDirs }),
        target: session.target,
        targetIdentity: session.targetIdentity,
        ...(session.desired === 'run' ? {} : { desired: session.desired }),
        ...(session.hostKey === session.id ? {} : { hostKey: session.hostKey }),
        ...(session.authRevision === undefined ? {} : { authRevision: session.authRevision }),
        ...(!live && session.suspended ? { suspended: true } : {}),
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
