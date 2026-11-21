import { expect, test } from 'bun:test';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { isOverSession } from './is-over-session';

test.each([
  { title: 'attached', mode: 'attached', hasConsent: false, isAlive: false, expected: true },
  {
    title: 'attached with a restart prompt',
    mode: 'attached',
    hasConsent: true,
    isAlive: true,
    expected: false,
  },
  {
    title: 'the list over a live session',
    mode: 'overlay',
    hasConsent: false,
    isAlive: true,
    expected: true,
  },
  {
    title: 'the list over an exited session',
    mode: 'overlay',
    hasConsent: false,
    isAlive: false,
    expected: false,
  },
  { title: 'home', mode: 'home', hasConsent: false, isAlive: true, expected: false },
] as const)('#isOverSession is $expected for $title', (row) => {
  const consent = row.hasConsent ? { prompt: 'restart?', answer: () => {} } : null;

  expect(isOverSession(row.mode, consent, buildMockMirrorSession({ alive: row.isAlive }))).toBe(
    row.expected,
  );
});
