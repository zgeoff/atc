import type { WorkspaceCleanupCheck } from '@atc/config';
import type { SessionID } from '@atcx/contract';
import { P, match } from 'ts-pattern';
import type { WorkspaceCheck } from './run-workspace-check';

interface WorkspaceCleanupInput {
  readonly check: WorkspaceCleanupCheck;

  // The folder as the materialization recorded it.
  readonly directory: string;

  readonly result: WorkspaceCheck;

  // A listed session whose directory lies inside the folder, or null.
  readonly user: SessionID | null;
}

// `skip` leaves a folder that is already gone with nothing to report.
export type WorkspaceCleanupPlan =
  | { readonly action: 'remove'; readonly path: string; readonly found: readonly string[] }
  | { readonly action: 'keep'; readonly path: string; readonly reasons: readonly string[] }
  | { readonly action: 'skip' };

export function pickWorkspaceCleanup(input: WorkspaceCleanupInput): WorkspaceCleanupPlan {
  const path = input.result.kind === 'checked' ? input.result.path : input.directory;

  return match({ result: input.result, check: input.check, user: input.user })
    .returnType<WorkspaceCleanupPlan>()
    .with({ result: { kind: 'missing' } }, () => ({ action: 'skip' }))
    .with({ user: P.string }, (matched) => ({
      action: 'keep',
      path,
      reasons: [`in use by session ${matched.user}`],
    }))
    .with({ result: { kind: 'foreign' } }, () => ({
      action: 'keep',
      path,
      reasons: [
        'not the checkout atc created: a symlink, or no git checkout of its commit at its top',
      ],
    }))
    .with({ result: { kind: 'unchecked' } }, (matched) => ({
      action: 'keep',
      path,
      reasons: [`unchecked: ${matched.result.reason}`],
    }))
    .with({ result: { kind: 'checked' }, check: 'none' }, (matched) => ({
      action: 'remove',
      path,
      found: matched.result.findings,
    }))
    .with({ result: { kind: 'checked', findings: [] }, check: 'unpushed' }, () => ({
      action: 'remove',
      path,
      found: [],
    }))
    .with({ result: { kind: 'checked' }, check: 'unpushed' }, (matched) => ({
      action: 'keep',
      path,
      reasons: matched.result.findings,
    }))
    .exhaustive();
}
