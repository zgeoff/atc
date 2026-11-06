import { expect, test } from 'bun:test';
import { buildLegacySources } from './build-legacy-sources';

test('it moves the roots and the owner into their entries and lists the old keys in file order', () => {
  expect(
    buildLegacySources({
      workspaces: { sources: null, root: '~/ws', githubOwner: 'acme-tools' },
      leader: 'ctrl-a',
      dirs: { roots: ['~/code'] },
    }),
  ).toStrictEqual({
    keys: ['workspaces.sources', 'workspaces.githubOwner', 'dirs'],
    sources: { dirs: { roots: ['~/code'] }, github: { owner: 'acme-tools' }, git: {} },
    problems: [],
  });
});

test('it gives a file with no old key the three built-in sources and no keys', () => {
  expect(buildLegacySources({ leader: 'ctrl-a' })).toStrictEqual({
    keys: [],
    sources: { dirs: {}, github: {}, git: {} },
    problems: [],
  });
});

test('it keeps the order of a source list and lists each id once', () => {
  expect(buildLegacySources({ workspaces: { sources: ['git', 'dirs', 'git'] } })).toStrictEqual({
    keys: ['workspaces.sources'],
    sources: { git: {}, dirs: {} },
    problems: [],
  });
});

test.each([['dirs'], [['dirs', 7]], [['dirs', '']]])(
  'it reads the default order from a source list of %p',
  (order) => {
    expect(buildLegacySources({ workspaces: { sources: order } }).sources).toStrictEqual({
      dirs: {},
      github: {},
      git: {},
    });
  },
);

test('it skips a root that is not a non-empty string, as the old parse did', () => {
  expect(buildLegacySources({ dirs: { roots: ['/srv/work', 7, ''] } }).sources).toStrictEqual({
    dirs: { roots: ['/srv/work'] },
    github: {},
    git: {},
  });
});

test.each([['acme/tools'], [7]])('it leaves out an owner of %p with one line', (owner) => {
  expect(buildLegacySources({ workspaces: { githubOwner: owner } })).toStrictEqual({
    keys: ['workspaces.githubOwner'],
    sources: { dirs: {}, github: {}, git: {} },
    problems: ['workspaces.githubOwner is not a GitHub account or organization; it is left out'],
  });
});

test('it leaves out an id with no source and names it', () => {
  expect(buildLegacySources({ workspaces: { sources: ['forge', 'git'] } })).toStrictEqual({
    keys: ['workspaces.sources'],
    sources: { git: {} },
    problems: [
      "workspaces.sources holds 'forge', which is not a source atc offers; it is left out",
    ],
  });
});
