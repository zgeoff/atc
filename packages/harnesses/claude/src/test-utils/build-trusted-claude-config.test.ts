import { expect, test } from 'bun:test';
import { buildTrustedClaudeConfig } from './build-trusted-claude-config';

test('it adds a trust entry for each folder and keeps every other key', () => {
  const config = {
    numStartups: 4,
    projects: {
      '/home/me/projects': { hasTrustDialogAccepted: true, allowedTools: [] },
    },
  };

  expect(
    buildTrustedClaudeConfig(config, ['/work/clone', '/state/sessions/s1/scratch']),
  ).toStrictEqual({
    numStartups: 4,
    projects: {
      '/home/me/projects': { hasTrustDialogAccepted: true, allowedTools: [] },
      '/work/clone': { hasTrustDialogAccepted: true },
      '/state/sessions/s1/scratch': { hasTrustDialogAccepted: true },
    },
  });
});

test("it keeps a folder's other project keys when it trusts the folder", () => {
  const config = {
    projects: {
      '/work/clone': { hasTrustDialogAccepted: false, allowedTools: [] },
    },
  };

  expect(buildTrustedClaudeConfig(config, ['/work/clone'])).toStrictEqual({
    projects: {
      '/work/clone': { hasTrustDialogAccepted: true, allowedTools: [] },
    },
  });
});

test('it adds a projects map to a config that has none', () => {
  expect(buildTrustedClaudeConfig({}, ['/work/clone'])).toStrictEqual({
    projects: { '/work/clone': { hasTrustDialogAccepted: true } },
  });
});
