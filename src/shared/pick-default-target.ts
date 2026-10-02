/**
 * The target a spawn without a target runs on: the requested one when a
 * target holds that id, else `local` when a target holds it, else the first
 * target. `matched` is false whenever the requested id was absent or held
 * by no target, so a caller can report a requested one it fell back from.
 */
export function pickDefaultTarget(
  ids: readonly string[],
  requested: string | undefined,
): { readonly id: string; readonly matched: boolean } {
  if (requested !== undefined && ids.includes(requested)) {
    return { id: requested, matched: true };
  }

  return { id: ids.includes('local') ? 'local' : (ids[0] ?? 'local'), matched: false };
}
