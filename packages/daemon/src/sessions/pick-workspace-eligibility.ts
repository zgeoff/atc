import { posix } from 'node:path';

interface MaterializationRow {
  readonly target: string;
  readonly directory: string;
  readonly phase: string;
  readonly sha: string | null;
}

interface WorkspaceEligibilityInput {
  // The materialization row atc recorded for the session, or null when it recorded none.
  readonly row: MaterializationRow | null;

  // The target the session runs on now.
  readonly target: string;

  // atc saw every process the session ran exit.
  readonly harnessEnded: boolean;

  // Why the session's target refuses to run it now, or null when it accepts.
  readonly bindingRefusal: string | null;
}

// `none` leaves a session with no workspace of atc's; `check` sends the folder to the host check.
export type WorkspaceEligibility =
  | { readonly kind: 'none' }
  | { readonly kind: 'kept'; readonly path: string; readonly reason: string }
  | { readonly kind: 'check'; readonly directory: string; readonly sha: string };

export const UNENDED_REASON = "unchecked: atc could not confirm that the session's process exited";

export function pickWorkspaceEligibility(input: WorkspaceEligibilityInput): WorkspaceEligibility {
  const row = input.row;

  // only a workspace atc finished building is atc's to remove
  if (row === null || row.phase !== 'ready' || row.target !== input.target) {
    return { kind: 'none' };
  }

  if (!input.harnessEnded) {
    return { kind: 'kept', path: row.directory, reason: UNENDED_REASON };
  }

  // a target whose config changed since the session started may now run somewhere else, where
  // the recorded folder is not the session's
  if (input.bindingRefusal !== null) {
    return { kind: 'kept', path: row.directory, reason: `unchecked: ${input.bindingRefusal}` };
  }

  if (row.sha === null || !posix.isAbsolute(row.directory)) {
    return {
      kind: 'kept',
      path: row.directory,
      reason: 'unchecked: atc recorded no commit or no absolute folder for it',
    };
  }

  return { kind: 'check', directory: row.directory, sha: row.sha };
}
