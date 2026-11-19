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

export interface ListedSession {
  readonly id: SessionID;
  readonly cwd: string;

  readonly onMachine: boolean;
}

interface PruneSnapshot<Row extends MaterializationRow> {
  readonly rows: readonly Row[];

  readonly permanentTargets: ReadonlySet<string>;
  readonly listed: readonly ListedSession[];
  readonly spawning: ReadonlySet<SessionID>;

  readonly rootFolders: readonly string[];

  readonly stateFolders: readonly string[];
}

interface PruneCandidates<Row extends MaterializationRow> {
  readonly workspaces: readonly Row[];

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
