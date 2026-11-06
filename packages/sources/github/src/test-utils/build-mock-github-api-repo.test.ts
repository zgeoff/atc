import { expect, test } from 'bun:test';
import { buildMockGitHubAPIRepo } from './build-mock-github-api-repo';

test('it builds a default GitHub API repository', () => {
  expect(buildMockGitHubAPIRepo()).toStrictEqual({
    full_name: expect.stringMatching(/^[^/\s]+\/[^/\s]+$/u),
    description: expect.toBeString(),
    private: expect.toBeBoolean(),
    html_url: expect.toStartWith('https://github.com/'),
    ssh_url: expect.toStartWith('git@github.com:'),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockGitHubAPIRepo({ description: null, private: true })).toStrictEqual({
    full_name: expect.toBeString(),
    description: null,
    private: true,
    html_url: expect.toBeString(),
    ssh_url: expect.toBeString(),
  });
});

test('it builds the clone URLs from the full name', () => {
  expect(buildMockGitHubAPIRepo({ full_name: 'acme/app' })).toStrictEqual({
    full_name: 'acme/app',
    description: expect.toBeString(),
    private: expect.toBeBoolean(),
    html_url: 'https://github.com/acme/app',
    ssh_url: 'git@github.com:acme/app.git',
  });
});
