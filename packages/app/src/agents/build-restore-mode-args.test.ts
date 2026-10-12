import { expect, test } from 'bun:test';
import { buildRestoreModeArgs } from './build-restore-mode-args';

test('it carries a settings-only default mode as an explicit argument', () => {
  expect(buildRestoreModeArgs([], { permissions: { defaultMode: 'default' } })).toStrictEqual([
    '--permission-mode',
    'default',
  ]);
});

test.each([[['--permission-mode', 'plan']], [['--permission-mode=plan']]])(
  'it adds nothing when the arguments %p already carry a mode',
  (args) => {
    expect(buildRestoreModeArgs(args, { permissions: { defaultMode: 'default' } })).toStrictEqual(
      [],
    );
  },
);

test('it adds nothing when no mode is configured', () => {
  expect(buildRestoreModeArgs([], undefined)).toStrictEqual([]);
});
