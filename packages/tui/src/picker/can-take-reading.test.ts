import { expect, test } from 'bun:test';
import { canTakeReading } from './can-take-reading';

test.each([
  ['a source of directories', 'path', { kind: 'browse', scope: 'octo' }],
  ['a git source', 'git', { kind: 'browse', scope: 'octo' }],
  ['an unknown source', undefined, { kind: 'browse', scope: 'octo' }],
  ['a source of directories', 'path', { kind: 'path', directory: '/srv/app' }],
  ['a git source', 'git', { kind: 'git', url: 'https://example.com/app.git' }],
] as const)('it lets %s act on a %j reading', (_label, kind, reading) => {
  expect(canTakeReading(kind, reading)).toBe(true);
});

test.each([
  ['a source of directories', 'path', { kind: 'git', url: 'https://example.com/app.git' }],
  ['a git source', 'git', { kind: 'path', directory: '/srv/app' }],
  ['a source of directories', 'path', { kind: 'none' }],
  ['a git source', 'git', { kind: 'none' }],
  ['an unknown source', undefined, { kind: 'path', directory: '/srv/app' }],
  ['an unknown source', undefined, { kind: 'git', url: 'https://example.com/app.git' }],
  ['an unknown source', undefined, { kind: 'none' }],
] as const)('it refuses %s a %j reading', (_label, kind, reading) => {
  expect(canTakeReading(kind, reading)).toBe(false);
});
