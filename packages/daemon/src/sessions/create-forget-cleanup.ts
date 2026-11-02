import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WorkspaceCleanupConfig } from '@atc/config';
import type { SessionID, WorkspaceCleanup } from '@atcx/contract';
import type { Session } from './session';

interface ForgetCleanupDeps {
  readonly log: (line: string) => void;

  // The daemon's state folder, which holds each session's own folder under `sessions/`.
  readonly stateDir: string;

  readonly settings: WorkspaceCleanupConfig;
}

export interface ForgetCleanup {
  // Runs once the forget took the session off the list.
  readonly removeSessionFolders: (session: Session) => Promise<WorkspaceCleanup>;
}

const NO_WORKSPACE: WorkspaceCleanup = { outcome: 'none' };

export function createForgetCleanup(deps: ForgetCleanupDeps): ForgetCleanup {
  const removeStateDir = async (id: SessionID): Promise<void> => {
    const sessions = join(deps.stateDir, 'sessions');
    const directory = join(sessions, id);

    if (dirname(directory) !== sessions) {
      deps.log(
        `atc: left the state folder of session ${id}, since its id names no folder of its own under ${sessions}`,
      );

      return;
    }

    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      deps.log(
        `atc: left ${directory} after session ${id} was forgotten, since removing it failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    removeSessionFolders: async (session) => {
      if (!deps.settings.enabled) {
        return NO_WORKSPACE;
      }

      await removeStateDir(session.id);

      return NO_WORKSPACE;
    },
  };
}
