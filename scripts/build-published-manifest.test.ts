import { expect, test } from 'bun:test';
import { buildPublishedManifest } from './build-published-manifest';

test('it points each entry at its build and each catalog dependency at the catalog version', () => {
  expect(
    buildPublishedManifest(
      {
        name: '@atcx/contract',
        version: '7.1.0',
        type: 'module',
        exports: { '.': './src/index.ts', './light': './src/light/index.ts' },
        dependencies: { '@orpc/contract': 'catalog:', zod: 'catalog:' },
      },
      { '@orpc/contract': '1.15.6', zod: '4.6.6', kysely: '0.29.6' },
    ),
  ).toStrictEqual({
    name: '@atcx/contract',
    version: '7.1.0',
    type: 'module',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './light': { types: './dist/light/index.d.ts', default: './dist/light/index.js' },
    },
    files: ['dist'],
    dependencies: { '@orpc/contract': '1.15.6', zod: '4.6.6' },
  });
});

test('it refuses a catalog dependency the catalog has no version of', () => {
  expect(() =>
    buildPublishedManifest(
      {
        name: '@atcx/contract',
        version: '7.1.0',
        exports: { '.': './src/index.ts' },
        dependencies: { zod: 'catalog:' },
      },
      {},
    ),
  ).toThrowWithMessage(Error, 'the catalog has no version of zod');
});
