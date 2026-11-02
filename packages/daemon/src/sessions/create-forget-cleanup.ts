import { rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { WorkspaceCleanupConfig } from '@atc/config';
import type { StateStore } from '@atc/store';
import type { SessionID, WorkspaceCleanup } from '@atcx/contract';
import { match } from 'ts-pattern';
import type { SessionManager } from './create-session-manager';
import { isPathWithin } from './is-path-within';
import { pickWorkspaceCleanup } from './pick-workspace-cleanup';
import { runWorkspaceCheck } from './run-workspace-check';
import type { Session } from './session';

interface ForgetCleanupDeps {
  readonly manager: Pick<
    SessionManager,
    'sessions' | 'findProvider' | 'hasHostLifecycle' | 'removeClaimedDir' | 'log'
  >;
  readonly store: Pick<StateStore, 'readMaterialization'>;

  // The daemon's state folder, which holds each session's own folder under `sessions/`.
  readonly stateDir: string;

  readonly settings: WorkspaceCleanupConfig;
}

interface ForgottenSessionState {
  // The forget destroyed the session's host, and the workspace went with it.
  readonly hostDestroyed: boolean;

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
  const manager = deps.manager;
  const settings = deps.settings;

  const removeStateDir = async (id: SessionID): Promise<void> => {
    const sessions = join(deps.stateDir, 'sessions');
    const directory = join(sessions, id);

    if (dirname(directory) !== sessions) {
      manager.log(
        `atc: left the state folder of session ${id}, since its id names no folder of its own under ${sessions}`,
      );

      return;
    }

    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      manager.log(
        `atc: left ${directory} after session ${id} was forgotten, since removing it failed: ${formatError(error)}`,
      );
    }
  };

  // A listed session on the same host whose directory lies inside the folder, in any of the
  // forms given; the removal checks again with every directory as the host resolves it.
  const findWorkspaceUser = (session: Session, forms: readonly string[]): SessionID | null => {
    const hosted = manager.hasHostLifecycle(session.target);

    const user = manager.sessions.find(
      (other) =>
        other.id !== session.id &&
        (hosted
          ? other.hostKey === session.hostKey && other.target === session.target
          : !manager.hasHostLifecycle(other.target)) &&
        forms.some((form) => isPathWithin(other.cwd, form)),
    );

    return user?.id ?? null;
  };

  const removeWorkspace = async (
    session: Session,
    harnessEnded: boolean,
  ): Promise<WorkspaceCleanup> => {
    const row = await deps.store.readMaterialization(session.id);

    // only a workspace atc finished building is atc's to remove
    if (row === null || row.phase !== 'ready' || row.target !== session.target) {
      return NO_WORKSPACE;
    }

    if (!harnessEnded) {
      return { outcome: 'kept', path: row.directory, reasons: [UNENDED_REASON] };
    }

    const provider = manager.findProvider(session);

    if (provider === null || row.sha === null || !posix.isAbsolute(row.directory)) {
      return {
        outcome: 'kept',
        path: row.directory,
        reasons: [
          provider === null
            ? `unchecked: target '${session.target}' is not configured`
            : 'unchecked: atc recorded no commit or no absolute folder for it',
        ],
      };
    }

    const host = manager.hasHostLifecycle(session.target) ? session.hostKey : null;

    const result = await runWorkspaceCheck({
      provider,
      host,
      directory: row.directory,
      sha: row.sha,
    });

    const plan = pickWorkspaceCleanup({
      check: settings.check,
      directory: row.directory,
      result,
      user: findWorkspaceUser(session, [
        row.directory,
        ...(result.kind === 'checked' ? [result.path] : []),
      ]),
    });

    return match(plan)
      .returnType<Promise<WorkspaceCleanup>>()
      .with({ action: 'skip' }, () => Promise.resolve(NO_WORKSPACE))
      .with({ action: 'keep' }, (kept) =>
        Promise.resolve({ outcome: 'kept', path: kept.path, reasons: kept.reasons }),
      )
      .with({ action: 'remove' }, async (removal) => {
        const refusal = await manager
          .removeClaimedDir({
            provider,
            id: session.id,
            hostKey: session.hostKey,
            target: session.target,
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
      })
      .exhaustive();
  };

  return {
    removeSessionFolders: async (session, state) => {
      if (!settings.enabled) {
        return NO_WORKSPACE;
      }

      const workspace = state.hostDestroyed
        ? NO_WORKSPACE
        : await removeWorkspace(session, state.harnessEnded).catch(
            (error: unknown): WorkspaceCleanup => ({
              outcome: 'kept',
              path: session.cwd,
              reasons: [`unchecked: ${formatError(error)}`],
            }),
          );

      logWorkspaceCleanup(manager.log, session.id, workspace);

      if (!state.harnessEnded) {
        manager.log(`atc: left the state folder of session ${session.id}: ${UNENDED_REASON}`);

        return workspace;
      }

      await removeStateDir(session.id);

      return workspace;
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logWorkspaceCleanup(
  log: (line: string) => void,
  id: SessionID,
  workspace: WorkspaceCleanup,
): void {
  match(workspace)
    .with({ outcome: 'none' }, () => {})
    .with({ outcome: 'removed' }, (removed) => {
      log(
        `atc: removed the workspace ${removed.path} of forgotten session ${id}${removed.found.length === 0 ? '' : `, which held ${removed.found.join('; ')}`}`,
      );
    })
    .with({ outcome: 'kept' }, (kept) => {
      log(
        `atc: kept the workspace ${kept.path} of forgotten session ${id}: ${kept.reasons.join('; ')}`,
      );
    })
    .exhaustive();
}
