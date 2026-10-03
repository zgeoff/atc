import { expect, test } from 'bun:test';
import { buildConfigRevision } from './build-config-revision';

test('it builds a sixteen-digit hex revision', () => {
  expect(
    buildConfigRevision(
      [{ id: 'local', kind: 'local-pty', options: {}, identity: 'local-pty:a', provider: null }],
      'local',
      [],
    ),
  ).toMatch(/^[\da-f]{16}$/);
});

test('it builds another revision when a target identity changes', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [],
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:b', provider: null }],
      'box',
      [],
    ),
  );
});

test('it builds another revision when the default target changes', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [],
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      null,
      [],
    ),
  );
});

test('it builds another revision when the config errors change', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [],
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [{ scope: 'target', target: 'other', problem: 'bad' }],
    ),
  );
});
