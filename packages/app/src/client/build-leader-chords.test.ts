import { expect, test } from 'bun:test';
import { buildLeaderChords } from './build-leader-chords';

test.each([
  [0, ['\u0000', '\u001B[32;5u', '\u001B[27;5;32~']],
  [1, ['\u0001', '\u001B[97;5u', '\u001B[27;5;97~']],
  [29, ['\u001D', '\u001B[93;5u', '\u001B[27;5;93~']],
])('it encodes control byte %d as the bare byte plus both enhanced chords', (code, chords) => {
  expect(buildLeaderChords(code)).toStrictEqual(chords);
});
