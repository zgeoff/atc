import { expect, test } from 'bun:test';
import { pickGateStep } from './pick-gate-step.ts';

test('it gates a pull request on its base branch and body', () => {
  const event = {
    pull_request: {
      body: 'the report',
      base: { ref: 'main' },
      head: { ref: 'add-orchard-view' },
      user: { type: 'User' },
    },
  };

  expect(pickGateStep(event)).toStrictEqual({ kind: 'gate', baseRef: 'main', body: 'the report' });
});

test('it gates a pull request with no body on an empty one', () => {
  const event = {
    pull_request: {
      body: null,
      base: { ref: 'main' },
      head: { ref: 'add-orchard-view' },
      user: { type: 'User' },
    },
  };

  expect(pickGateStep(event)).toStrictEqual({ kind: 'gate', baseRef: 'main', body: '' });
});

test('it skips the release pull request a bot opens', () => {
  const event = {
    pull_request: {
      body: 'release notes',
      base: { ref: 'main' },
      head: { ref: 'release-please--branches--main' },
      user: { type: 'Bot' },
    },
  };

  expect(pickGateStep(event)).toStrictEqual({
    kind: 'skip',
    reason: 'a release pull request carries no verify report',
  });
});

test.each([
  { who: 'a person on the release branch', ref: 'release-please--branches--main', type: 'User' },
  { who: 'a bot on another release-please branch', ref: 'release-please--orchard', type: 'Bot' },
])('it gates $who', (row) => {
  const event = {
    pull_request: {
      body: '',
      base: { ref: 'main' },
      head: { ref: row.ref },
      user: { type: row.type },
    },
  };

  expect(pickGateStep(event)).toStrictEqual({ kind: 'gate', baseRef: 'main', body: '' });
});

test('it refuses an event with no pull request', () => {
  expect(pickGateStep({ ref: 'refs/heads/main' })).toMatchObject({ kind: 'refused' });
});
