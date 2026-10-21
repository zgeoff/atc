import { expect, test } from 'bun:test';
import { isPathInput } from './is-path-input';

test.each([['/srv/work'], ['~'], ['~/projects'], ['.'], ['..'], ['./api'], ['../sibling']])(
  'it reads %p as a path',
  (input) => {
    expect(isPathInput(input)).toBe(true);
  },
);

test.each([[''], ['atc'], ['~atc'], ['.hidden'], ['projects/atc']])(
  'it reads %p as a filter rather than a path',
  (input) => {
    expect(isPathInput(input)).toBe(false);
  },
);
