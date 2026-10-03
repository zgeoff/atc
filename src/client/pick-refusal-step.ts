// The steps of the GitHub spawn flow a refused spawn can return to.
type RefusalStep = 'confirm' | 'destination' | 'ref' | 'repo';

const REFUSAL_STEPS: ReadonlyMap<string, RefusalStep> = new Map<string, RefusalStep>([
  ['workspace_exists', 'destination'],
  ['ref_not_found', 'ref'],
  ['invalid_git_url', 'repo'],
  ['credential_in_url', 'repo'],
  ['credential_missing', 'repo'],
  ['clone_failed', 'repo'],
  ['has_submodules', 'confirm'],
  ['lfs_unsupported', 'confirm'],
  ['unreadable_tree', 'confirm'],
  ['sanitize_failed', 'confirm'],
  ['tar_failed', 'confirm'],
  ['transfer_failed', 'confirm'],
  ['workspace_mismatch', 'confirm'],
]);

/**
 * The step of the GitHub spawn flow that can fix a workspace spawn's
 * refusal: the destination for one that already exists, the ref for one
 * the upstream lacks, the repository for a URL or clone failure, and the
 * confirm screen for a refusal of the commit or the target's copy of it.
 * Null for any other refusal, which stays on the step that sent the spawn.
 */
export function pickRefusalStep(code: string): RefusalStep | null {
  return REFUSAL_STEPS.get(code) ?? null;
}
