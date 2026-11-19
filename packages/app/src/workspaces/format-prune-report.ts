import { posix } from 'node:path';
import type { WorkspacePrune, WorkspacePruneFolder } from '@atcx/contract';
import { match } from 'ts-pattern';

type RemovableFolder = Extract<WorkspacePruneFolder, { verdict: 'remove' }>;

interface ReportRow {
  readonly verdict: string;
  readonly name: string;
  readonly size: string;
  readonly detail: string;
}

// The lines `atc workspaces prune` prints: one per workspace, one per state folder it kept, one
// for the state folders it removes, and a total.
export function formatPruneReport(prune: WorkspacePrune): string[] {
  const removeLabel = prune.dryRun ? 'remove' : 'removed';

  const removable = prune.folders.filter(
    (folder): folder is RemovableFolder => folder.verdict === 'remove',
  );

  const removedStates = removable.filter((folder) => folder.kind === 'state');
  const removedWorkspaces = removable.filter((folder) => folder.kind === 'workspace');

  const rows: ReportRow[] = prune.folders.flatMap((folder) =>
    match(folder)
      .returnType<ReportRow[]>()
      .with({ kind: 'state', verdict: 'remove' }, () => [])
      .with({ verdict: 'remove' }, (workspace) => [
        {
          verdict: removeLabel,
          name: posix.basename(workspace.path),
          size: formatBytes(workspace.bytes),
          detail: workspace.found.length === 0 ? 'clean' : workspace.found.join('; '),
        },
      ])
      .with({ verdict: 'keep' }, (kept) => [
        {
          verdict: 'keep',
          name:
            kept.kind === 'state'
              ? `state ${posix.basename(kept.path)}`
              : posix.basename(kept.path),
          size: formatBytes(kept.bytes),
          detail: kept.reasons.join('; '),
        },
      ])
      .with({ verdict: 'skip' }, (skipped) => [
        { verdict: 'skip', name: posix.basename(skipped.path), size: '', detail: skipped.reason },
      ])
      .exhaustive(),
  );

  if (removedStates.length > 0) {
    rows.push({
      verdict: 'state',
      name: formatCount(removedStates.length, 'folder'),
      size: formatBytes(sumBytes(removedStates)),
      detail: 'no listed session',
    });
  }

  const verdictWidth = Math.max(0, ...rows.map((row) => row.verdict.length));
  const nameWidth = Math.max(0, ...rows.map((row) => row.name.length));
  const sizeWidth = Math.max(0, ...rows.map((row) => row.size.length));

  const lines = rows.map((row) =>
    `${row.verdict.padEnd(verdictWidth)}  ${row.name.padEnd(nameWidth)}  ${row.size.padStart(sizeWidth)}  ${row.detail}`.trimEnd(),
  );

  if (removedWorkspaces.length === 0 && removedStates.length === 0) {
    return [...lines, 'nothing to remove'];
  }

  const total = `${formatCount(removedWorkspaces.length, 'workspace')} and ${formatCount(removedStates.length, 'state folder')} (${formatBytes(sumBytes([...removedWorkspaces, ...removedStates]))})`;

  return [...lines, prune.dryRun ? `run again with --yes to remove ${total}` : `removed ${total}`];
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

// Decimal units, one decimal place under 10; null when the host did not say.
function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return '?';
  }

  const magnitude = bytes < 1000 ? 0 : Math.floor(Math.log10(bytes) / 3);
  const exponent = Math.min(UNITS.length - 1, magnitude);
  const value = bytes / 1000 ** exponent;
  const shown = exponent > 0 && value < 10 ? value.toFixed(1) : String(Math.round(value));

  return `${shown} ${UNITS[exponent] ?? 'B'}`;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function sumBytes(folders: readonly WorkspacePruneFolder[]): number | null {
  let total = 0;

  for (const folder of folders) {
    if (folder.verdict === 'skip' || folder.bytes === null) {
      return null;
    }

    total += folder.bytes;
  }

  return total;
}
