import { expect, test } from 'bun:test';
import { buildHomeInput } from './build-home-input';

test('#buildHomeInput counts the sessions and the ones that need the user', () => {
  expect(
    buildHomeInput({
      sessionStates: ['running', 'needs_you', 'done', 'needs_you'],
      leaderLabel: 'ctrl+space',
      notice: null,
      isWaiting: false,
      isRestarting: false,
      isStale: true,
    }),
  ).toStrictEqual({
    sessionCount: 4,
    needYouCount: 2,
    leaderLabel: 'ctrl+space',
    notices: ['⟳ update ready'],
  });
});
