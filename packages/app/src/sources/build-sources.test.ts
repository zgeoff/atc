import { expect, mock, test } from 'bun:test';
import type { SourceProvider } from '@atc/plugin-api';
import { buildSources } from './build-sources';

test('it offers the available sources in the default order when the config gives none', () => {
  const git: SourceProvider = {
    id: 'git',
    label: 'git URL',
    kind: 'git',
    list: mock(),
    interpret: mock(),
  };

  const dirs: SourceProvider = {
    id: 'dirs',
    label: 'directory on the daemon host',
    kind: 'path',
    list: mock(),
    interpret: mock(),
  };

  const github: SourceProvider = {
    id: 'github',
    label: 'GitHub repository',
    kind: 'git',
    list: mock(),
    interpret: mock(),
  };

  const built = buildSources([git, dirs, github], null);

  expect(built).toStrictEqual({ sources: [dirs, github, git], missing: [] });
});

test('it leaves a source the default order holds out silently when it is not available', () => {
  const git: SourceProvider = {
    id: 'git',
    label: 'git URL',
    kind: 'git',
    list: mock(),
    interpret: mock(),
  };

  const built = buildSources([git], null);

  expect(built).toStrictEqual({ sources: [git], missing: [] });
});

test('it offers only the configured sources in the configured order and reports ids it lacks', () => {
  const git: SourceProvider = {
    id: 'git',
    label: 'git URL',
    kind: 'git',
    list: mock(),
    interpret: mock(),
  };

  const dirs: SourceProvider = {
    id: 'dirs',
    label: 'directory on the daemon host',
    kind: 'path',
    list: mock(),
    interpret: mock(),
  };

  const github: SourceProvider = {
    id: 'github',
    label: 'GitHub repository',
    kind: 'git',
    list: mock(),
    interpret: mock(),
  };

  const built = buildSources([git, dirs, github], ['git', 'gitlab', 'dirs', 'git']);

  expect(built).toStrictEqual({ sources: [git, dirs], missing: ['gitlab'] });
});
