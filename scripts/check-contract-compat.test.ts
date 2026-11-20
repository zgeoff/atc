import { expect, test } from 'bun:test';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '@atc/core/test-utils/run-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';

async function setupTest() {
  const temporaryDirectory = setupTempDir('check-contract-compat-');
  const directory = temporaryDirectory.path;

  const git = (...args: string[]) =>
    runCommand(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: directory,
    });

  const writeContract = (inputFields: string, eventKinds = "z.object({ ev: z.literal('A') })") =>
    Bun.write(
      join(directory, 'packages/contract/src/index.ts'),
      [
        "import { oc } from '@orpc/contract';",
        "import { z } from 'zod';",
        'export const DAEMON_CONTRACT = {',
        '  session: {',
        `    spawn: oc.input(z.object({ ${inputFields} })).output(z.object({ id: z.string() })),`,
        '  },',
        '};',
        `export const DAEMON_EVENT_SCHEMA = z.discriminatedUnion('ev', [${eventKinds}]);`,
        '',
      ].join('\n'),
    );

  symlinkSync(join(import.meta.dir, '../node_modules'), join(directory, 'node_modules'));

  await git('init', '--quiet');
  await writeContract('cwd: z.string(), name: z.string().optional()');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'feat: add the contract');
  await git('tag', '@zgeoff/atc@1.0.0');

  symlinkSync(
    join(import.meta.dir, '../packages/contract/node_modules'),
    join(directory, 'packages/contract/node_modules'),
  );

  return {
    writeContract,
    commit: async (message: string) => {
      await git('add', '-A');
      await git('commit', '--quiet', '-m', message);
    },
    check: (env: Record<string, string> = {}) =>
      runCommand([process.execPath, join(import.meta.dir, 'check-contract-compat.ts'), directory], {
        env: { ...process.env, ...env },
      }),
  };
}

test('it passes a contract that did not change since the release', async () => {
  const ctx = await setupTest();

  await ctx.writeContract('cwd: z.string(), name: z.string().optional()');
  await ctx.commit('fix: touch nothing');

  const checked = await ctx.check();

  expect(checked).toMatchObject({
    exitCode: 0,
    stdout: 'check-contract-compat: against @zgeoff/atc@1.0.0, 0 failures\n',
  });
});

test('it fails a removed field', async () => {
  const ctx = await setupTest();

  await ctx.writeContract('cwd: z.string()');
  await ctx.commit('refactor: drop a field');

  const checked = await ctx.check();

  expect(checked).toMatchObject({
    exitCode: 1,
    stderr: 'session.spawn name: input: the field is removed or renamed\n',
  });
});

test('it fails a new input field that no list holds', async () => {
  const ctx = await setupTest();

  await ctx.writeContract(
    'cwd: z.string(), name: z.string().optional(), region: z.string().optional()',
  );

  await ctx.commit('feat: add a field');

  const checked = await ctx.check();

  expect(checked).toMatchObject({
    exitCode: 1,
    stderr:
      'session.spawn region: a new input field with neither a FEATURE_INPUT_FIELDS entry nor a harmless-field entry\n',
  });
});

test('it passes a removed field when a commit since the release marks a breaking change', async () => {
  const ctx = await setupTest();

  await ctx.writeContract('cwd: z.string()');
  await ctx.commit('feat!: drop a field');

  const checked = await ctx.check();

  expect(checked).toMatchObject({ exitCode: 0 });
});

test('it passes a removed field when the pull request title marks a breaking change', async () => {
  const ctx = await setupTest();

  await ctx.writeContract('cwd: z.string()');
  await ctx.commit('refactor: drop a field');

  const checked = await ctx.check({ PR_TITLE: 'feat(contract)!: drop a field' });

  expect(checked).toMatchObject({ exitCode: 0 });
});

test('it fails a removed event kind', async () => {
  const ctx = await setupTest();

  await ctx.writeContract(
    'cwd: z.string(), name: z.string().optional()',
    "z.object({ ev: z.literal('B') })",
  );

  await ctx.commit('refactor: swap the event kind');

  const checked = await ctx.check();

  expect(checked).toMatchObject({
    exitCode: 1,
    stderr: 'event: answer: the union variant ev="A" is removed\n',
  });
});
