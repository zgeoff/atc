import type { RestartResult } from './parse-restart-result';

/**
 * Renders a finished restart as the lines the run prints: the daemon now
 * serving, how much of the fleet came back, each row that did not, and the
 * sessions the restart interrupted.
 */
export function formatRestartReport(result: RestartResult): string[] {
  const lines: string[] = [];

  if (result.error !== null) {
    lines.push(`restart failed: ${result.error}`);
  }

  if (result.pid !== null) {
    lines.push(`daemon pid ${result.pid}, build ${result.build ?? 'unknown'}`);
  }

  if (result.listenPort !== null) {
    lines.push(`listening on port ${result.listenPort}`);
  }

  if (result.error === null) {
    lines.push(`restored ${result.restored} of ${result.total}`);
  }

  for (const row of result.failed) {
    lines.push(`failed: ${row.name} (${row.id}): ${row.reason}`);
  }

  if (result.interrupted.length > 0) {
    lines.push(`interrupted ${result.interrupted.length} mid-turn:`);

    for (const row of result.interrupted) {
      lines.push(`  ${row.name} (${row.id})`);
    }
  }

  const verdict =
    result.code === 0 ? 'restart succeeded' : `restart failed with exit code ${result.code}`;

  lines.push(verdict);

  return lines;
}
