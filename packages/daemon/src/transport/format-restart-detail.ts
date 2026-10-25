import type { RestartResult } from '@atcx/contract';

export function formatRestartDetail(result: RestartResult): string {
  if (result.error !== null) {
    return `restart failed: ${result.error}`;
  }

  const parts = [`restored ${result.restored} of ${result.total}`];

  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} failed`);
  }

  if (result.interrupted.length > 0) {
    parts.push(`${result.interrupted.length} interrupted mid-turn`);
  }

  if (result.code !== 0) {
    parts.push(`exit code ${result.code}`);
  }

  return parts.join(', ');
}
