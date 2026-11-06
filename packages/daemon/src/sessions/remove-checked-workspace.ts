import type { ExecutionProvider } from '@atc/plugin-api';
import type { SessionID, WorkspaceCleanup } from '@atcx/contract';
import { formatError } from '../auth/format-error';
import type { SessionManager } from './create-session-manager';

interface CheckedWorkspaceRemoval {
  readonly manager: Pick<SessionManager, 'removeClaimedDir'>;
  readonly provider: ExecutionProvider;

  // The session atc created the workspace for, and its host.
  readonly id: SessionID;
  readonly hostKey: SessionID;
  readonly target: string;

  // The workspace as its host resolved it, and what its check found there.
  readonly path: string;
  readonly found: readonly string[];
}

// Reports the workspace kept, with the reason, when the removal refuses or fails.
export async function removeCheckedWorkspace(
  removal: CheckedWorkspaceRemoval,
): Promise<WorkspaceCleanup> {
  const refusal = await removal.manager
    .removeClaimedDir({
      provider: removal.provider,
      id: removal.id,
      hostKey: removal.hostKey,
      target: removal.target,
      directory: removal.path,
    })
    .then(
      (removed) =>
        removed ? null : "in use: a listed session's directory lies inside it, or it moved",
      (error: unknown) => `removing it failed: ${formatError(error)}`,
    );

  return refusal === null
    ? { outcome: 'removed', path: removal.path, found: removal.found }
    : { outcome: 'kept', path: removal.path, reasons: [refusal] };
}
