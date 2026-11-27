import { expect, test } from 'bun:test';
import { collectReachedFolders } from './collect-reached-folders.ts';

test.each([
  {
    title: 'a seed with no dependencies',
    seeds: ['packages/kettle'],
    packages: [{ folder: 'packages/kettle', name: '@atc/kettle', workspaceDependencies: [] }],
    reached: ['packages/kettle'],
  },
  {
    title: 'the dependencies of a dependency',
    seeds: ['packages/harnesses/steam'],
    packages: [
      {
        folder: 'packages/harnesses/steam',
        name: '@atc/harness-steam',
        workspaceDependencies: ['@atc/kettle'],
      },
      { folder: 'packages/kettle', name: '@atc/kettle', workspaceDependencies: ['@atcx/clock'] },
      { folder: 'packages/clock', name: '@atcx/clock', workspaceDependencies: [] },
      { folder: 'packages/teapot', name: '@atc/teapot', workspaceDependencies: [] },
    ],
    reached: ['packages/clock', 'packages/harnesses/steam', 'packages/kettle'],
  },
  {
    title: 'each package of a cycle once',
    seeds: ['packages/cup'],
    packages: [
      { folder: 'packages/cup', name: '@atc/cup', workspaceDependencies: ['@atc/saucer'] },
      { folder: 'packages/saucer', name: '@atc/saucer', workspaceDependencies: ['@atc/cup'] },
    ],
    reached: ['packages/cup', 'packages/saucer'],
  },
  {
    title: 'a seed folder with no package, as after its deletion',
    seeds: ['packages/gone'],
    packages: [],
    reached: ['packages/gone'],
  },
  {
    title: 'no folder for a dependency outside the workspace',
    seeds: ['packages/kettle'],
    packages: [
      {
        folder: 'packages/kettle',
        name: '@atc/kettle',
        workspaceDependencies: ['@atc/elsewhere'],
      },
    ],
    reached: ['packages/kettle'],
  },
])('it reaches $title', (row) => {
  expect(collectReachedFolders(row.seeds, row.packages)).toStrictEqual([...row.reached]);
});
