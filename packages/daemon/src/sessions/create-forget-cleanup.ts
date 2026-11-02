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

interface ForgottenSessionState {
  // atc saw every process the session ran exit, so nothing writes in its folders any more.
  readonly harnessEnded: boolean;
}

export interface ForgetCleanup {
  // Runs once the forget took the session off the list.
  readonly removeSessionFolders: (
    session: Session,
    state: ForgottenSessionState,
  ) => Promise<WorkspaceCleanup>;
}

const NO_WORKSPACE: WorkspaceCleanup = { outcome: 'none' };
const UNENDED_REASON = "unchecked: atc could not confirm that the session's process exited";

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
    removeSessionFolders: async (session, state) => {
      if (!deps.settings.enabled) {
        return NO_WORKSPACE;
      }

      if (!state.harnessEnded) {
        deps.log(`atc: left the state folder of session ${session.id}: ${UNENDED_REASON}`);

        return NO_WORKSPACE;
      }

      await removeStateDir(session.id);

      return NO_WORKSPACE;
    },
  };
}
