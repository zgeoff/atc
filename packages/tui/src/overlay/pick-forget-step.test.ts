import { expect, test } from 'bun:test';
import { pickForgetStep } from './pick-forget-step';

test('it names the kept folder and every reason atc kept it', () => {
  expect(
    pickForgetStep({
      forgotten: true,
      destroyed: false,
      workspace: {
        outcome: 'kept',
        path: '/home/rowan/.local/share/atc/workspaces/orchard-main-7',
        reasons: ['2 unpushed commits on fix-pears', '1 stash'],
      },
    }),
  ).toStrictEqual({
    step: 'notice',
    notice: 'kept orchard-main-7: 2 unpushed commits on fix-pears, 1 stash',
  });
});

test.each([
  {
    outcome: 'removed',
    workspace: {
      outcome: 'removed',
      path: '/home/rowan/.local/share/atc/workspaces/orchard-main-8',
      found: [],
    },
  },
  { outcome: 'none', workspace: { outcome: 'none' } },
])('it gives no notice for a forget whose workspace outcome is $outcome', (row) => {
  expect(
    pickForgetStep({ forgotten: true, destroyed: false, workspace: row.workspace }),
  ).toStrictEqual({
    step: 'none',
  });
});

test('it gives no notice for an answer from a daemon that reports no workspace', () => {
  expect(pickForgetStep({ forgotten: true, destroyed: false })).toStrictEqual({ step: 'none' });
});

test('it asks once more when the daemon offers a confirm token', () => {
  expect(pickForgetStep({ confirmToken: 'tok-pear', expiresAt: 1_900_000_000_000 })).toStrictEqual({
    step: 'confirm',
  });
});
