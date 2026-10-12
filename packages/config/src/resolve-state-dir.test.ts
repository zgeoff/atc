import { expect, test } from 'bun:test';
import { resolveStateDir } from './resolve-state-dir';

test('it puts the state directory under the home', () => {
  expect(resolveStateDir('/home/u')).toBe('/home/u/.local/state/atc');
});
