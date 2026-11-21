import { expect, test } from 'bun:test';
import { toSessionPlace } from './to-session-place';

test.each([
  {
    title: 'the descriptor place when it carries one',
    place: { key: 'cloud:place-v1:4be1c09a2d7e5f10', label: 'cloud' },
    daemon: 'lab',
    target: 'cloudz',
    expected: { key: 'cloud:place-v1:4be1c09a2d7e5f10', label: 'cloud' },
  },
  {
    title: 'the daemon and target of a descriptor with no place',
    place: undefined,
    daemon: 'lab',
    target: 'dock',
    expected: { key: 'daemon:lab:dock', label: 'dock' },
  },
  {
    title: 'local for the daemon on this computer',
    place: undefined,
    daemon: null,
    target: 'local',
    expected: { key: 'daemon:local:local', label: 'local' },
  },
  {
    title: 'the fallback for a place of the wrong shape',
    place: { key: 4 },
    daemon: 'lab',
    target: 'dock',
    expected: { key: 'daemon:lab:dock', label: 'dock' },
  },
])('#toSessionPlace gives $title', (row) => {
  expect(toSessionPlace(row.place, row.daemon, row.target)).toStrictEqual(row.expected);
});
