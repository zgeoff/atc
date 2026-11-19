import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import type { SessionRegistry } from './create-session-registry';
import { isPathWithin } from './is-path-within';
import { resolveFromHome } from './resolve-from-home';
import { resolveHostDir } from './resolve-host-dir';
import { resolveHostHome } from './resolve-host-home';
import { resolveListedDirs } from './resolve-listed-dirs';
import { resolveMachineDir } from './resolve-machine-dir';
import type { Session } from './session';

export { RESOLVE_DIR_SCRIPT, RESOLVE_UNLINKED_DIR_SCRIPT } from './resolve-host-dir';
export { RESOLVE_HOME_SCRIPT } from './resolve-host-home';

interface WorkspaceReservation {
  readonly hostKey: SessionID;
  readonly target: string;
  directory: string;
  resolved: string | null;

  readonly kind: 'workspace' | 'plain';
}

// A symlink swapped in during the removal must not be followed, so the script checks from inside
// the directory that it still resolves to itself before it deletes anything.
export const REMOVE_DIR_SCRIPT =
  'cd -P -- "$1" || exit 3; [ "$(pwd -P; printf x)" = "$2" ] || exit 4; find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || exit 5; cd / && rmdir -- "$1"';

interface RemoveClaimedDirOptions {
  readonly provider: ExecutionProvider;
  readonly id: SessionID;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly directory: string;
}

type RemovalHold = Omit<RemoveClaimedDirOptions, 'provider'>;

interface ClaimHostDirOptions extends RemoveClaimedDirOptions {
  readonly picked?: boolean;
}

interface HostDirClaimsDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'hasHostLifecycle'>;
}

export interface SessionHold {
  readonly release: (sessions: readonly Session[]) => void;
}

export interface HostDirClaims {
  readonly reservations: Map<SessionID, WorkspaceReservation>;

  readonly collectHeldSessions: () => Session[];
  readonly holdSessions: (sessions: readonly Session[]) => SessionHold;

  readonly releaseWorkspace: (id: SessionID) => void;

  readonly claimWorkspace: (
    id: SessionID,
    hostKey: SessionID,
    target: string,
    directory: string,
  ) => void;

  readonly claimPlainDir: (
    id: SessionID,
    hostKey: SessionID,
    target: string,
    directory: string,
  ) => void;

  readonly claimMachineDir: (
    id: SessionID,
    target: string,
    directory: string,
    picked: boolean,
  ) => void;

  readonly claimHostDir: (options: ClaimHostDirOptions) => Promise<string>;

  readonly removeClaimedDir: (options: RemoveClaimedDirOptions) => Promise<boolean>;

  readonly withRemovalHold: <T>(hold: RemovalHold, run: () => Promise<T>) => Promise<T>;

  readonly resolveHostDir: (
    provider: ExecutionProvider,
    hostKey: SessionID | null,
    directory: string,
    script?: string,
  ) => Promise<string>;

  readonly resolveHostHome: (provider: ExecutionProvider, hostKey: SessionID) => Promise<string>;
}

interface RequireSeparateWorkspaceOptions {
  readonly id: SessionID;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly directory: string;
  readonly forms: readonly string[];
  readonly listed: readonly (readonly [SessionID, string])[];
}

export function createHostDirClaims(deps: HostDirClaimsDeps): HostDirClaims {
  const reservations = new Map<SessionID, WorkspaceReservation>();
  const removals = new Map<string, number>();

  const machineRemovals: { readonly id: SessionID; readonly directory: string }[] = [];
  const registry = deps.registry;

  const sessionHolds = new Set<Set<Session>>();

  const collectHeldSessions = (): Session[] => {
    const held = new Set<Session>();

    for (const sessions of sessionHolds) {
      for (const session of sessions) {
        held.add(session);
      }
    }

    return [...held];
  };

  const collectSessions = (): Session[] => [
    ...registry.sessions,
    ...collectHeldSessions().filter((session) => !registry.sessions.includes(session)),
  ];

  const collectPlainDirs = (hostKey: SessionID, target: string): (readonly [SessionID, string])[] =>
    [...reservations]
      .filter(
        ([, reservation]) =>
          reservation.kind === 'plain' &&
          reservation.hostKey === hostKey &&
          reservation.target === target,
      )
      .map(([id, reservation]) => [id, reservation.directory] as const);

  const collectHostSessionIDs = (hostKey: SessionID, target: string): string =>
    [
      ...collectSessions()
        .filter((session) => session.hostKey === hostKey && session.target === target)
        .map((session) => session.id),
      ...collectPlainDirs(hostKey, target).map(([id]) => id),
    ].join(' ');

  const collectHostEntries = (
    hostKey: SessionID,
    target: string,
  ): readonly { readonly id: SessionID; readonly cwd: string }[] => [
    ...collectSessions().filter(
      (session) => session.hostKey === hostKey && session.target === target,
    ),
    ...collectPlainDirs(hostKey, target).map(([id, cwd]) => ({ id, cwd })),
  ];

  const collectMachineDirs = (id: SessionID): (readonly [SessionID, string])[] => [
    ...collectSessions()
      .filter((session) => session.id !== id && !registry.hasHostLifecycle(session.target))
      .map((session) => [session.id, session.cwd] as const),
    ...[...reservations]
      .filter(
        ([other, reservation]) =>
          other !== id &&
          reservation.kind === 'plain' &&
          !registry.hasHostLifecycle(reservation.target),
      )
      .map(([other, reservation]) => [other, reservation.directory] as const),
  ];

  const collectOtherWorkspaceDirs = (
    id: SessionID,
    hostKey: SessionID,
    target: string,
    listed: readonly (readonly [SessionID, string])[],
  ): (readonly [SessionID, string])[] => {
    const dirs = [...listed];

    for (const [other, reservation] of reservations) {
      if (other !== id && reservation.hostKey === hostKey && reservation.target === target) {
        dirs.push(
          ...[reservation.directory, reservation.resolved ?? reservation.directory]
            .filter((held) => posix.isAbsolute(held))
            .map((held) => [other, held] as const),
        );
      }
    }

    return dirs;
  };

  // a directory may reach the one a removal is emptying through a symlink no check has resolved
  // yet, so every claim on the host waits for the removal
  const requireNoHostRemoval = (hostKey: SessionID, target: string, directory: string): void => {
    if ((removals.get(buildHostSlot(hostKey, target)) ?? 0) > 0) {
      throw new DaemonError(
        'workspace_overlap',
        `atc is removing a directory on the host of session ${hostKey}; spawn again once it is done`,
        { phase: 'resolving', directory, session: hostKey },
      );
    }
  };

  const requireSeparateWorkspace = (options: RequireSeparateWorkspaceOptions): void => {
    const other = collectOtherWorkspaceDirs(
      options.id,
      options.hostKey,
      options.target,
      options.listed,
    ).find(([, path]) => options.forms.some((form) => isPathOverlapping(form, path)));

    if (other !== undefined) {
      throw new DaemonError(
        'workspace_overlap',
        `${options.directory} overlaps ${other[1]}, the directory of session ${other[0]} on the same host; a workspace there lands beside it`,
        { phase: 'resolving', directory: options.directory, session: other[0] },
      );
    }
  };

  const claimHostDir = async (options: ClaimHostDirOptions): Promise<string> => {
    const before = collectHostSessionIDs(options.hostKey, options.target);

    const physical = await resolveHostDir(options.provider, options.hostKey, options.directory);

    const listed = await resolveListedDirs(
      options.provider,
      options.hostKey,
      collectHostEntries(options.hostKey, options.target),
    );

    if (collectHostSessionIDs(options.hostKey, options.target) !== before) {
      return claimHostDir(options);
    }

    const reservation = reservations.get(options.id);

    if (reservation !== undefined || options.picked === true) {
      requireNoHostRemoval(options.hostKey, options.target, options.directory);

      requireSeparateWorkspace({
        id: options.id,
        hostKey: options.hostKey,
        target: options.target,
        directory: options.directory,
        forms: [options.directory, physical],
        listed: listed.dirs,
      });

      reservations.set(options.id, {
        hostKey: options.hostKey,
        target: options.target,
        directory: options.directory,
        resolved: physical,
        kind: 'workspace',
      });
    }

    return physical;
  };

  const withRemovalHold = async <T>(hold: RemovalHold, run: () => Promise<T>): Promise<T> => {
    if (!registry.hasHostLifecycle(hold.target)) {
      const removal = { id: hold.id, directory: hold.directory };

      machineRemovals.push(removal);

      try {
        return await run();
      } finally {
        machineRemovals.splice(machineRemovals.indexOf(removal), 1);
      }
    }

    const slot = buildHostSlot(hold.hostKey, hold.target);

    removals.set(slot, (removals.get(slot) ?? 0) + 1);

    try {
      return await run();
    } finally {
      const left = (removals.get(slot) ?? 1) - 1;

      if (left === 0) {
        removals.delete(slot);
      } else {
        removals.set(slot, left);
      }
    }
  };

  const removeClaimedDir = async (options: RemoveClaimedDirOptions): Promise<boolean> => {
    if (!registry.hasHostLifecycle(options.target)) {
      const others = collectMachineDirs(options.id);

      const resolved = await Promise.all(
        others.map(([, cwd]) => resolveHostDir(options.provider, null, cwd).catch(() => null)),
      );

      const seen = new Set(others.map(([other]) => other));

      if (collectMachineDirs(options.id).some(([other]) => !seen.has(other))) {
        return removeClaimedDir(options);
      }

      const holds = others.some(([, cwd], index) => {
        const physical = resolved[index] ?? null;

        return (
          physical === null ||
          isPathWithin(cwd, options.directory) ||
          isPathWithin(physical, options.directory)
        );
      });

      if (holds) {
        return false;
      }

      return withRemovalHold(options, async () => {
        const removed = await options.provider.runCommand({
          argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', options.directory, `${options.directory}\nx`],
          cwd: '/',
        });

        return removed.exitCode === 0;
      });
    }

    const before = collectHostSessionIDs(options.hostKey, options.target);

    const listed = await resolveListedDirs(
      options.provider,
      options.hostKey,
      collectHostEntries(options.hostKey, options.target),
    );

    const fromHome = await resolveFromHome(options.provider, options.hostKey, listed.unresolved);

    if (collectHostSessionIDs(options.hostKey, options.target) !== before) {
      return removeClaimedDir(options);
    }

    // A directory of another session that the host could not resolve may point into this one through
    // a symlink, so the directory stays in place.
    if (fromHome === null) {
      return false;
    }

    const holds = collectOtherWorkspaceDirs(options.id, options.hostKey, options.target, [
      ...listed.dirs,
      ...fromHome,
    ]).some(([, other]) => isPathWithin(other, options.directory));

    if (holds) {
      return false;
    }

    return withRemovalHold(options, async () => {
      const removed = await options.provider.runCommand({
        argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', options.directory, `${options.directory}\nx`],
        cwd: '/',
        host: options.hostKey,
      });

      return removed.exitCode === 0;
    });
  };

  return {
    reservations,

    collectHeldSessions,

    holdSessions: (sessions) => {
      const held = new Set(sessions);

      sessionHolds.add(held);

      return {
        release: (released) => {
          for (const session of released) {
            held.delete(session);
          }

          if (held.size === 0) {
            sessionHolds.delete(held);
          }
        },
      };
    },

    releaseWorkspace: (id) => {
      reservations.delete(id);
    },

    claimWorkspace: (id, hostKey, target, directory) => {
      const listed = collectSessions()
        .filter(
          (session) =>
            session.hostKey === hostKey &&
            session.target === target &&
            posix.isAbsolute(session.cwd),
        )
        .map((session) => [session.id, session.cwd] as const);

      requireNoHostRemoval(hostKey, target, directory);
      requireSeparateWorkspace({ id, hostKey, target, directory, forms: [directory], listed });

      reservations.set(id, { hostKey, target, directory, resolved: null, kind: 'workspace' });
    },

    claimPlainDir: (id, hostKey, target, directory) => {
      requireNoHostRemoval(hostKey, target, directory);

      for (const [other, reservation] of reservations) {
        if (!posix.isAbsolute(directory)) {
          break;
        }

        if (
          other !== id &&
          reservation.kind === 'workspace' &&
          reservation.hostKey === hostKey &&
          reservation.target === target &&
          [reservation.directory, reservation.resolved ?? reservation.directory].some((held) =>
            isPathOverlapping(directory, held),
          )
        ) {
          throw new DaemonError(
            'workspace_overlap',
            `${directory} overlaps ${reservation.directory}, where session ${other} is still building its workspace on the same host`,
            { phase: 'resolving', directory, session: other },
          );
        }
      }

      reservations.set(id, { hostKey, target, directory, resolved: null, kind: 'plain' });
    },

    claimMachineDir: (id, target, directory, picked) => {
      const holder = picked
        ? [...reservations].find(
            ([other, reservation]) =>
              other !== id && reservation.target === target && reservation.directory === directory,
          )
        : undefined;

      if (holder !== undefined) {
        throw new DaemonError(
          'workspace_overlap',
          `${directory} is held by session ${holder[0]}, which is still starting on the daemon host`,
          { phase: 'resolving', directory, session: holder[0] },
        );
      }

      if (machineRemovals.length > 0) {
        // Resolving a symlink blocks the daemon, so it runs only while a removal is in progress.
        const forms = posix.isAbsolute(directory)
          ? [directory, resolveMachineDir(directory)]
          : null;

        const removal = machineRemovals.find(
          (candidate) =>
            forms === null || forms.some((form) => isPathOverlapping(form, candidate.directory)),
        );

        if (removal !== undefined) {
          throw new DaemonError(
            'workspace_overlap',
            `${directory} overlaps ${removal.directory}, which atc is removing for session ${removal.id} on the daemon host; spawn again once it is done`,
            { phase: 'resolving', directory, session: removal.id },
          );
        }
      }

      reservations.set(id, { hostKey: id, target, directory, resolved: null, kind: 'plain' });
    },

    claimHostDir,

    removeClaimedDir,

    withRemovalHold,

    resolveHostDir,

    resolveHostHome,
  };
}

function buildHostSlot(hostKey: SessionID, target: string): string {
  return `${target}\0${hostKey}`;
}

function isPathOverlapping(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}
