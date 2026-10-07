import { expect, test } from 'bun:test';
import { findClaudePermissionMode } from './find-claude-permission-mode';

test('it takes an explicit permission-mode argument over the settings default', () => {
  expect(
    findClaudePermissionMode(['--permission-mode', 'default'], {
      permissions: { defaultMode: 'acceptEdits' },
    }),
  ).toBe('default');
});

test('it takes an inline permission-mode argument', () => {
  expect(findClaudePermissionMode(['--permission-mode=plan'], undefined)).toBe('plan');
});

test('it takes the settings default mode when no argument sets one', () => {
  expect(findClaudePermissionMode([], { permissions: { defaultMode: 'default' } })).toBe('default');
});

test.each([
  [undefined],
  [{ model: 'opus' }],
  [{ permissions: 'default' }],
  [{ permissions: { defaultMode: '' } }],
])('it finds no mode in the settings %p', (settings) => {
  expect(findClaudePermissionMode([], settings)).toBeNull();
});
