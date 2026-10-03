import { expect, test } from 'bun:test';
import { buildSources } from './build-sources';
import { buildGitSource } from './git/build-git-source';
import type { SourceProvider } from './types';

test('it offers the available sources in the default order when the config gives none', () => {
  const available: SourceProvider[] = [
    buildGitSource(),
    { ...buildGitSource(), id: 'dirs' },
    { ...buildGitSource(), id: 'github' },
  ];

  const built = buildSources(available, null);

  expect(built.sources.map((source) => source.id)).toStrictEqual(['dirs', 'github', 'git']);
  expect(built.missing).toStrictEqual([]);
});

test('it leaves a source the default order holds out silently when it is not available', () => {
  const built = buildSources([buildGitSource()], null);

  expect(built.sources.map((source) => source.id)).toStrictEqual(['git']);
  expect(built.missing).toStrictEqual([]);
});

test('it offers only the configured sources in the configured order and reports ids it lacks', () => {
  const available: SourceProvider[] = [
    buildGitSource(),
    { ...buildGitSource(), id: 'dirs' },
    { ...buildGitSource(), id: 'github' },
  ];

  const built = buildSources(available, ['git', 'gitlab', 'dirs', 'git']);

  expect(built.sources.map((source) => source.id)).toStrictEqual(['git', 'dirs']);
  expect(built.missing).toStrictEqual(['gitlab']);
});
