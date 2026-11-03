import { join } from 'node:path';
import type { WorkspaceCleanupConfig } from '@atc/config';
import type { StateStore } from '@atc/store';
import type { SessionID, WorkspaceCleanup } from '@atcx/contract';
import { match } from 'ts-pattern';
import { formatError } from '../auth/format-error';
import type { SessionHold } from './create-host-dir-claims';
import type { SessionManager } from './create-session-manager';
import { isPathWithin } from './is-path-within';
import { pickWorkspaceCleanup } from './pick-workspace-cleanup';
import { UNENDED_REASON, pickWorkspaceEligibility } from './pick-workspace-eligibility';
import { runWorkspaceCheck } from './run-workspace-check';
import type { Session } from './session';

interface ForgetCleanupDeps {
  readonly manager: Pick<
    SessionManager,
    | 'sessions'
    | 'findExecutionRefusal'
    | 'requireExecution'
    | 'hasHostLifecycle'
    | 'removeClaimedDir'
    | 'withRemovalHold'
    | 'collectHeldSessions'
    | 'log'
  >;
  readonly store: Pick<StateStore, 'readMaterialization'>;

  // The daemon's state folder, which holds each session's own folder under `sessions/`.
  readonly stateDir: string;

  // Removes a folder on the daemon's host and everything in it; a folder already gone is no error.
  readonly removeDir: (directory: string) => Promise<void>;

  readonly settings: WorkspaceCleanupConfig;
}

interface ForgottenSessionState {
  // The forget destroyed the session's host, and the workspace went with it.
  readonly hostDestroyed: boolean;

  // atc saw every process the session ran exit, so nothing writes in its folders any more.
  readonly harnessEnded: boolean;

  // The hold the kill or forget took on the session, which this cleanup ends.
  readonly hold: SessionHold;
}

export interface ForgetCleanup {
  // Runs once the forget took the session off the list, and ends the hold on it once its
  // processes ended.
  readonly removeSessionFolders: (
    session: Session,
    state: ForgottenSessionState,
  ) => Promise<WorkspaceCleanup>;
}

const NO_WORKSPACE: WorkspaceCleanup = { outcome: 'none' };

export function createForgetCleanup(deps: ForgetCleanupDeps): ForgetCleanup {
  const manager = deps.manager;
  const settings = deps.settings;

  const removeStateDir = async (id: SessionID): Promise<void> => {
    const sessions = join(deps.stateDir, 'sessions');
    const directory = join(sessions, id);

    // join folds `.` and `..` segments, so an id such as `unused/../kept` would name another
    // session's folder; only an id that join leaves as one segment names its own
    if (id.includes('/') || directory !== `${sessions}/${id}`) {
      manager.log(
        `atc: left the state folder of session ${id}, since its id names no folder of its own under ${sessions}`,
      );

      return;
    }

    try {
      await deps.removeDir(directory);
    } catch (error) {
      manager.log(
        `atc: left ${directory} after session ${id} was forgotten, since removing it failed: ${formatError(error)}`,
      );
    }
  };

  // A listed or held session on the same host whose directory lies inside the folder, in any of
  // the forms given; the removal checks again with every directory as the host resolves it.
  const findWorkspaceUser = (session: Session, forms: readonly string[]): SessionID | null => {
    const hosted = manager.hasHostLifecycle(session.target);

    const user = [...manager.sessions, ...manager.collectHeldSessions()].find(
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
    const eligibility = pickWorkspaceEligibility({
      row: await deps.store.readMaterialization(session.id),
      target: session.target,
      harnessEnded,
      bindingRefusal: manager.findExecutionRefusal(session, 'run')?.message ?? null,
    });

    // the hold starts before the check, since a session that starts in the folder while the
    // check runs would find its work removed
    return match(eligibility)
      .returnType<Promise<WorkspaceCleanup>>()
      .with({ kind: 'none' }, () => Promise.resolve(NO_WORKSPACE))
      .with({ kind: 'kept' }, (kept) =>
        Promise.resolve({ outcome: 'kept', path: kept.path, reasons: [kept.reason] }),
      )
      .with({ kind: 'check' }, (checked) =>
        manager.withRemovalHold(
          {
            id: session.id,
            hostKey: session.hostKey,
            target: session.target,
            directory: checked.directory,
          },
          () => checkAndRemoveWorkspace(session, checked.directory, checked.sha),
        ),
      )
      .exhaustive();
  };

  const checkAndRemoveWorkspace = async (
    session: Session,
    directory: string,
    sha: string,
  ): Promise<WorkspaceCleanup> => {
    const provider = manager.requireExecution(session, 'run').provider;
    const host = manager.hasHostLifecycle(session.target) ? session.hostKey : null;

    const result = await runWorkspaceCheck({ provider, host, directory, sha });

    const plan = pickWorkspaceCleanup({
      check: settings.check,
      directory,
      result,
      user: findWorkspaceUser(session, [
        directory,
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
      if (state.harnessEnded) {
        state.hold.release([session]);
      }

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
