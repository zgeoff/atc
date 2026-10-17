// never 0: a restore that waited without a cap would hold the rest of the
// fleet behind a session that never reports.
export function parseRestoreBootTimeoutMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const override = Number(env['ATC_RESTORE_BOOT_TIMEOUT_MS']);

  return Number.isFinite(override) && override > 0 ? override : 15_000;
}
