import { expect, test } from 'bun:test';
import { pickProviderStateDir } from './pick-provider-state-dir';

test('it puts a provider folder under the providers folder of the state', () => {
  expect(pickProviderStateDir('/state/atc', 'box')).toBe('/state/atc/providers/box');
});

test.each(['..', '.', 'a/b', '../escape', String.raw`a\b`, 'nul\0byte'])(
  'it refuses the target id %j',
  (targetID) => {
    expect(pickProviderStateDir('/state/atc', targetID)).toBeNull();
  },
);
