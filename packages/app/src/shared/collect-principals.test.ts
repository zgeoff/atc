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

test('it grants nothing to anyone, with an error, when principals is a string', () => {
  expect(collectPrincipals('client-a')).toStrictEqual({
    principals: new Map(),
    errors: ['principals must be an object of principal ids, so no principal gets a target'],
  });
});

test('it grants nothing to anyone, with an error, when principals is an array', () => {
  expect(collectPrincipals([{ targets: ['local'] }])).toStrictEqual({
    principals: new Map(),
    errors: ['principals must be an object of principal ids, so no principal gets a target'],
  });
});

test('it grants nothing to anyone, with an error, when principals is null', () => {
  expect(collectPrincipals(null)).toStrictEqual({
    principals: new Map(),
    errors: ['principals must be an object of principal ids, so no principal gets a target'],
  });
});

test('it grants nothing to an entry that is not an object and keeps the other entries', () => {
  expect(
    collectPrincipals({ 'client-a': { targets: ['local'] }, 'client-b': 'local' }),
  ).toStrictEqual({
    principals: new Map([['client-a', ['local']]]),
    errors: [
      'principal "client-b" must be an object whose targets is an array of target names, so it gets no target',
    ],
  });
});

test('it grants nothing to an entry without targets and keeps the other entries', () => {
  expect(
    collectPrincipals({ 'client-a': { targets: ['local'] }, 'client-b': { image: 'dev' } }),
  ).toStrictEqual({
    principals: new Map([['client-a', ['local']]]),
    errors: [
      'principal "client-b" must be an object whose targets is an array of target names, so it gets no target',
    ],
  });
});

test('it grants nothing to an entry whose targets is not an array and keeps the other entries', () => {
  expect(
    collectPrincipals({ 'client-a': { targets: ['local'] }, 'client-b': { targets: 'local' } }),
  ).toStrictEqual({
    principals: new Map([['client-a', ['local']]]),
    errors: [
      'principal "client-b" must be an object whose targets is an array of target names, so it gets no target',
    ],
  });
});

test('it grants nothing to an entry whose targets holds a non-string and keeps the other entries', () => {
  expect(
    collectPrincipals({
      'client-a': { targets: ['local'] },
      'client-b': { targets: ['local', 3] },
    }),
  ).toStrictEqual({
    principals: new Map([['client-a', ['local']]]),
    errors: [
      'principal "client-b" must be an object whose targets is an array of target names, so it gets no target',
    ],
  });
});

test('it grants nothing to an entry whose targets holds an empty name and keeps the other entries', () => {
  expect(
    collectPrincipals({ 'client-a': { targets: ['local'] }, 'client-b': { targets: [''] } }),
  ).toStrictEqual({
    principals: new Map([['client-a', ['local']]]),
    errors: [
      'principal "client-b" must be an object whose targets is an array of target names, so it gets no target',
    ],
  });
});
