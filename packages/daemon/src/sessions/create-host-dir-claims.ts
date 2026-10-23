import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import type { SessionID } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionRegistry } from './create-session-registry';

// A workspace directory a spawn on a shared host holds, as the spawn gave
// it and as the host resolves it once checked there.
interface WorkspaceReservation {
  readonly hostKey: SessionID;
  readonly target: string;
  directory: string;
  resolved: string | null;

  // A workspace spawn builds its directory and may remove it on a failure;
  // a plain spawn only starts in its directory, which another plain spawn
  // may share.
  readonly kind: 'workspace' | 'plain';
}

// prints the nearest existing directory with every symlink resolved and a newline, which keeps a
// name ending in newlines whole, then a NUL and the rest of the path as given
export const RESOLVE_DIR_SCRIPT = `p=$1; s=; while [ ! -d "$p" ]; do s=/\${p##*/}$s; p=\${p%/*}; [ -n "$p" ] || p=/; done; cd -P -- "$p" && pwd -P && printf '\\0%s' "$s"`;

// Resolves a directory as the script above does, but fails when any part
// of it that is not an existing directory is a symlink, such as one whose
// target was removed, since the directory it stands for could lie anywhere.
export const RESOLVE_UNLINKED_DIR_SCRIPT = `p=$1; while [ ! -d "$p" ]; do [ ! -L "$p" ] || exit 6; p=\${p%/*}; [ -n "$p" ] || p=/; done; ${RESOLVE_DIR_SCRIPT}`;

// removes a directory only while it still resolves to itself, emptying it from inside so no
// symlink changed on the way is followed, then removing it once empty
export const REMOVE_DIR_SCRIPT =
  'cd -P -- "$1" || exit 3; [ "$(pwd -P; printf x)" = "$2" ] || exit 4; find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || exit 5; cd / && rmdir -- "$1"';

interface RemoveClaimedDirOptions {
  readonly provider: ExecutionProvider;
  readonly id: SessionID;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly directory: string;
}

interface ClaimHostDirOptions extends RemoveClaimedDirOptions {
  readonly picked?: boolean;
}

interface HostDirClaimsDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'hasHostLifecycle'>;
}

export interface HostDirClaims {
  // The workspace directory each spawn on a shared host, and each plain
  // spawn on the daemon's own machine, holds from its overlap check until
  // its session lists or its spawn fails, by spawn id.
  readonly reservations: Map<SessionID, WorkspaceReservation>;

  // a failed spawn whose effects may still stand keeps its reservation, so no other workspace
  // lands in or around what it left
  readonly releaseWorkspace: (id: SessionID) => void;

  // the check and the reservation run in one turn, so of two concurrent spawns at most one passes
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

  // the check and the hold run in one turn: a running rollback resolves each held directory and
  // keeps a directory that holds one
  readonly claimMachineDir: (id: SessionID, target: string, directory: string) => void;

  // every later step creates, fills, and removes the physical path this resolves to, never the
  // requested one
  readonly claimHostDir: (options: ClaimHostDirOptions) => Promise<string>;

  // removes nothing while the directory, as resolved in the turn after the last wait, holds a
  // listed session's or another claim's directory, or no longer resolves to itself; it then
  // stays for an operator to remove
  readonly removeClaimedDir: (options: RemoveClaimedDirOptions) => Promise<boolean>;

  // a relative directory resolves as a harness started in it sees it, since the provider starts
  // both from the home of the user they run as; a stricter script must print the same form
  readonly resolveHostDir: (
    provider: ExecutionProvider,
    hostKey: SessionID | null,
    directory: string,
    script?: string,
  ) => Promise<string>;

  // The home directory of the user commands run as on a host, with every
  // symlink in it resolved.
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

  // The shared hosts with a workspace rollback removing a directory now,
  // each with how many removals run there.
  const removals = new Map<string, number>();

  // The directories workspace rollbacks remove on the daemon's own machine
  // now, each with the spawn whose rollback removes it.
  const machineRemovals: { readonly id: SessionID; readonly directory: string }[] = [];
  const registry = deps.registry;

  // The directories plain spawns still starting on a host hold, as given.
  const collectPlainDirs = (hostKey: SessionID, target: string): (readonly [SessionID, string])[] =>
    [...reservations]
      .filter(
        ([, reservation]) =>
          reservation.kind === 'plain' &&
          reservation.hostKey === hostKey &&
          reservation.target === target,
      )
      .map(([id, reservation]) => [id, reservation.directory] as const);

  // The ids of the sessions listed on a host and of the plain spawns still
  // starting there, as one string a later read compares against.
  const collectHostSessionIDs = (hostKey: SessionID, target: string): string =>
    [
      ...registry.sessions
        .filter((session) => session.hostKey === hostKey && session.target === target)
        .map((session) => session.id),
      ...collectPlainDirs(hostKey, target).map(([id]) => id),
    ].join(' ');

  // The directories sessions on the daemon's own machine hold, other than
  // the given spawn's: every session listed on a target without hosts, and
  // every plain spawn still starting there, as given.
  const collectMachineDirs = (id: SessionID): (readonly [SessionID, string])[] => [
    ...registry.sessions
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

  // The directories other sessions on a host hold: the listed ones given,
  // and every other spawn's reservation in each form it has.
  const collectOtherWorkspaceDirs = (
    id: SessionID,
    hostKey: SessionID,
    target: string,
    listed: readonly (readonly [SessionID, string])[],
  ): (readonly [SessionID, string])[] => {
    const dirs = [...listed];

    for (const [other, reservation] of reservations) {
      if (other !== id && reservation.hostKey === hostKey && reservation.target === target) {
        // A relative plain directory counts only once the host resolves
        // it, since it resolves against the session's home there.
        dirs.push(
          ...[reservation.directory, reservation.resolved ?? reservation.directory]
            .filter((held) => posix.isAbsolute(held))
            .map((held) => [other, held] as const),
        );
      }
    }

    return dirs;
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

  // The directory of every session listed on a host, and of every plain
  // spawn still starting there, as the host resolves it, and its own
  // absolute form, and the entries that failed to resolve.
  const resolveListedDirs = async (
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
  ): Promise<{
    readonly dirs: (readonly [SessionID, string])[];
    readonly unresolved: (readonly [SessionID, string])[];
  }> => {
    const onHost = [
      ...registry.sessions.filter(
        (session) => session.hostKey === hostKey && session.target === target,
      ),
      ...collectPlainDirs(hostKey, target).map(([id, cwd]) => ({ id, cwd })),
    ];

    const resolved = await Promise.all(
      onHost.map(async (entry) => {
        const directory = await resolveHostDir(provider, hostKey, entry.cwd).catch(() => null);

        const dirs: (readonly [SessionID, string])[] = [];

        if (posix.isAbsolute(entry.cwd)) {
          dirs.push([entry.id, entry.cwd]);
        }

        if (directory !== null) {
          dirs.push([entry.id, directory]);
        }

        return { dirs, unresolved: directory === null ? [[entry.id, entry.cwd] as const] : [] };
      }),
    );

    return {
      dirs: resolved.flatMap((resolution) => resolution.dirs),
      unresolved: resolved.flatMap((resolution) => resolution.unresolved),
    };
  };

  // null when any entry may lie anywhere; a relative one that cannot be entered, such as one
  // removed inside the guest, resolves from the host's home unless a missing part is a symlink
  const resolveFromHome = async (
    provider: ExecutionProvider,
    hostKey: SessionID,
    unresolved: readonly (readonly [SessionID, string])[],
  ): Promise<(readonly [SessionID, string])[] | null> => {
    if (unresolved.length === 0) {
      return [];
    }

    // an absolute directory was resolved that way already, and the host follows `..` through
    // symlinks rather than lexically, so either stays unknown
    if (unresolved.some(([, cwd]) => posix.isAbsolute(cwd) || cwd.split('/').includes('..'))) {
      return null;
    }

    const home = await resolveHostHome(provider, hostKey).catch(() => null);

    if (home === null) {
      return null;
    }

    const resolved = await Promise.all(
      unresolved.map(async ([id, cwd]) => {
        const absolute = posix.join(home, cwd);

        const physical = await resolveHostDir(
          provider,
          hostKey,
          absolute,
          RESOLVE_UNLINKED_DIR_SCRIPT,
        ).catch(() => null);

        return physical === null
          ? null
          : ([
              [id, absolute],
              [id, physical],
            ] as const);
      }),
    );

    return resolved.some((resolution) => resolution === null)
      ? null
      : resolved.flatMap((resolution) => resolution ?? []);
  };

  const claimHostDir = async (options: ClaimHostDirOptions): Promise<string> => {
    const before = collectHostSessionIDs(options.hostKey, options.target);

    const physical = await resolveHostDir(options.provider, options.hostKey, options.directory);
    const listed = await resolveListedDirs(options.provider, options.hostKey, options.target);

    // the claim is checked in the turn after the last wait, against the sessions listed then
    if (collectHostSessionIDs(options.hostKey, options.target) !== before) {
      return claimHostDir(options);
    }

    const reservation = reservations.get(options.id);

    // a picked directory is reserved only here, once checked, so two spawns that picked the same
    // one never refuse each other before either holds it
    if (reservation !== undefined || options.picked === true) {
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

  const removeClaimedDir = async (options: RemoveClaimedDirOptions): Promise<boolean> => {
    // targets without hosts run on the daemon's machine, so the directory stays while a session on
    // any of them, or a plain spawn starting there, runs inside; while the removal runs, a plain
    // spawn there inside or around the directory is refused
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

      const removal = { id: options.id, directory: options.directory };

      machineRemovals.push(removal);

      try {
        const removed = await options.provider.runCommand({
          argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', options.directory, `${options.directory}\nx`],
          cwd: '/',
        });

        return removed.exitCode === 0;
      } finally {
        machineRemovals.splice(machineRemovals.indexOf(removal), 1);
      }
    }

    const before = collectHostSessionIDs(options.hostKey, options.target);

    const listed = await resolveListedDirs(options.provider, options.hostKey, options.target);
    const fromHome = await resolveFromHome(options.provider, options.hostKey, listed.unresolved);

    if (collectHostSessionIDs(options.hostKey, options.target) !== before) {
      return removeClaimedDir(options);
    }

    // A directory the host could not resolve, even from its home, may lie
    // inside through a symlink, so the rollback keeps its own.
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

    const slot = buildHostSlot(options.hostKey, options.target);

    removals.set(slot, (removals.get(slot) ?? 0) + 1);

    try {
      const removed = await options.provider.runCommand({
        argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', options.directory, `${options.directory}\nx`],
        cwd: '/',
        host: options.hostKey,
      });

      return removed.exitCode === 0;
    } finally {
      const left = (removals.get(slot) ?? 1) - 1;

      if (left === 0) {
        removals.delete(slot);
      } else {
        removals.set(slot, left);
      }
    }
  };

  return {
    reservations,

    releaseWorkspace: (id) => {
      reservations.delete(id);
    },

    claimWorkspace: (id, hostKey, target, directory) => {
      const listed = registry.sessions
        .filter(
          (session) =>
            session.hostKey === hostKey &&
            session.target === target &&
            posix.isAbsolute(session.cwd),
        )
        .map((session) => [session.id, session.cwd] as const);

      requireSeparateWorkspace({ id, hostKey, target, directory, forms: [directory], listed });

      reservations.set(id, { hostKey, target, directory, resolved: null, kind: 'workspace' });
    },

    claimPlainDir: (id, hostKey, target, directory) => {
      // a plain directory may reach the one a rollback is removing through a symlink no check has
      // resolved yet, so every plain spawn on the host waits for the removal
      if ((removals.get(buildHostSlot(hostKey, target)) ?? 0) > 0) {
        throw new DaemonError(
          'workspace_overlap',
          `a failed workspace spawn is removing its directory on the host of session ${hostKey}; spawn again once it is done`,
          { phase: 'resolving', directory, session: hostKey },
        );
      }

      // a workspace still being built may be removed by its rollback; plain spawns share freely
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

    claimMachineDir: (id, target, directory) => {
      if (machineRemovals.length > 0) {
        // symlinks are resolved only while a removal runs, since resolving blocks the daemon; a
        // relative directory is refused while any removal runs
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
            `${directory} overlaps ${removal.directory}, which the failed workspace spawn of session ${removal.id} is removing on the daemon host; spawn again once it is done`,
            { phase: 'resolving', directory, session: removal.id },
          );
        }
      }

      reservations.set(id, { hostKey: id, target, directory, resolved: null, kind: 'plain' });
    },

    claimHostDir,

    removeClaimedDir,

    resolveHostDir,

    resolveHostHome,
  };
}

// Whether either of two directories on a host holds the other, or they are
// the same.
function isPathOverlapping(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = posix.relative(parent, child);

  return relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative);
}

async function resolveHostDir(
  provider: ExecutionProvider,
  hostKey: SessionID | null,
  directory: string,
  script: string = RESOLVE_DIR_SCRIPT,
): Promise<string> {
  const absolute = posix.isAbsolute(directory);

  const result = await provider.runCommand({
    argv: ['sh', '-c', script, 'sh', absolute ? posix.normalize(directory) : '.'],
    cwd: absolute ? '/' : directory,
    ...(hostKey === null ? {} : { host: hostKey }),
  });

  const split = result.stdout.lastIndexOf('\0');

  if (result.exitCode !== 0 || split < 1 || result.stdout[split - 1] !== '\n') {
    throw new DaemonError(
      'host_unavailable',
      `${hostKey === null ? 'the daemon host' : `the host of session ${hostKey}`} cannot resolve ${directory}: ${result.stderr.trim()}`,
      { phase: 'resolving', directory },
    );
  }

  const existing = result.stdout.slice(0, split - 1);
  const rest = result.stdout.slice(split + 1);

  return existing === '/' ? rest || '/' : `${existing}${rest}`;
}

// Prints the home directory of the user it runs as, with every symlink in
// it resolved.
export const RESOLVE_HOME_SCRIPT = 'cd && pwd -P';

async function resolveHostHome(provider: ExecutionProvider, hostKey: SessionID): Promise<string> {
  const result = await provider.runCommand({
    argv: ['sh', '-c', RESOLVE_HOME_SCRIPT],
    cwd: '/',
    host: hostKey,
  });

  const home = result.stdout.replace(/\n$/u, '');

  if (result.exitCode !== 0 || !posix.isAbsolute(home)) {
    throw new DaemonError(
      'host_unavailable',
      `the host of session ${hostKey} cannot resolve its home directory: ${result.stderr.trim()}`,
      { phase: 'resolving' },
    );
  }

  return home;
}

// The key of a shared host on one target, for state kept per host.
function buildHostSlot(hostKey: SessionID, target: string): string {
  return `${target}\0${hostKey}`;
}

// An absolute directory on the daemon's own machine with every symlink in
// it resolved, through its nearest existing directory.
function resolveMachineDir(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    const parent = posix.dirname(directory);

    return parent === directory
      ? directory
      : posix.join(resolveMachineDir(parent), posix.basename(directory));
  }
}
