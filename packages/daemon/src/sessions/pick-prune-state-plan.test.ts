import { expect, test } from 'bun:test';
import { pickPruneStatePlan } from './pick-prune-state-plan';

test.each([
  { remove: false, owned: false, plan: 'report' },
  { remove: false, owned: true, plan: 'report' },
  { remove: true, owned: true, plan: 'keep' },
  { remove: true, owned: false, plan: 'remove' },
])('it plans $plan for a state folder with remove $remove and owned $owned', (row) => {
  expect(pickPruneStatePlan({ remove: row.remove, owned: row.owned })).toBe(row.plan);
});
