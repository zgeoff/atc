// repo-sync delivers this folder without the @zgeoff/std package, so the folder keeps its own guard.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
