import { expect, test } from 'bun:test';
import { findRemoteRef } from './find-remote-ref';

test.each([
  ['main', { sha: 'a'.repeat(40), branch: 'main' }],
  ['refs/heads/main', { sha: 'a'.repeat(40), branch: 'main' }],
  ['v1', { sha: 'c'.repeat(40), branch: null }],
  ['refs/tags/v1', { sha: 'c'.repeat(40), branch: null }],
  ['light', { sha: 'd'.repeat(40), branch: null }],
  ['twin', { sha: 'a'.repeat(40), branch: 'twin' }],
  ['refs/tags/twin', { sha: 'd'.repeat(40), branch: null }],
  ['refs/heads/v1', null],
  ['refs/tags/main', null],
  ['missing', null],
])('it finds %p as %p', (ref, expected) => {
  const refs = new Map([
    ['refs/heads/main', 'a'.repeat(40)],
    ['refs/heads/twin', 'a'.repeat(40)],
    ['refs/tags/v1', 'b'.repeat(40)],
    ['refs/tags/v1^{}', 'c'.repeat(40)],
    ['refs/tags/light', 'd'.repeat(40)],
    ['refs/tags/twin', 'd'.repeat(40)],
  ]);

  expect(findRemoteRef(refs, ref)).toStrictEqual(expected);
});
