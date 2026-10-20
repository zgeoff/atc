import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { buildDirsSource } from './build-dirs-source';

// A temp directory that stands for the daemon user's home.
function setupTest() {
  const tmp = setupTempDir('atc-dirs-source-');

  return { home: tmp.path };
}

test('it lists the spawn history, then the roots, then zoxide, leaving out a gone directory and a repeat', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'recent'));
  mkdirSync(join(ctx.home, 'projects', 'app'), { recursive: true });
  mkdirSync(join(ctx.home, 'zoxide-dir'));

  const source = buildDirsSource({
    roots: [join(ctx.home, 'projects')],
    readZoxideDirs: () =>
      Promise.resolve([
        join(ctx.home, 'zoxide-dir'),
        join(ctx.home, 'recent'),
        join(ctx.home, 'gone'),
      ]),
    homeDir: ctx.home,
  });

  const listed = await source.list(
    {},
    { target: 'local', readSpawnDirs: () => Promise.resolve([join(ctx.home, 'recent')]) },
  );

  expect(listed).toStrictEqual({
    candidates: [
      { label: '~/recent', pick: { kind: 'path', dir: join(ctx.home, 'recent') } },
      { label: '~/projects/app', pick: { kind: 'path', dir: join(ctx.home, 'projects', 'app') } },
      { label: '~/zoxide-dir', pick: { kind: 'path', dir: join(ctx.home, 'zoxide-dir') } },
    ],
    scope: null,
  });
});

test.each([
  ['/srv/app', { kind: 'path', dir: '/srv/app' }],
  ['~/app', { kind: 'path', dir: '/home/tester/app' }],
  [' /srv/app ', { kind: 'path', dir: '/srv/app' }],
  ['./app', { kind: 'path', dir: '/home/tester/app' }],
  ['../shared', { kind: 'path', dir: '/home/shared' }],
  ['app', { kind: 'none' }],
] as const)('it reads typed %p as %p', async (input, expected) => {
  const source = buildDirsSource({
    roots: [],
    readZoxideDirs: () => Promise.resolve([]),
    homeDir: '/home/tester',
  });

  const interpretation = await source.interpret(input, {
    target: 'local',
    readSpawnDirs: () => Promise.resolve([]),
  });

  expect(interpretation).toStrictEqual(expected);
});

test("it completes a relative path under the client's directory", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'work', 'alpha'), { recursive: true });
  mkdirSync(join(ctx.home, 'work', 'beta'));

  const source = buildDirsSource({
    roots: [],
    readZoxideDirs: () => Promise.resolve([]),
    homeDir: ctx.home,
  });

  const completions = await source.complete?.('./al', {
    target: 'local',
    readSpawnDirs: () => Promise.resolve([]),
    clientCwd: join(ctx.home, 'work'),
  });

  expect(completions).toStrictEqual([
    { label: '~/work/alpha', pick: { kind: 'path', dir: join(ctx.home, 'work', 'alpha') } },
  ]);
});

test('it completes a relative path under the home when the request holds no client directory', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'alpha'));

  const source = buildDirsSource({
    roots: [],
    readZoxideDirs: () => Promise.resolve([]),
    homeDir: ctx.home,
  });

  const completions = await source.complete?.('./al', {
    target: 'local',
    readSpawnDirs: () => Promise.resolve([]),
  });

  expect(completions).toStrictEqual([
    { label: '~/alpha', pick: { kind: 'path', dir: join(ctx.home, 'alpha') } },
  ]);
});

test('it completes input that is not a path to nothing', async () => {
  const ctx = setupTest();

  const source = buildDirsSource({
    roots: [],
    readZoxideDirs: () => Promise.resolve([]),
    homeDir: ctx.home,
  });

  const completions = await source.complete?.('alpha', {
    target: 'local',
    readSpawnDirs: () => Promise.resolve([]),
  });

  expect(completions).toStrictEqual([]);
});
