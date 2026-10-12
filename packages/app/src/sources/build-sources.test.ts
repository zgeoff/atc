import { expect, test } from 'bun:test';
import { buildSources } from './build-sources';
import { buildDirsSource } from './dirs/build-dirs-source';
import { buildGitSource } from './git/build-git-source';
import { buildGitHubSource } from './github/build-github-source';

test('it offers the available sources in the default order when the config gives none', () => {
  const git = buildGitSource();

  const dirs = buildDirsSource({
    roots: [],
    collectZoxideDirs: () => Promise.resolve([]),
    homeDir: '/home/tester',
  });

  const github = buildGitHubSource({ bin: 'gh', owner: null });
  const built = buildSources([git, dirs, github], null);

  expect(built).toStrictEqual({ sources: [dirs, github, git], missing: [] });
});

test('it leaves a source the default order holds out silently when it is not available', () => {
  const git = buildGitSource();
  const built = buildSources([git], null);

  expect(built).toStrictEqual({ sources: [git], missing: [] });
});

test('it offers only the configured sources in the configured order and reports ids it lacks', () => {
  const git = buildGitSource();

  const dirs = buildDirsSource({
    roots: [],
    collectZoxideDirs: () => Promise.resolve([]),
    homeDir: '/home/tester',
  });

  const github = buildGitHubSource({ bin: 'gh', owner: null });
  const built = buildSources([git, dirs, github], ['git', 'gitlab', 'dirs', 'git']);

  expect(built).toStrictEqual({ sources: [git, dirs], missing: ['gitlab'] });
});
