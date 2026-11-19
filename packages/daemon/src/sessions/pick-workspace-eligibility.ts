import { posix } from 'node:path';

interface MaterializationRow {
  readonly target: string;
  readonly directory: string;
  readonly phase: string;
  readonly sha: string | null;
}

interface WorkspaceEligibilityInput {
  readonly row: MaterializationRow | null;

  readonly target: string;

  readonly harnessEnded: boolean;

  readonly bindingRefusal: string | null;
}

export type WorkspaceEligibility =
  | { readonly kind: 'none' }
  | { readonly kind: 'kept'; readonly path: string; readonly reason: string }
  | { readonly kind: 'check'; readonly directory: string; readonly sha: string };

export const UNENDED_REASON = "unchecked: atc could not confirm that the session's process exited";

export function pickWorkspaceEligibility(input: WorkspaceEligibilityInput): WorkspaceEligibility {
  const row = input.row;

  if (row === null || row.phase !== 'ready' || row.target !== input.target) {
    return { kind: 'none' };
  }

  if (!input.harnessEnded) {
    return { kind: 'kept', path: row.directory, reason: UNENDED_REASON };
  }

  // A target whose config changed since the session started may now run on another host, where
  // the recorded folder does not belong to the session.
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
