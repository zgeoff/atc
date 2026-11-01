import { expect, test } from 'bun:test';
import { findPTYLibraryCopy } from './copy-pty-library';

test.each([
  { label: 'a Linux copy', names: ['.bun-501-9f2c4e1a.so'], expected: '.bun-501-9f2c4e1a.so' },
  {
    label: 'a macOS copy',
    names: ['atc-test-home-Qx81', '.bun-501-9f2c4e1a.dylib'],
    expected: '.bun-501-9f2c4e1a.dylib',
  },
])('it finds $label of the PTY library', (row) => {
  expect(findPTYLibraryCopy(row.names, 501)).toBe(row.expected);
});

test.each([
  { label: 'an empty temp directory', names: [] },
  { label: "another user's copy", names: ['.bun-502-9f2c4e1a.so'] },
  { label: 'a scratch file that never reached its final name', names: ['.7d1e0b2c-0.so'] },
  { label: 'a copy of another kind of file', names: ['.bun-501-9f2c4e1a.txt'] },
])('it finds no copy of the PTY library in $label', (row) => {
  expect(findPTYLibraryCopy(row.names, 501)).toBeUndefined();
});
