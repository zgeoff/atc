import { expect, test } from 'bun:test';
import { pickPTYLibrary } from './pick-pty-library';

test.each([
  {
    names: ['librust_pty-sxf464jf.so', 'librust_pty_musl-j5hf8p7d.so'],
    musl: false,
    picked: 'librust_pty-sxf464jf.so',
  },
  {
    names: ['librust_pty-sxf464jf.so', 'librust_pty_musl-j5hf8p7d.so'],
    musl: true,
    picked: 'librust_pty_musl-j5hf8p7d.so',
  },
  {
    names: ['librust_pty_arm64-q2w8e4rt.so', 'librust_pty_arm64_musl-z9x7c5vb.so'],
    musl: false,
    picked: 'librust_pty_arm64-q2w8e4rt.so',
  },
  {
    names: ['librust_pty_arm64-q2w8e4rt.so', 'librust_pty_arm64_musl-z9x7c5vb.so'],
    musl: true,
    picked: 'librust_pty_arm64_musl-z9x7c5vb.so',
  },
  {
    names: ['librust_pty_arm64-m3n6b8v1.dylib'],
    musl: false,
    picked: 'librust_pty_arm64-m3n6b8v1.dylib',
  },
])('it picks $picked from the embedded files when musl is $musl', (row) => {
  const files = row.names.map((name) => Object.assign(new Blob(['library']), { name }));

  expect(pickPTYLibrary(files, row.musl)).toBe(row.picked);
});

test('it picks nothing from a binary that embeds no PTY library', () => {
  const files = [Object.assign(new Blob(['{}']), { name: 'plugin-k4j2h7g9.json' })];

  expect(pickPTYLibrary(files, false)).toBeNull();
});

test('it picks nothing from an embedded file that has no name', () => {
  expect(pickPTYLibrary([new Blob(['library'])], false)).toBeNull();
});
