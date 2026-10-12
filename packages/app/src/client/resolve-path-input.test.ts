import { expect, test } from 'bun:test';
import { resolvePathInput } from './resolve-path-input';

test.each([
  ['/srv/work', '/srv/work'],
  ['/srv/work/', '/srv/work'],
  ['~', '/home/u'],
  ['~/projects/atc', '/home/u/projects/atc'],
  ['.', '/cwd'],
  ['..', '/'],
  ['./api', '/cwd/api'],
  ['../sibling', '/sibling'],
])('it resolves the typed path %p to %p', (input, expected) => {
  expect(resolvePathInput(input, '/cwd', '/home/u')).toBe(expected);
});

test.each([[''], ['atc'], ['~atc'], ['.hidden'], ['projects/atc']])(
  'it treats %p as a filter rather than a path',
  (input) => {
    expect(resolvePathInput(input, '/cwd', '/home/u')).toBeNull();
  },
);
