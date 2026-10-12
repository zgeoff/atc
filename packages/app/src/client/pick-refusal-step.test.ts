import { expect, test } from 'bun:test';
import { pickRefusalStep } from './pick-refusal-step';

test.each([
  ['workspace_exists', 'destination'],
  ['workspace_overlap', 'destination'],
  ['ref_not_found', 'ref'],
  ['invalid_git_url', 'source'],
  ['credential_in_url', 'source'],
  ['clone_failed', 'source'],
  ['has_submodules', 'confirm'],
  ['lfs_unsupported', 'confirm'],
  ['workspace_mismatch', 'confirm'],
  ['target_forbidden', null],
  ['internal', null],
] as const)('it returns a %p refusal to %p', (code, step) => {
  expect(pickRefusalStep(code)).toBe(step);
});
