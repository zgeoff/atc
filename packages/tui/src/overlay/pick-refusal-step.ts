import type { ErrorCode } from '@atcx/contract/light';

type RefusalStep = 'confirm' | 'destination' | 'ref' | 'list';

const REFUSAL_STEPS: ReadonlyMap<ErrorCode, RefusalStep> = new Map<ErrorCode, RefusalStep>([
  ['workspace_exists', 'destination'],
  ['workspace_overlap', 'destination'],
  ['ref_not_found', 'ref'],
  ['invalid_git_url', 'list'],
  ['credential_in_url', 'list'],
  ['credential_missing', 'list'],
  ['clone_failed', 'list'],
  ['has_submodules', 'confirm'],
  ['lfs_unsupported', 'confirm'],
  ['unreadable_tree', 'confirm'],
  ['sanitize_failed', 'confirm'],
  ['tar_failed', 'confirm'],
  ['transfer_failed', 'confirm'],
  ['workspace_mismatch', 'confirm'],
]);

export function pickRefusalStep(code: ErrorCode): RefusalStep | null {
  return REFUSAL_STEPS.get(code) ?? null;
}
