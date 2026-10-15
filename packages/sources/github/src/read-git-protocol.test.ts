import { expect, test } from 'bun:test';
import { buildStubGHCommand } from '@atc/test-utils';
import { readGitProtocol } from './read-git-protocol';

test.each([
  ['ssh', 'ssh', { stdout: 'ssh\n' }],
  ['https', 'https', { stdout: 'https\n' }],
  ['nothing', 'https', { stdout: '' }],
  ['a failure', 'https', { stdout: 'ssh\n', exitCode: 1 }],
] as const)('it reads %s from the gh config as %s', async (_label, expected, reply) => {
  const gh = buildStubGHCommand({ replies: { config: reply } });

  const protocol = await readGitProtocol(gh.runCommand, 'gh', 1000);

  expect(protocol).toBe(expected);
});

test('it reads https from a gh that takes too long', async () => {
  const gh = buildStubGHCommand({ replies: { config: 'hang' } });

  const protocol = await readGitProtocol(gh.runCommand, 'gh', 1);

  expect(protocol).toBe('https');
});
