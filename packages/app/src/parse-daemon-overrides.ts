// Test harnesses shrink the outbound queue to force an overflow, and pin the
// tap grace to 0 to reach a refused message at once.
interface DaemonOverrides {
  readonly queueBytes?: number;
  readonly tapGraceMs?: number;
}

export function parseDaemonOverrides(
  env: Readonly<Record<string, string | undefined>>,
): DaemonOverrides {
  const queueBytes = Number(env['ATC_QUEUE_BYTES']);
  const tapGraceMs = Number(env['ATC_TAP_GRACE_MS']);

  return {
    ...(Number.isFinite(queueBytes) && queueBytes > 0 ? { queueBytes } : {}),
    ...(Number.isFinite(tapGraceMs) && tapGraceMs >= 0 ? { tapGraceMs } : {}),
  };
}
