// The steps of the git spawn flow a refused spawn can return to.
type RefusalStep = 'confirm' | 'destination' | 'ref' | 'source';

const REFUSAL_STEPS: ReadonlyMap<string, RefusalStep> = new Map<string, RefusalStep>([
  ['workspace_exists', 'destination'],
  ['workspace_overlap', 'destination'],
  ['ref_not_found', 'ref'],
  ['invalid_git_url', 'source'],
  ['credential_in_url', 'source'],
  ['credential_missing', 'source'],
  ['clone_failed', 'source'],
  ['has_submodules', 'confirm'],
  ['lfs_unsupported', 'confirm'],
  ['unreadable_tree', 'confirm'],
  ['sanitize_failed', 'confirm'],
  ['tar_failed', 'confirm'],
  ['transfer_failed', 'confirm'],
  ['workspace_mismatch', 'confirm'],
]);

/**
 * The step of the git spawn flow that can fix a workspace spawn's
 * refusal: the destination for one that already exists, the ref for one
 * the upstream lacks, the source step for a URL or clone failure, and the
 * confirm screen for a refusal of the commit or the target's copy of it.
 * Null for any other refusal, which stays on the step that sent the spawn.
 */
export function pickRefusalStep(code: string): RefusalStep | null {
  return REFUSAL_STEPS.get(code) ?? null;
}
