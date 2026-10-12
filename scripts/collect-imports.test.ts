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
    nonLiteralLines: [],
    templateLines: [],
  });
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
    nonLiteralLines: [],
    templateLines: [],
  });
});

test('it reports the line of a module reference whose specifier is computed', () => {
  expect(
    collectImports("const name = './a';\n\nexport const A = await import(name);\n"),
  ).toStrictEqual({ specifiers: [], resolveOnly: [], nonLiteralLines: [3], templateLines: [] });
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
    nonLiteralLines: [],
    templateLines: [1, 3],
  });
});

test('it ignores import text inside comments and strings', () => {
  expect(
    collectImports("// import { a } from './a';\nexport const TEXT = \"import b from './b'\";\n"),
  ).toStrictEqual({ specifiers: [], resolveOnly: [], nonLiteralLines: [], templateLines: [] });
});
