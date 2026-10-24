import { expect, test } from 'bun:test';
import { checkContractReach } from './check-contract-reach';

test('it passes an entry that imports only its own files, zod, @orpc/contract and builtins', () => {
  expect(
    checkContractReach([
      {
        entry: 'packages/contract/src/index.ts',
        exists: true,
        imports: new Map([
          [
            'packages/contract/src/index.ts',
            ['./light', 'zod', '@orpc/contract', 'node:path', 'path'],
          ],
          ['packages/contract/src/light/index.ts', []],
        ]),
        unresolved: [],
      },
    ]),
  ).toStrictEqual([]);
});

test('it reports an entry that does not exist', () => {
  expect(
    checkContractReach([
      {
        entry: 'packages/contract/src/light/index.ts',
        exists: false,
        imports: new Map(),
        unresolved: [],
      },
    ]),
  ).toStrictEqual(['missing contract entry: packages/contract/src/light/index.ts does not exist']);
});

test('it reports a reached file outside the package and the import that reaches it', () => {
  expect(
    checkContractReach([
      {
        entry: 'packages/contract/src/index.ts',
        exists: true,
        imports: new Map([
          ['packages/core/src/index.ts', []],
          ['packages/contract/src/index.ts', ['@atc/core']],
        ]),
        unresolved: [],
      },
    ]),
  ).toStrictEqual([
    'undeclared package: packages/contract/src/index.ts imports @atc/core, which @atcx/contract does not depend on',
    'unpublished module: packages/contract/src/index.ts reaches packages/core/src/index.ts, which npm never holds',
  ]);
});

test('it reports an import of a package the contract does not depend on', () => {
  expect(
    checkContractReach([
      {
        entry: 'packages/contract/src/index.ts',
        exists: true,
        imports: new Map([['packages/contract/src/session-id.ts', ['type-fest']]]),
        unresolved: [],
      },
    ]),
  ).toStrictEqual([
    'undeclared package: packages/contract/src/session-id.ts imports type-fest, which @atcx/contract does not depend on',
  ]);
});

test('it lists the unresolved imports of an entry after its other findings', () => {
  expect(
    checkContractReach([
      {
        entry: 'packages/contract/src/index.ts',
        exists: true,
        imports: new Map([['packages/contract/src/index.ts', ['type-fest', './gone']]]),
        unresolved: ['unresolved import: packages/contract/src/index.ts imports ./gone'],
      },
    ]),
  ).toStrictEqual([
    'undeclared package: packages/contract/src/index.ts imports type-fest, which @atcx/contract does not depend on',
    'unresolved import: packages/contract/src/index.ts imports ./gone',
  ]);
});
