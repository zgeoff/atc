import { posix } from 'node:path';
import type { SessionID } from '@atcx/contract';
import { toSessionID } from '@atcx/contract';
import { isPathWithin } from './is-path-within';

interface MaterializationRow {
  readonly sessionID: SessionID;
  readonly target: string;
  readonly directory: string;
  readonly phase: string;
  readonly sha: string | null;
}

// A session the fleet lists, or one a kill or forget still holds, and the folder it runs in.
interface ListedSession {
  readonly id: SessionID;
  readonly cwd: string;

  // Whether its target runs on the daemon's machine, where the folder is the one a row names.
  readonly onMachine: boolean;
}

interface PruneSnapshot<Row extends MaterializationRow> {
  // Every materialization row, oldest first.
  readonly rows: readonly Row[];

  // The targets whose hosts are permanent, which a prune covers.
  readonly permanentTargets: ReadonlySet<string>;
  readonly listed: readonly ListedSession[];
  readonly spawning: ReadonlySet<SessionID>;

  // The folders directly under the workspaces root of each permanent target.
  readonly rootFolders: readonly string[];

  // The names of the folders under the state folder's `sessions/`.
  readonly stateFolders: readonly string[];
}

interface PruneCandidates<Row extends MaterializationRow> {
  // The newest ready row of each folder no listed session or spawn owns, to check.
  readonly workspaces: readonly Row[];

  // The folders under a workspaces root that a prune leaves, each with why.
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];

  readonly states: readonly SessionID[];
}

const NO_RECORD_REASON = 'no atc record';
const UNFINISHED_REASON = 'atc never finished building it';

export function collectPruneCandidates<Row extends MaterializationRow>(
  snapshot: PruneSnapshot<Row>,
): PruneCandidates<Row> {
  const owners = new Set<string>([
    ...snapshot.listed.map((session) => session.id),
    ...snapshot.spawning,
  ]);

  const rowsByDir = Map.groupBy(
    snapshot.rows.filter((row) => snapshot.permanentTargets.has(row.target)),
    (row) => toFolderKey(row.directory),
  );

  // a folder stays whole while any row's session still lists or spawns, or any listed session
  // runs inside it, whichever row is newest
  const workspaces = [...rowsByDir].flatMap(([directory, rows]) => {
    const ready = rows.findLast((row) => row.phase === 'ready');

    const owned =
      rows.some((row) => owners.has(row.sessionID)) ||
      snapshot.listed.some((session) => session.onMachine && isPathWithin(session.cwd, directory));

    return ready === undefined || owned ? [] : [ready];
  });

  const skipped = [...new Set(snapshot.rootFolders.map((path) => toFolderKey(path)))].flatMap(
    (path) => {
      const rows = rowsByDir.get(path);

      if (rows === undefined) {
        return [{ path, reason: NO_RECORD_REASON }];
      }

      return rows.some((row) => row.phase === 'ready') ? [] : [{ path, reason: UNFINISHED_REASON }];
    },
  );

  const states = snapshot.stateFolders
    .filter((name) => !owners.has(name))
    .map((name) => toSessionID(name));

  return { workspaces, skipped, states };
}

function toFolderKey(directory: string): string {
  const normalized = posix.normalize(directory);

  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}
