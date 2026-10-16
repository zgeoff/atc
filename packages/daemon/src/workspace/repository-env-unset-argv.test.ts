import { expect, test } from 'bun:test';
import { REPOSITORY_ENV_UNSET_ARGV } from './repository-env-unset-argv';

test('it unsets the variables that pin git to another repository', async () => {
  const run = Bun.spawn([...REPOSITORY_ENV_UNSET_ARGV, 'env'], {
    env: { PATH: process.env['PATH'], GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere' },
  });

  const output = await new Response(run.stdout).text();

  expect(output.split('\n')).toStrictEqual([`PATH=${process.env['PATH'] ?? ''}`, '']);
});
