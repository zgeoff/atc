import { expect, test } from 'bun:test';
import { registerTestCleanup, updateEnv } from '@zgeoff/testing';
import invariant from 'tiny-invariant';
import { createGitAskpass } from './create-git-askpass';

async function setupTest(sourceURL: string) {
  updateEnv('ATC_TEST_ASKPASS_TOKEN', 'tok-c81d');

  const askpass = await createGitAskpass(
    { kind: 'env', name: 'ATC_TEST_ASKPASS_TOKEN' },
    sourceURL,
  );

  invariant(askpass.ok, 'the credential is set, so the helper is created');
  registerTestCleanup(askpass[Symbol.asyncDispose]);

  return {
    async ask(prompt: string) {
      const run = Bun.spawn([askpass.env['GIT_ASKPASS'] ?? '', prompt], {
        env: { ...askpass.env, PATH: process.env['PATH'] ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, exitCode] = await Promise.all([new Response(run.stdout).text(), run.exited]);

      return { stdout, exitCode };
    },
  };
}

test.each([
  ["Password for 'https://github.com': ", 'tok-c81d\n'],
  ["Password for 'https://x-access-token@github.com': ", 'tok-c81d\n'],
  ["Password for 'https://x-access-token@GitHub.com/owner/repo.git': ", 'tok-c81d\n'],
  ["Username for 'https://github.com': ", 'x-access-token\n'],
])('it answers the prompt %s for the source host', async (prompt, answer) => {
  const ctx = await setupTest('https://github.com/owner/repo.git');
  const result = await ctx.ask(prompt);

  expect(result).toStrictEqual({ stdout: answer, exitCode: 0 });
});

test.each([
  [
    'https://github.com:443/owner/repo.git',
    "Password for 'https://x-access-token@github.com:443': ",
  ],
  ['https://github.com/owner/repo.git', "Password for 'https://github.com:443': "],
  ['https://github.com:443/owner/repo.git', "Password for 'https://github.com': "],
  ['http://127.0.0.1:80/upstream.git', "Password for 'http://127.0.0.1:80': "],
])('it answers for source %s the prompt %s', async (sourceURL, prompt) => {
  const ctx = await setupTest(sourceURL);
  const result = await ctx.ask(prompt);

  expect(result).toStrictEqual({ stdout: 'tok-c81d\n', exitCode: 0 });
});

test('it answers a prompt for the source host and port', async () => {
  const ctx = await setupTest('http://127.0.0.1:8080/upstream.git');
  const result = await ctx.ask("Password for 'http://x-access-token@127.0.0.1:8080': ");

  expect(result).toStrictEqual({ stdout: 'tok-c81d\n', exitCode: 0 });
});

test.each([
  ['another host', "Password for 'https://evil.example': "],
  ['a lookalike suffix', "Password for 'https://github.com.evil.example': "],
  ['a lookalike prefix', "Password for 'https://evilgithub.com': "],
  ['a userinfo trick', "Password for 'https://github.com@evil.example': "],
  ['a userinfo trick with a path', "Password for 'https://x@evil.example/github.com': "],
  ['another scheme', "Password for 'http://github.com': "],
  ['another port', "Password for 'https://github.com:8443': "],
  ['a backslash', String.raw`Password for 'https://evil.example\@github.com': `],
  ['a fragment', "Password for 'https://evil.example#@github.com': "],
  ['a query', "Password for 'https://evil.example?@github.com': "],
  ['a username prompt for another host', "Username for 'https://evil.example': "],
])('it refuses the prompt for %s and prints no token', async (_, prompt) => {
  const ctx = await setupTest('https://github.com/owner/repo.git');
  const result = await ctx.ask(prompt);

  expect(result).toStrictEqual({ stdout: '', exitCode: 1 });
});

test.each([
  ['no quoted url', 'Password: '],
  ['no scheme', "Password for 'github.com': "],
  ['an empty host', "Password for 'https://': "],
  ['another kind of prompt', "Passphrase for key '/home/u/.ssh/id': "],
  ['an empty prompt', ''],
  ['no closing quote', "Password for 'https://github.com"],
  ['no trailing colon', "Password for 'https://github.com'"],
  ['text after the closing colon', "Password for 'https://github.com': x"],
])('it refuses a prompt it cannot parse with %s', async (_, prompt) => {
  const ctx = await setupTest('https://github.com/owner/repo.git');
  const result = await ctx.ask(prompt);

  expect(result).toStrictEqual({ stdout: '', exitCode: 1 });
});

test.each([
  ['a local path', '/srv/git/upstream.git'],
  ['an ssh url', 'ssh://git@github.com/owner/repo.git'],
  ['a url it cannot parse', 'not a url'],
])('it refuses every prompt for a source that is %s', async (_, sourceURL) => {
  const ctx = await setupTest(sourceURL);
  const result = await ctx.ask("Password for 'https://github.com': ");

  expect(result).toStrictEqual({ stdout: '', exitCode: 1 });
});
