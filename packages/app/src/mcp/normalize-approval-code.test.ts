import { expect, test } from 'bun:test';
import { normalizeApprovalCode } from './normalize-approval-code';

test.each([
  ['ABCD-EFGH', 'ABCDEFGH'],
  ['abcd efgh', 'ABCDEFGH'],
  ['1O2L-3I45', '10213145'],
])('it folds a typed code of %p to %p', (typed, folded) => {
  expect(normalizeApprovalCode(typed)).toBe(folded);
});
