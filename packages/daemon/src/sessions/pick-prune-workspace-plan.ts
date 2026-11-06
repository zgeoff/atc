import type { WorkspaceCleanupCheck } from '@atc/config';
import type { SessionID } from '@atcx/contract';
import { match } from 'ts-pattern';
import type { ListedSession } from './collect-prune-candidates';
import { isPathWithin } from './is-path-within';
import { pickWorkspaceCleanup } from './pick-workspace-cleanup';
import type { WorkspaceCheck } from './run-workspace-check';

// The directory of a session on the daemon's machine that only the stored fleet lists, as the
// machine resolves it, or null when it did not resolve.
export interface StoredDir {
  readonly id: SessionID;
  readonly physical: string | null;
}

interface PruneWorkspaceInput {
  readonly check: WorkspaceCleanupCheck;

  // The folder as the row recorded it, and what the check found there.
  readonly directory: string;
  readonly result: WorkspaceCheck;

  readonly listed: readonly ListedSession[];
  readonly storedDirs: readonly StoredDir[];

  // Without remove, a dry run that only reports the folder.
  readonly remove: boolean;
}

// `skip` drops a folder already gone from the answer; `report` is a dry run's `remove`.
export type PruneWorkspacePlan =
  | { readonly action: 'skip' }
  | { readonly action: 'keep'; readonly path: string; readonly reasons: readonly string[] }
  | { readonly action: 'report'; readonly path: string; readonly found: readonly string[] }
  | { readonly action: 'remove'; readonly path: string; readonly found: readonly string[] };

export function pickPruneWorkspacePlan(input: PruneWorkspaceInput): PruneWorkspacePlan {
  const forms = [input.directory, ...(input.result.kind === 'checked' ? [input.result.path] : [])];

  const listedUser = input.listed.find(
    (session) => session.onMachine && forms.some((form) => isPathWithin(session.cwd, form)),
  );

  // a stored directory that did not resolve may lead anywhere, so it keeps the folder
  const storedUser = input.storedDirs.find((stored) => {
    const physical = stored.physical;

    return physical === null || forms.some((form) => isPathWithin(physical, form));
  });

  const cleanup = pickWorkspaceCleanup({
    check: input.check,
    directory: input.directory,
    result: input.result,
    user: listedUser?.id ?? storedUser?.id ?? null,
  });

  return match(cleanup)
    .returnType<PruneWorkspacePlan>()
    .with({ action: 'skip' }, (skip) => skip)
    .with({ action: 'keep' }, (keep) => keep)
    .with({ action: 'remove' }, (removal) =>
      input.remove ? removal : { action: 'report', path: removal.path, found: removal.found },
    )
    .exhaustive();
}
