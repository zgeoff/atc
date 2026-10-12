import { expect, test } from 'bun:test';
import { buildMockHostServices } from '@atc/test-utils/build-mock-host-services';
import { buildStubGHCommand } from '@atc/test-utils/build-stub-gh-command';
import { GITHUB_SOURCE_PLUGIN } from './github-source-plugin';

test('it reads a slice with no owner as the gh account', () => {
  const schema = GITHUB_SOURCE_PLUGIN.configSchema({
    authProfiles: new Map(),
    entryID: 'github',
    foreignFields: new Set(),
  });

  expect(schema.safeParse({ owner: null, bin: 'gh' }).data).toStrictEqual({
    owner: null,
    bin: 'gh',
  });
});

test("it lists the configured owner's repositories through gh run by the host command runner", async () => {
  const gh = buildStubGHCommand({
    replies: {
      repo: {
        stdout:
          '[{"nameWithOwner":"acme/app","description":"","isPrivate":false,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"}]\n',
      },
    },
  });

  const source = GITHUB_SOURCE_PLUGIN.create(
    { owner: 'acme', bin: 'gh' },
    buildMockHostServices({ runCommand: gh.runCommand }),
    { authProfiles: new Map() },
  );

  const listed = await source.list(
    {},
    { target: 'local', collectSpawnDirs: () => Promise.resolve([]) },
  );

  expect(listed).toStrictEqual({
    candidates: [
      { label: 'acme/app', pick: { kind: 'git', url: 'https://github.com/acme/app.git' } },
    ],
    scope: 'acme',
  });
});
