import { formatCommitLines } from './format-commit-lines.ts';

export interface MergeBlobsReadings {
  readonly commits: readonly string[];
  readonly promisor?: string;
  readonly merges?: string;
  readonly bases: readonly string[];

  readonly listing?: string;
  readonly diff?: string;
  readonly fetch?: string;
}

export interface MergeBlobsCommand {
  readonly reading: 'promisor' | 'merges' | 'bases' | 'listing' | 'diff' | 'fetch';
  readonly argv: readonly string[];
  readonly stdin?: string;

  // `git config --get` exits 1 for an unset key, and `git merge-base` exits 1 for parents that
  // share no commit.
  readonly exitCodes: 'any' | readonly number[];
}

// A blobless clone fetches a merge's missing blobs during the log, in one batch with the
// conflict-marked blob that the log builds in a temporary folder, and the server refuses the whole
// batch. Fetching the blobs first leaves the log nothing to ask for.
export function pickMergeBlobsCommand(readings: MergeBlobsReadings): MergeBlobsCommand | null {
  if (readings.promisor === undefined) {
    return {
      reading: 'promisor',
      argv: ['git', 'config', '--type=bool', '--get', 'remote.origin.promisor'],
      exitCodes: 'any',
    };
  }

  if (readings.promisor.trim() !== 'true') {
    return null;
  }

  if (readings.merges === undefined) {
    return {
      reading: 'merges',
      argv: ['git', 'rev-list', '--merges', '--parents', '--no-walk=unsorted', '--stdin'],
      stdin: formatCommitLines(readings.commits),
      exitCodes: [0],
    };
  }

  const merges = splitLines(readings.merges).map((line) => line.split(' '));
  const pending = merges[readings.bases.length];

  if (pending !== undefined) {
    return {
      reading: 'bases',
      argv: ['git', 'merge-base', '--all', ...pending.slice(1)],
      exitCodes: [0, 1],
    };
  }

  const pairs = merges.flatMap((mergeAndParents, index) =>
    splitLines(readings.bases[index] ?? '').flatMap((base) =>
      mergeAndParents.map((commit) => `${base} ${commit}\n`),
    ),
  );

  if (pairs.length === 0) {
    return null;
  }

  if (readings.listing === undefined) {
    const pairCommits = new Set(pairs.flatMap((pair) => pair.trim().split(' ')));

    // A blob ID on the command line makes git 2.43's rev-list die when the blob is missing, so the
    // listing starts from the commits instead.
    return {
      reading: 'listing',
      argv: ['git', 'rev-list', '--objects', '--missing=print', '--no-walk', '--stdin'],
      stdin: formatCommitLines([...pairCommits]),
      exitCodes: [0],
    };
  }

  if (readings.diff === undefined) {
    return {
      reading: 'diff',
      argv: ['git', 'diff-tree', '-r', '--no-abbrev', '--stdin'],
      stdin: pairs.join(''),
      exitCodes: [0],
    };
  }

  const missing = new Set(
    splitLines(readings.listing)
      .filter((line) => line.startsWith('?'))
      .map((line) => line.slice(1)),
  );

  // The server refuses the whole fetch when it asks for a blob that only this clone holds.
  const blobs = collectBlobIDs(readings.diff).filter((blob) => missing.has(blob));

  if (blobs.length === 0 || readings.fetch !== undefined) {
    return null;
  }

  return {
    reading: 'fetch',
    argv: [
      'git',
      '-c',
      'fetch.negotiationAlgorithm=noop',
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--filter=blob:none',
      '--stdin',
      'origin',
    ],
    stdin: blobs.map((blob) => `${blob}\n`).join(''),
    exitCodes: [0],
  };
}

function splitLines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

const blobModes = new Set(['100644', '100755', '120000']);

// Each raw line reads `:<old mode> <new mode> <old id> <new id> <status>\t<path>`.
function collectBlobIDs(rawDiff: string): string[] {
  const blobs = new Set<string>();

  for (const line of rawDiff.split('\n')) {
    if (!line.startsWith(':')) {
      continue;
    }

    const [oldMode, newMode, oldBlob, newBlob] = line.slice(1).split(' ');

    for (const [mode, blob] of [
      [oldMode, oldBlob],
      [newMode, newBlob],
    ]) {
      if (mode !== undefined && blob !== undefined && blobModes.has(mode)) {
        blobs.add(blob);
      }
    }
  }

  return [...blobs];
}
