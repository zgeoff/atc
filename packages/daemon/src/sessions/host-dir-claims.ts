import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import type { SessionID } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionRegistry } from './session-registry';

// A workspace directory a spawn on a shared host holds, as the spawn gave
// it and as the host resolves it once checked there.
export interface WorkspaceReservation {
  readonly hostKey: SessionID;
  readonly target: string;
  dir: string;
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

// Prints the home directory of the user it runs as, with every symlink in
// it resolved.
export const RESOLVE_HOME_SCRIPT = 'cd && pwd -P';

interface HostDirClaimsDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'hasHostLifecycle'>;
}

export class HostDirClaims {
  // The workspace directory each spawn on a shared host, and each plain
  // spawn on the daemon's own machine, holds from its overlap check until
  // its session lists or its spawn fails, by spawn id.
  readonly reservations = new Map<SessionID, WorkspaceReservation>();

  // The shared hosts with a workspace rollback removing a directory now,
  // each with how many removals run there.
  private readonly removals = new Map<string, number>();

  // The directories workspace rollbacks remove on the daemon's own machine
  // now, each with the spawn whose rollback removes it.
  private readonly machineRemovals: { readonly id: SessionID; readonly dir: string }[] = [];

  private readonly registry: HostDirClaimsDeps['registry'];

  constructor(deps: HostDirClaimsDeps) {
    this.registry = deps.registry;
  }

  // a failed spawn whose effects may still stand keeps its reservation, so no other workspace
  // lands in or around what it left
  releaseWorkspace(id: SessionID): void {
    this.reservations.delete(id);
  }

  // the check and the reservation run in one turn, so of two concurrent spawns at most one passes
  claimWorkspace(id: SessionID, hostKey: SessionID, target: string, dir: string): void {
    const listed = this.registry.sessions
      .filter((s) => s.hostKey === hostKey && s.target === target && posix.isAbsolute(s.cwd))
      .map((s) => [s.id, s.cwd] as const);

    this.requireSeparateWorkspace(id, hostKey, target, dir, [dir], listed);
    this.reservations.set(id, { hostKey, target, dir, resolved: null, kind: 'workspace' });
  }

  claimPlainDir(id: SessionID, hostKey: SessionID, target: string, dir: string): void {
    // a plain directory may reach the one a rollback is removing through a symlink no check has
    // resolved yet, so every plain spawn on the host waits for the removal
    if ((this.removals.get(buildHostSlot(hostKey, target)) ?? 0) > 0) {
      throw new DaemonError(
        'workspace_overlap',
        `a failed workspace spawn is removing its directory on the host of session ${hostKey}; spawn again once it is done`,
        { phase: 'resolving', dir, session: hostKey },
      );
    }

    // a workspace still being built may be removed by its rollback; plain spawns share freely
    for (const [other, r] of this.reservations) {
      if (!posix.isAbsolute(dir)) {
        break;
      }

      if (
        other !== id &&
        r.kind === 'workspace' &&
        r.hostKey === hostKey &&
        r.target === target &&
        [r.dir, r.resolved ?? r.dir].some((held) => isPathOverlapping(dir, held))
      ) {
        throw new DaemonError(
          'workspace_overlap',
          `${dir} overlaps ${r.dir}, where session ${other} is still building its workspace on the same host`,
          { phase: 'resolving', dir, session: other },
        );
      }
    }

    this.reservations.set(id, { hostKey, target, dir, resolved: null, kind: 'plain' });
  }

  // the check and the hold run in one turn: a running rollback resolves each held directory and
  // keeps a directory that holds one
  claimMachineDir(id: SessionID, target: string, dir: string): void {
    if (this.machineRemovals.length > 0) {
      // symlinks are resolved only while a removal runs, since resolving blocks the daemon; a
      // relative directory is refused while any removal runs
      const forms = posix.isAbsolute(dir) ? [dir, resolveMachineDir(dir)] : null;

      const removal = this.machineRemovals.find(
        (r) => forms === null || forms.some((form) => isPathOverlapping(form, r.dir)),
      );

      if (removal !== undefined) {
        throw new DaemonError(
          'workspace_overlap',
          `${dir} overlaps ${removal.dir}, which the failed workspace spawn of session ${removal.id} is removing on the daemon host; spawn again once it is done`,
          { phase: 'resolving', dir, session: removal.id },
        );
      }
    }

    this.reservations.set(id, { hostKey: id, target, dir, resolved: null, kind: 'plain' });
  }

  // every later step creates, fills, and removes the physical path this resolves to, never the
  // requested one
  async claimHostDir(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    dir: string,
    picked = false,
  ): Promise<string> {
    const before = this.collectHostSessionIDs(hostKey, target);

    const physical = await this.resolveHostDir(provider, hostKey, dir);
    const listed = await this.resolveListedDirs(provider, hostKey, target);

    // the claim is checked in the turn after the last wait, against the sessions listed then
    if (this.collectHostSessionIDs(hostKey, target) !== before) {
      return this.claimHostDir(provider, id, hostKey, target, dir, picked);
    }

    const reservation = this.reservations.get(id);

    // a picked directory is reserved only here, once checked, so two spawns that picked the same
    // one never refuse each other before either holds it
    if (reservation !== undefined || picked) {
      this.requireSeparateWorkspace(id, hostKey, target, dir, [dir, physical], listed.dirs);
      this.reservations.set(id, { hostKey, target, dir, resolved: physical, kind: 'workspace' });
    }

    return physical;
  }

  // removes nothing while the directory, as resolved in the turn after the last wait, holds a
  // listed session's or another claim's directory, or no longer resolves to itself; it then
  // stays for an operator to remove
  async removeClaimedDir(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    dir: string,
  ): Promise<boolean> {
    // targets without hosts run on the daemon's machine, so the directory stays while a session on
    // any of them, or a plain spawn starting there, runs inside; while the removal runs, a plain
    // spawn there inside or around the directory is refused
    if (!this.registry.hasHostLifecycle(target)) {
      const others = this.collectMachineDirs(id);

      const resolved = await Promise.all(
        others.map(([, cwd]) => this.resolveHostDir(provider, null, cwd).catch(() => null)),
      );

      const seen = new Set(others.map(([other]) => other));

      if (this.collectMachineDirs(id).some(([other]) => !seen.has(other))) {
        return this.removeClaimedDir(provider, id, hostKey, target, dir);
      }

      const holds = others.some(([, cwd], index) => {
        const physical = resolved[index] ?? null;

        return physical === null || isPathWithin(cwd, dir) || isPathWithin(physical, dir);
      });

      if (holds) {
        return false;
      }

      const removal = { id, dir };

      this.machineRemovals.push(removal);

      try {
        const removed = await provider.runCommand({
          argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', dir, `${dir}\nx`],
          cwd: '/',
        });

        return removed.exitCode === 0;
      } finally {
        this.machineRemovals.splice(this.machineRemovals.indexOf(removal), 1);
      }
    }

    const before = this.collectHostSessionIDs(hostKey, target);

    const listed = await this.resolveListedDirs(provider, hostKey, target);
    const fromHome = await this.resolveFromHome(provider, hostKey, listed.unresolved);

    if (this.collectHostSessionIDs(hostKey, target) !== before) {
      return this.removeClaimedDir(provider, id, hostKey, target, dir);
    }

    // A directory the host could not resolve, even from its home, may lie
    // inside through a symlink, so the rollback keeps its own.
    if (fromHome === null) {
      return false;
    }

    const holds = this.collectOtherWorkspaceDirs(id, hostKey, target, [
      ...listed.dirs,
      ...fromHome,
    ]).some(([, other]) => isPathWithin(other, dir));

    if (holds) {
      return false;
    }

    const slot = buildHostSlot(hostKey, target);

    this.removals.set(slot, (this.removals.get(slot) ?? 0) + 1);

    try {
      const removed = await provider.runCommand({
        argv: ['sh', '-c', REMOVE_DIR_SCRIPT, 'sh', dir, `${dir}\nx`],
        cwd: '/',
        host: hostKey,
      });

      return removed.exitCode === 0;
    } finally {
      const left = (this.removals.get(slot) ?? 1) - 1;

      if (left === 0) {
        this.removals.delete(slot);
      } else {
        this.removals.set(slot, left);
      }
    }
  }

  // The ids of the sessions listed on a host and of the plain spawns still
  // starting there, as one string a later read compares against.
  private collectHostSessionIDs(hostKey: SessionID, target: string): string {
    return [
      ...this.registry.sessions
        .filter((s) => s.hostKey === hostKey && s.target === target)
        .map((s) => s.id),
      ...this.collectPlainDirs(hostKey, target).map(([id]) => id),
    ].join(' ');
  }

  // The directories plain spawns still starting on a host hold, as given.
  private collectPlainDirs(hostKey: SessionID, target: string): (readonly [SessionID, string])[] {
    return [...this.reservations]
      .filter(([, r]) => r.kind === 'plain' && r.hostKey === hostKey && r.target === target)
      .map(([id, r]) => [id, r.dir] as const);
  }

  // The directories sessions on the daemon's own machine hold, other than
  // the given spawn's: every session listed on a target without hosts, and
  // every plain spawn still starting there, as given.
  private collectMachineDirs(id: SessionID): (readonly [SessionID, string])[] {
    return [
      ...this.registry.sessions
        .filter((s) => s.id !== id && !this.registry.hasHostLifecycle(s.target))
        .map((s) => [s.id, s.cwd] as const),
      ...[...this.reservations]
        .filter(
          ([other, r]) =>
            other !== id && r.kind === 'plain' && !this.registry.hasHostLifecycle(r.target),
        )
        .map(([other, r]) => [other, r.dir] as const),
    ];
  }

  private requireSeparateWorkspace(
    id: SessionID,
    hostKey: SessionID,
    target: string,
    dir: string,
    forms: readonly string[],
    listed: readonly (readonly [SessionID, string])[],
  ): void {
    const other = this.collectOtherWorkspaceDirs(id, hostKey, target, listed).find(([, path]) =>
      forms.some((form) => isPathOverlapping(form, path)),
    );

    if (other !== undefined) {
      throw new DaemonError(
        'workspace_overlap',
        `${dir} overlaps ${other[1]}, the directory of session ${other[0]} on the same host; a workspace there lands beside it`,
        { phase: 'resolving', dir, session: other[0] },
      );
    }
  }

  // The directories other sessions on a host hold: the listed ones given,
  // and every other spawn's reservation in each form it has.
  private collectOtherWorkspaceDirs(
    id: SessionID,
    hostKey: SessionID,
    target: string,
    listed: readonly (readonly [SessionID, string])[],
  ): (readonly [SessionID, string])[] {
    const dirs = [...listed];

    for (const [other, r] of this.reservations) {
      if (other !== id && r.hostKey === hostKey && r.target === target) {
        // A relative plain directory counts only once the host resolves
        // it, since it resolves against the session's home there.
        dirs.push(
          ...[r.dir, r.resolved ?? r.dir]
            .filter((held) => posix.isAbsolute(held))
            .map((held) => [other, held] as const),
        );
      }
    }

    return dirs;
  }

  // The directory of every session listed on a host, and of every plain
  // spawn still starting there, as the host resolves it, and its own
  // absolute form, and the entries that failed to resolve.
  private async resolveListedDirs(
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
  ): Promise<{
    readonly dirs: (readonly [SessionID, string])[];
    readonly unresolved: (readonly [SessionID, string])[];
  }> {
    const onHost = [
      ...this.registry.sessions.filter((s) => s.hostKey === hostKey && s.target === target),
      ...this.collectPlainDirs(hostKey, target).map(([id, cwd]) => ({ id, cwd })),
    ];

    const resolved = await Promise.all(
      onHost.map(async (s) => {
        const dir = await this.resolveHostDir(provider, hostKey, s.cwd).catch(() => null);

        const dirs: (readonly [SessionID, string])[] = [];

        if (posix.isAbsolute(s.cwd)) {
          dirs.push([s.id, s.cwd]);
        }

        if (dir !== null) {
          dirs.push([s.id, dir]);
        }

        return { dirs, unresolved: dir === null ? [[s.id, s.cwd] as const] : [] };
      }),
    );

    return {
      dirs: resolved.flatMap((r) => r.dirs),
      unresolved: resolved.flatMap((r) => r.unresolved),
    };
  }

  // null when any entry may lie anywhere; a relative one that cannot be entered, such as one
  // removed inside the guest, resolves from the host's home unless a missing part is a symlink
  private async resolveFromHome(
    provider: ExecutionProvider,
    hostKey: SessionID,
    unresolved: readonly (readonly [SessionID, string])[],
  ): Promise<(readonly [SessionID, string])[] | null> {
    if (unresolved.length === 0) {
      return [];
    }

    // an absolute directory was resolved that way already, and the host follows `..` through
    // symlinks rather than lexically, so either stays unknown
    if (unresolved.some(([, cwd]) => posix.isAbsolute(cwd) || cwd.split('/').includes('..'))) {
      return null;
    }

    const home = await this.resolveHostHome(provider, hostKey).catch(() => null);

    if (home === null) {
      return null;
    }

    const resolved = await Promise.all(
      unresolved.map(async ([id, cwd]) => {
        const absolute = posix.join(home, cwd);

        const physical = await this.resolveHostDir(
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

    return resolved.some((r) => r === null) ? null : resolved.flatMap((r) => r ?? []);
  }

  // a relative directory resolves as a harness started in it sees it, since the provider starts
  // both from the home of the user they run as; a stricter script must print the same form
  async resolveHostDir(
    provider: ExecutionProvider,
    hostKey: SessionID | null,
    dir: string,
    script: string = RESOLVE_DIR_SCRIPT,
  ): Promise<string> {
    const absolute = posix.isAbsolute(dir);

    const result = await provider.runCommand({
      argv: ['sh', '-c', script, 'sh', absolute ? posix.normalize(dir) : '.'],
      cwd: absolute ? '/' : dir,
      ...(hostKey === null ? {} : { host: hostKey }),
    });

    const split = result.stdout.lastIndexOf('\0');

    if (result.exitCode !== 0 || split < 1 || result.stdout[split - 1] !== '\n') {
      throw new DaemonError(
        'host_unavailable',
        `${hostKey === null ? 'the daemon host' : `the host of session ${hostKey}`} cannot resolve ${dir}: ${result.stderr.trim()}`,
        { phase: 'resolving', dir },
      );
    }

    const existing = result.stdout.slice(0, split - 1);
    const rest = result.stdout.slice(split + 1);

    return existing === '/' ? rest || '/' : `${existing}${rest}`;
  }

  // The home directory of the user commands run as on a host, with every
  // symlink in it resolved.
  async resolveHostHome(provider: ExecutionProvider, hostKey: SessionID): Promise<string> {
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
}

// The key of a shared host on one target, for state kept per host.
function buildHostSlot(hostKey: SessionID, target: string): string {
  return `${target}\0${hostKey}`;
}

// Whether either of two directories on a host holds the other, or they are
// the same.
function isPathOverlapping(a: string, b: string): boolean {
  return isPathWithin(a, b) || isPathWithin(b, a);
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = posix.relative(parent, child);

  return relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative);
}

// An absolute directory on the daemon's own machine with every symlink in
// it resolved, through its nearest existing directory.
function resolveMachineDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    const parent = posix.dirname(dir);

    return parent === dir ? dir : posix.join(resolveMachineDir(parent), posix.basename(dir));
  }
}
