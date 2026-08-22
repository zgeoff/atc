import { expect, test } from 'bun:test';
import { toShellArg } from './to-shell-arg';

test('it wraps a plain value in single quotes', () => {
  expect(toShellArg('/home/user/project')).toBe("'/home/user/project'");
});

test('it escapes a single quote inside the value', () => {
  expect(toShellArg("it's a path")).toBe(String.raw`'it'\''s a path'`);
});
