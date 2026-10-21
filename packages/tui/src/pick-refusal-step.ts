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

export function pickRefusalStep(code: string): RefusalStep | null {
  // any other refusal stays on the step that sent the spawn.
  return REFUSAL_STEPS.get(code) ?? null;
}
