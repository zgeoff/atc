import { expect, test } from 'bun:test';
import { findRemoteRef } from './find-remote-ref';

const BRANCH = 'a'.repeat(40);
const TAG_OBJECT = 'b'.repeat(40);
const TAG_COMMIT = 'c'.repeat(40);
const LIGHT_TAG = 'd'.repeat(40);

test.each([
  ['main', { sha: BRANCH, branch: 'main' }],
  ['refs/heads/main', { sha: BRANCH, branch: 'main' }],
  ['v1', { sha: TAG_COMMIT, branch: null }],
  ['refs/tags/v1', { sha: TAG_COMMIT, branch: null }],
  ['light', { sha: LIGHT_TAG, branch: null }],
  ['twin', { sha: BRANCH, branch: 'twin' }],
  ['refs/tags/twin', { sha: LIGHT_TAG, branch: null }],
  ['refs/heads/v1', null],
  ['refs/tags/main', null],
  ['missing', null],
])('it finds %p as %p', (ref, expected) => {
  const refs = new Map([
    ['refs/heads/main', BRANCH],
    ['refs/heads/twin', BRANCH],
    ['refs/tags/v1', TAG_OBJECT],
    ['refs/tags/v1^{}', TAG_COMMIT],
    ['refs/tags/light', LIGHT_TAG],
    ['refs/tags/twin', LIGHT_TAG],
  ]);

  expect(findRemoteRef(refs, ref)).toStrictEqual(expected);
});
