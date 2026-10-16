import { expect, test } from 'bun:test';
import { collectImports } from './collect-imports';

test('it collects static, type-only, dynamic and required specifiers', () => {
  expect(
    collectImports(
      [
        "import { a } from './a';",
        "import type { B } from '@atc/core';",
        "export { c } from 'zod';",
        "import './side-effect';",
        "const d = await import('./d');",
        "const e = require('./e');",
        '',
      ].join('\n'),
    ),
  ).toStrictEqual({
    specifiers: ['./a', '@atc/core', 'zod', './side-effect', './d', './e'],
    resolveOnly: [],
    staticLoads: ['./a', 'zod', './side-effect'],
    computedLoadLines: [],
    computedResolveLines: [],
  });
});

test('it counts a statement as type-only only when type is its modifier', () => {
  expect(
    collectImports(
      [
        "export type { A } from './a';",
        "import type from './b';",
        "import type, { c } from './c';",
        "import { type D, e } from './d';",
        '',
      ].join('\n'),
    ).staticLoads,
  ).toStrictEqual(['./b', './c', './d']);
});

test('it counts no load for a statement whose every specifier is type-only', () => {
  expect(
    collectImports(
      [
        "import { type A } from './a';",
        "export { type B, type C as D } from './b';",
        "import { type as as E, type F, } from './c';",
        "export { type G, h } from './d';",
        "import I, { type J } from './e';",
        "import { type as K } from './f';",
        "import { type } from './g';",
        "import {} from './h';",
        '',
      ].join('\n'),
    ).staticLoads,
  ).toStrictEqual(['./d', './e', './f', './g', './h']);
});

test('it marks a specifier that only a resolve form names', () => {
  expect(
    collectImports(
      [
        "const a = Bun.resolveSync('bun-pty/package.json', import.meta.dir);",
        "const b = import.meta.resolve('./b');",
        "const c = new URL('./c.txt', import.meta.url);",
        "import { b } from './b';",
        '',
      ].join('\n'),
    ),
  ).toStrictEqual({
    specifiers: ['bun-pty/package.json', './b', './c.txt'],
    resolveOnly: ['bun-pty/package.json', './c.txt'],
    staticLoads: ['./b'],
    computedLoadLines: [],
    computedResolveLines: [],
  });
});

test('it reports the line of a module reference whose specifier is computed', () => {
  expect(
    collectImports(
      [
        "const name = './a';",
        '',
        'export const A = await import(name);',
        "export const B = require(name.replace('a', 'b'));",
        'export const C = Bun.resolveSync(name, import.meta.dir);',
        '',
      ].join('\n'),
    ),
  ).toStrictEqual({
    specifiers: [],
    resolveOnly: [],
    staticLoads: [],
    computedLoadLines: [3, 4],
    computedResolveLines: [5],
  });
});

test('it reports the line of a module load whose specifier is a template literal', () => {
  expect(
    collectImports(
      [
        'export const FS = await import(`node:fs`);',
        'export const URL_A = new URL(`./a.txt`, import.meta.url);',
        'export const B = require(`./b`);',
        '',
      ].join('\n'),
    ),
  ).toStrictEqual({
    specifiers: ['node:fs', './a.txt', './b'],
    resolveOnly: ['./a.txt'],
    staticLoads: [],
    computedLoadLines: [1, 3],
    computedResolveLines: [],
  });
});

test('it ignores import text inside comments and strings', () => {
  expect(
    collectImports("// import { a } from './a';\nexport const TEXT = \"import b from './b'\";\n"),
  ).toStrictEqual({
    specifiers: [],
    resolveOnly: [],
    staticLoads: [],
    computedLoadLines: [],
    computedResolveLines: [],
  });
});
