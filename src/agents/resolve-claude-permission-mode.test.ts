import { expect, test } from 'bun:test';
import { resolveClaudePermissionMode } from './resolve-claude-permission-mode';

test('it takes an explicit permission-mode argument over the settings default', () => {
  expect(
    resolveClaudePermissionMode(['--permission-mode', 'default'], {
      permissions: { defaultMode: 'acceptEdits' },
    }),
  ).toBe('default');
});

test('it takes an inline permission-mode argument', () => {
  expect(resolveClaudePermissionMode(['--permission-mode=plan'], undefined)).toBe('plan');
});

test('it takes the settings default mode when no argument sets one', () => {
  expect(resolveClaudePermissionMode([], { permissions: { defaultMode: 'default' } })).toBe(
    'default',
  );
});

test.each([
  ['no settings', undefined],
  ['settings without permissions', { model: 'opus' }],
  ['a non-object permissions block', { permissions: 'default' }],
  ['an empty default mode', { permissions: { defaultMode: '' } }],
])('it falls back to auto with %s', (_case, settings) => {
  expect(resolveClaudePermissionMode([], settings)).toBe('auto');
});
