/**
 * How long a fleet restore waits for one revived session to report that it
 * booted before it moves to the next: `ATC_RESTORE_BOOT_TIMEOUT_MS` when it
 * holds a number above 0, which tests set to keep timing deterministic, else
 * 15 s. The result is never 0, because a restore that waited without a cap
 * would hold the rest of the fleet behind a session that never reports.
 */
export function parseRestoreBootTimeoutMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const override = Number(env['ATC_RESTORE_BOOT_TIMEOUT_MS']);

  return Number.isFinite(override) && override > 0 ? override : 15_000;
}
