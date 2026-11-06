import { expect, test } from 'bun:test';
import { collectSources } from './collect-sources';

test('it applies the defaults to each built-in id and keeps the map order', () => {
  expect(collectSources({ git: {}, github: {}, dirs: {} }, '/home/someone')).toStrictEqual({
    sources: [
      { id: 'git', kind: 'git' },
      { id: 'github', kind: 'github', owner: null, bin: 'gh' },
      { id: 'dirs', kind: 'dirs', roots: [] },
    ],
    errors: [],
  });
});

test('it loads a GitHub entry of another id with its owner and bin', () => {
  expect(
    collectSources(
      { acme: { kind: 'github', owner: 'acme-tools', bin: '/opt/gh/bin/gh' } },
      '/home/someone',
    ),
  ).toStrictEqual({
    sources: [{ id: 'acme', kind: 'github', owner: 'acme-tools', bin: '/opt/gh/bin/gh' }],
    errors: [],
  });
});

test('it expands a leading tilde in a root to the home', () => {
  expect(
    collectSources({ dirs: { roots: ['~/code/', '/srv/work'] } }, '/home/someone'),
  ).toStrictEqual({
    sources: [{ id: 'dirs', kind: 'dirs', roots: ['/home/someone/code', '/srv/work'] }],
    errors: [],
  });
});

test.each([
  ['an unknown field', { dirs: { depth: 2 } }, 'sources.dirs: unknown field depth'],
  [
    'a field of another kind',
    { dirs: { owner: 'acme-tools' } },
    'sources.dirs: owner is not valid for kind dirs',
  ],
  [
    'a wrong-typed roots',
    { dirs: { roots: '~/code' } },
    'sources.dirs: roots must be an array of non-empty strings',
  ],
  [
    'an empty root',
    { dirs: { roots: [''] } },
    'sources.dirs: roots must be an array of non-empty strings',
  ],
  [
    'an owner that is not a login',
    { github: { owner: 'acme/tools' } },
    'sources.github: owner is not a GitHub account or organization',
  ],
  ['a wrong-typed bin', { github: { bin: 7 } }, 'sources.github: bin must be a non-empty string'],
  [
    'a contradicting kind',
    { github: { kind: 'git' } },
    'sources.github: kind git contradicts the id github',
  ],
  [
    'an unknown kind',
    { forge: { kind: 'gitlab' } },
    'sources.forge: kind must be dirs, git, or github',
  ],
  [
    'no kind on another id',
    { forge: {} },
    'sources.forge: kind is required for an id other than dirs, git, or github',
  ],
  ['an id of digits alone', { '42': { kind: 'git' } }, 'sources.42: the id cannot be digits alone'],
  ['an empty id', { '': { kind: 'git' } }, 'sources.: the id must be 1 to 64 characters'],
  [
    'an id over 64 characters',
    { ['a'.repeat(65)]: { kind: 'git' } },
    `sources.${'a'.repeat(65)}: the id must be 1 to 64 characters`,
  ],
  ['an entry that is not an object', { git: true }, 'sources.git: the entry must be an object'],
])('it leaves out an entry with %s with one line and loads the others', (_case, raw, error) => {
  expect(collectSources({ ...raw, tools: { kind: 'git' } }, '/home/someone')).toStrictEqual({
    sources: [{ id: 'tools', kind: 'git' }],
    errors: [error],
  });
});

test('it leaves out an entry named __proto__', () => {
  expect(collectSources(JSON.parse('{ "__proto__": { "kind": "git" }, "git": {} }'))).toStrictEqual(
    {
      sources: [{ id: 'git', kind: 'git' }],
      errors: ['sources.__proto__: the id cannot be used'],
    },
  );
});

test('it reports each bad field of one entry on its own line', () => {
  expect(collectSources({ github: { owner: 7, bin: '', depth: 2 } })).toStrictEqual({
    sources: [],
    errors: [
      'sources.github: owner is not a GitHub account or organization',
      'sources.github: bin must be a non-empty string',
      'sources.github: unknown field depth',
    ],
  });
});

test('it leaves out a second dirs entry and keeps the first', () => {
  expect(
    collectSources({ dirs: {}, work: { kind: 'dirs', roots: ['/srv/work'] } }, '/home/someone'),
  ).toStrictEqual({
    sources: [{ id: 'dirs', kind: 'dirs', roots: [] }],
    errors: ['sources.work: only one dirs source is allowed'],
  });
});

test.each([[null], [[]], ['dirs'], [7]])(
  'it leaves the registry empty for a sources value of %p',
  (raw) => {
    expect(collectSources(raw)).toStrictEqual({
      sources: [],
      errors: ['sources must be an object of source entries'],
    });
  },
);
