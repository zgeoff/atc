import { expect, test } from 'bun:test';
import { buildGitSource } from './build-git-source';

test('it lists nothing', async () => {
  const source = buildGitSource();

  const listed = await source.list(
    {},
    { target: 'local', collectSpawnDirs: () => Promise.resolve([]) },
  );

  expect(listed).toStrictEqual({ candidates: [], scope: null });
});

test.each([
  ['https://example.com/acme/app.git', { kind: 'git', url: 'https://example.com/acme/app.git' }],
  [' git@example.com:acme/app.git ', { kind: 'git', url: 'git@example.com:acme/app.git' }],
  ['acme/app', { kind: 'none' }],
] as const)('it reads typed %p as %p', async (input, expected) => {
  const source = buildGitSource();

  const interpretation = await source.interpret(input, {
    target: 'local',
    collectSpawnDirs: () => Promise.resolve([]),
  });

  expect(interpretation).toStrictEqual(expected);
});
