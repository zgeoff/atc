import { expect, test } from 'bun:test';
import { collectPrincipals } from './collect-principals';

test('it holds no principals when the config sets none', () => {
  expect(collectPrincipals(undefined)).toStrictEqual({ principals: null, errors: [] });
});

test('it reads each principal with the target names it may use', () => {
  expect(
    collectPrincipals({ 'client-a': { targets: ['local', 'box'] }, 'client-b': { targets: [] } }),
  ).toStrictEqual({
    principals: new Map([
      ['client-a', ['local', 'box']],
      ['client-b', []],
    ]),
    errors: [],
  });
});

test.each([
  ['a string', 'client-a'],
  ['an array', [{ targets: ['local'] }]],
  ['null', null],
])('it grants nothing to anyone, with an error, when principals is %s', (_label, raw) => {
  expect(collectPrincipals(raw)).toStrictEqual({
    principals: new Map(),
    errors: ['principals must be an object of principal ids, so no principal gets a target'],
  });
});

test.each([
  ['an entry that is not an object', 'local'],
  ['an entry without targets', { image: 'dev' }],
  ['an entry whose targets is not an array', { targets: 'local' }],
  ['an entry whose targets holds a non-string', { targets: ['local', 3] }],
  ['an entry whose targets holds an empty name', { targets: [''] }],
])('it grants nothing to %s and keeps the other entries', (_label, entry) => {
  expect(
    collectPrincipals({ 'client-a': { targets: ['local'] }, 'client-b': entry }),
  ).toStrictEqual({
    principals: new Map([['client-a', ['local']]]),
    errors: [
      'principal "client-b" must be an object whose targets is an array of target names, so it gets no target',
    ],
  });
});
