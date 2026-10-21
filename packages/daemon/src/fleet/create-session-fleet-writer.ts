import { renameSync, rmSync, writeFileSync } from 'node:fs';
import type { SessionID } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import type { FleetEntry, FleetEntryUpdate, FleetStore } from '@atc/store';
import type { SessionRegistry } from '../sessions/create-session-registry';
import type { SessionCallbacks } from '../sessions/session-callbacks';
import { toDaemonError } from '../sessions/to-daemon-error';

export interface SessionFleetWriter {
  readonly statusPath: string;

  readonly emitChange: () => void;

  // the statusline command injected into sessions reads this file; it is written beside
  // its place and renamed over it, so a reader that opens it mid-write still sees the
  // whole previous file, never a truncated or empty one
  readonly writeStatus: () => void;

  // a stored row the daemon has not restored yet stays as it is, so a write before a
  // restore keeps it restorable; deliberate kills rewrite the fleet and unexpected
  // deaths do not, so the last known fleet survives for a restore
  readonly writeFleet: () => Promise<void>;

  // a failed write nobody awaits must not take the daemon down unhandled; a stale
  // ownership epoch surfaces on the next write a request awaits, and any other
  // failure is logged with the session whose change it was writing
  readonly tryWriteFleet: (sessionID: SessionID) => Promise<boolean>;

  readonly tryUpdateFleetEntry: (id: SessionID, fields: FleetEntryUpdate) => Promise<boolean>;
}

interface SessionFleetWriterDeps {
  readonly registry: Pick<
    SessionRegistry,
    'sessions' | 'removedIDs' | 'countStates' | 'sortSessions'
  >;
  readonly store: FleetStore;
  readonly statusPath: string;
  readonly callbacks: Pick<SessionCallbacks, 'onChange' | 'log' | 'findRecords'>;
}

export function createSessionFleetWriter(deps: SessionFleetWriterDeps): SessionFleetWriter {
  const registry = deps.registry;
  const store = deps.store;
  const statusPath = deps.statusPath;
  const callbacks = deps.callbacks;

  const writeStatus = (): void => {
    const counts = registry.countStates();
    const urgent = registry.sortSessions().find((session) => session.state === 'needs_you');
    const tmpPath = `${statusPath}.${process.pid}.tmp`;

    try {
      writeFileSync(tmpPath, JSON.stringify({ ...counts, urgent: urgent?.name ?? null }));
      renameSync(tmpPath, statusPath);
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {}
    }
  };

  const writeFleet = async (): Promise<void> => {
    const fleet: FleetEntry[] = [];

    for (const session of registry.sessions) {
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

    const removed = [...registry.removedIDs];

    try {
      await store.writeFleet(fleet, removed);
    } catch (error) {
      throw toDaemonError(error);
    }

    for (const id of removed) {
      registry.removedIDs.delete(id);

      await callbacks.findRecords()?.remove(id);
    }
  };

  const logStoreFailure = (sessionID: SessionID, error: unknown): void => {
    if (error instanceof DaemonError && error.code === 'stale_epoch') {
      return;
    }

    const code = error instanceof DaemonError ? error.code : 'internal';
    const message = error instanceof Error ? error.message : String(error);

    callbacks.log(`atc fleet write for session ${sessionID} failed (${code}): ${message}`);
  };

  return {
    statusPath,

    emitChange: () => {
      writeStatus();

      callbacks.onChange();
    },

    writeStatus,

    writeFleet,

    tryWriteFleet: async (sessionID) => {
      try {
        await writeFleet();
      } catch (error) {
        logStoreFailure(sessionID, error);

        return false;
      }

      return true;
    },

    tryUpdateFleetEntry: async (id, fields) => {
      try {
        await store.updateFleetEntry(id, fields);
      } catch (error) {
        logStoreFailure(id, toDaemonError(error));

        return false;
      }

      return true;
    },
  };
}
