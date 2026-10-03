import { expect, test } from 'bun:test';
import { formatLogField } from './format-log-field';

test('it keeps a value of printable ASCII as it is', () => {
  expect(formatLogField('fd7a:115c:a1e4::7')).toBe('fd7a:115c:a1e4::7');
});

test('it escapes ESC, CR, LF, DEL, and a C1 control character', () => {
  expect(formatLogField('a\u001B[2Jb\r\nc\u007Fd\u009Be')).toBe(
    String.raw`a\u{1b}[2Jb\u{d}\u{a}c\u{7f}d\u{9b}e`,
  );
});

test('it escapes a space, an equals sign, a quote, and a backslash so no field is forged', () => {
  expect(formatLogField('x count="9"\\')).toBe(String.raw`x\u{20}count\u{3d}\u{22}9\u{22}\u{5c}`);
});

test('it escapes a character outside ASCII', () => {
  expect(formatLogField('a\u202Eb')).toBe(String.raw`a\u{202e}b`);
});

test('it cuts a value longer than 64 characters and marks the cut', () => {
  expect(formatLogField('p'.repeat(100))).toBe(`${'p'.repeat(64)}...`);
});

test('it keeps a value of exactly 64 characters whole', () => {
  expect(formatLogField('p'.repeat(64))).toBe('p'.repeat(64));
});
