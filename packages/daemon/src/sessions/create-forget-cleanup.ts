import { join } from 'node:path';
import type { WorkspaceCleanupConfig } from '@atc/config';
import type { SessionID, WorkspaceCleanup } from '@atcx/contract';
import type { Session } from './session';

interface ForgetCleanupDeps {
  readonly log: (line: string) => void;

  // The daemon's state folder, which holds each session's own folder under `sessions/`.
  readonly stateDir: string;

  // Removes a folder on the daemon's host and everything in it; a folder already gone is no error.
  readonly removeDir: (directory: string) => Promise<void>;

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

    // join folds `.` and `..` segments, so an id such as `unused/../kept` would name another
    // session's folder; only an id that join leaves as one segment names its own
    if (id.includes('/') || directory !== `${sessions}/${id}`) {
      deps.log(
        `atc: left the state folder of session ${id}, since its id names no folder of its own under ${sessions}`,
      );

      return;
    }

    try {
      await deps.removeDir(directory);
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
