import { expect, test } from 'bun:test';
import { buildConfigRevision } from './build-config-revision';

test('it builds a sixteen-digit hex revision', () => {
  expect(
    buildConfigRevision([{ id: 'local', kind: 'local-pty', options: {}, provider: null }], 'local'),
  ).toMatch(/^[\da-f]{16}$/);
});

test('it builds the same revision whatever order a target lists its options in', () => {
  expect(
    buildConfigRevision(
      [
        {
          id: 'box',
          kind: 'imp',
          options: { image: 'dev', size: { cpu: 2, ram: 4 } },
          provider: null,
        },
      ],
      'box',
    ),
  ).toBe(
    buildConfigRevision(
      [
        {
          id: 'box',
          kind: 'imp',
          options: { size: { ram: 4, cpu: 2 }, image: 'dev' },
          provider: null,
        },
      ],
      'box',
    ),
  );
});

test('it builds another revision when a target option changes', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: { image: 'dev' }, provider: null }],
      'box',
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: { image: 'ci' }, provider: null }],
      'box',
    ),
  );
});

test('it builds another revision when the default target changes', () => {
  expect(
    buildConfigRevision(
      [
        { id: 'local', kind: 'local-pty', options: {}, provider: null },
        { id: 'box', kind: 'imp', options: {}, provider: null },
      ],
      'local',
    ),
  ).not.toBe(
    buildConfigRevision(
      [
        { id: 'local', kind: 'local-pty', options: {}, provider: null },
        { id: 'box', kind: 'imp', options: {}, provider: null },
      ],
      'box',
    ),
  );
});
