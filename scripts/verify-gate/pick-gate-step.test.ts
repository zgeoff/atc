import { expect, test } from 'bun:test';
import { pickGateStep } from './pick-gate-step.ts';

test('it gates a pull request on its base branch and body', () => {
  const event = {
    pull_request: { body: 'the report', base: { ref: 'main' }, head: { ref: 'add-orchard-view' } },
  };

  expect(pickGateStep(event)).toStrictEqual({ kind: 'gate', baseRef: 'main', body: 'the report' });
});

test('it gates a pull request with no body on an empty one', () => {
  const event = {
    pull_request: { body: null, base: { ref: 'main' }, head: { ref: 'add-orchard-view' } },
  };

  expect(pickGateStep(event)).toStrictEqual({ kind: 'gate', baseRef: 'main', body: '' });
});

test('it skips a release-please pull request', () => {
  const event = {
    pull_request: {
      body: 'release notes',
      base: { ref: 'main' },
      head: { ref: 'release-please--branches--main' },
    },
  };

  expect(pickGateStep(event)).toStrictEqual({
    kind: 'skip',
    reason: 'a release pull request carries no verify report',
  });
});

test('it refuses an event with no pull request', () => {
  expect(pickGateStep({ ref: 'refs/heads/main' })).toMatchObject({ kind: 'refused' });
});
