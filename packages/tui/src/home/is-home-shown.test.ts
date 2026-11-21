import { expect, test } from 'bun:test';
import type { ClientMode } from '../client/build-client-machine';
import { isHomeShown } from './is-home-shown';

test.each<readonly [ClientMode, boolean, boolean]>([
  ['home', false, true],
  ['overlay', false, true],
  ['overlay', true, false],
  ['attached', true, false],
  ['picker', false, false],
  ['help', false, false],
  ['picker-eject', false, false],
])('#isHomeShown in %s with a session shown %s is %s', (mode, isSessionShown, expected) => {
  expect(isHomeShown(mode, isSessionShown)).toBe(expected);
});
