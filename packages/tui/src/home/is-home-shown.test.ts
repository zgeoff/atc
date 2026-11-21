import { expect, test } from 'bun:test';
import type { ClientMode } from '../client/build-client-machine';
import { isHomeShown } from './is-home-shown';

test.each<readonly [ClientMode, boolean, boolean, boolean]>([
  ['home', false, false, true],
  ['home', false, true, false],
  ['overlay', false, false, true],
  ['overlay', true, false, false],
  ['attached', true, false, false],
  ['picker', false, false, false],
  ['help', false, false, false],
  ['picker-eject', false, false, false],
])(
  '#isHomeShown in %s with a session shown %s and a prompt %s is %s',
  (mode, isSessionShown, isPrompting, expected) => {
    expect(isHomeShown({ mode, isSessionShown, isPrompting })).toBe(expected);
  },
);
