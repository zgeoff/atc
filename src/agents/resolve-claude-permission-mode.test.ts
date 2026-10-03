import { expect, test } from 'bun:test';
import { resolveClaudePermissionMode } from './resolve-claude-permission-mode';

test('it runs in the mode the configuration sets', () => {
  expect(resolveClaudePermissionMode([], { permissions: { defaultMode: 'default' } })).toBe(
    'default',
  );
});

test('it falls back to auto when the configuration sets no mode', () => {
  expect(resolveClaudePermissionMode([], undefined)).toBe('auto');
});
