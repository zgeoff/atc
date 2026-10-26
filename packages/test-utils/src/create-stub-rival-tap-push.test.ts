import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createGitFixture } from './create-git-fixture';
import { createStubRivalTapPush } from './create-stub-rival-tap-push';
import { runCommand } from './run-command';

async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-stub-rival-tap-push-' });

  return { fixture };
}

test('it pushes the rival formula once, before the first push, which then fails', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.fixture.work, 'Formula/atc.rb'), 'release\n');

  await runCommand(['git', 'add', 'Formula/atc.rb'], {
    cwd: ctx.fixture.work,
    env: ctx.fixture.env,
  });

  await runCommand(['git', 'commit', '-q', '-m', 'release'], {
    cwd: ctx.fixture.work,
    env: ctx.fixture.env,
  });

  const rival = createStubRivalTapPush(join(ctx.fixture.directory, 'rival'), {
    remote: ctx.fixture.upstream,
    formula: 'rival\n',
  });

  const env = { ...ctx.fixture.env, GIT_CONFIG_GLOBAL: rival.gitConfig };

  const first = await runCommand(['git', 'push', '-q', 'origin', 'main'], {
    cwd: ctx.fixture.work,
    env,
  });

  const second = await runCommand(['git', 'push', '-q', 'origin', 'main'], {
    cwd: ctx.fixture.work,
    env,
  });

  const held = await runCommand(
    ['git', '--git-dir', ctx.fixture.upstream, 'show', 'main:Formula/atc.rb'],
    { env: ctx.fixture.env },
  );

  const subjects = await runCommand(
    ['git', '--git-dir', ctx.fixture.upstream, 'log', '--format=%s', 'main'],
    { env: ctx.fixture.env },
  );

  expect(first.exitCode).not.toBe(0);
  expect(second.exitCode).not.toBe(0);
  expect(held.stdout).toBe('rival\n');
  expect(subjects.stdout).toBe('rival\ninitial\n');
});
