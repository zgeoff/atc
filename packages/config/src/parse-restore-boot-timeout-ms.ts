/**
 * How long a fleet restore waits for one revived session to report that it
 * booted before it moves to the next: `ATC_RESTORE_BOOT_TIMEOUT_MS` when it
 * holds a number of 0 or more, which tests set to keep timing
 * deterministic, else 15 s.
 */
export function parseRestoreBootTimeoutMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const override = Number(env['ATC_RESTORE_BOOT_TIMEOUT_MS']);

  return Number.isFinite(override) && override >= 0 ? override : 15_000;
}
