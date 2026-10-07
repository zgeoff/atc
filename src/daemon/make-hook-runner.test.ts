import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventMsg } from '../protocol/protocol';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { makeHookRunner } from './make-hook-runner';

// A temp directory for the hooks to write into, and the commands a runner
// call started, which resolve once every one of them has exited.
function setupTest() {
  const tmp = setupTempDir('atc-hook-runner-');
  const settled = Promise.withResolvers<readonly string[]>();

  return {
    dir: tmp.dir,
    settled: settled.promise,
    onSettled: (_event: EventMsg, commands: readonly string[]) => {
      settled.resolve(commands);
    },
    [Symbol.asyncDispose]: tmp[Symbol.asyncDispose],
  };
}

test('it runs a hook with the event JSON on stdin and the event name in the environment', async () => {
  await using ctx = setupTest();

  const out = join(ctx.dir, 'out');

  const run = makeHookRunner(
    { SessionAttached: [{ command: `cat > '${out}'; printf '%s\n' "$ATC_EVENT" >> '${out}'` }] },
    ctx.onSettled,
  );

  run(
    { v: 4, ev: 'SessionAttached', session: { id: 's1', cwd: '/w' } },
    { cwd: '/w', repoRoot: '/w' },
  );

  await ctx.settled;

  expect(readFileSync(out, 'utf8')).toBe(
    `${JSON.stringify({ v: 4, ev: 'SessionAttached', session: { id: 's1', cwd: '/w' } })}\nSessionAttached\n`,
  );
});

test('it runs a dir hook when the session repo root or cwd sits at or under the dir', async () => {
  await using ctx = setupTest();

  const run = makeHookRunner(
    {
      SessionAttached: [
        { command: `touch '${join(ctx.dir, 'exact')}'`, dir: '/w/repo' },
        { command: `touch '${join(ctx.dir, 'above')}'`, dir: '/w' },
      ],
    },
    ctx.onSettled,
  );

  run({ v: 4, ev: 'SessionAttached' }, { cwd: '/w/repo/sub', repoRoot: '/w/repo' });

  await ctx.settled;

  expect([existsSync(join(ctx.dir, 'exact')), existsSync(join(ctx.dir, 'above'))]).toStrictEqual([
    true,
    true,
  ]);
});

test('it skips a dir hook when the session path only shares a string prefix', async () => {
  await using ctx = setupTest();

  const run = makeHookRunner(
    {
      SessionAttached: [
        { command: `touch '${join(ctx.dir, 'trap')}'`, dir: '/w/b' },
        { command: `touch '${join(ctx.dir, 'control')}'` },
      ],
    },
    ctx.onSettled,
  );

  run({ v: 4, ev: 'SessionAttached' }, { cwd: '/w/bc', repoRoot: '/w/bc' });

  const commands = await ctx.settled;

  expect(commands).toStrictEqual([`touch '${join(ctx.dir, 'control')}'`]);
  expect(existsSync(join(ctx.dir, 'trap'))).toBeFalse();
  expect(existsSync(join(ctx.dir, 'control'))).toBeTrue();
});

test('it skips dir hooks for an event that carries no session', async () => {
  await using ctx = setupTest();

  const run = makeHookRunner(
    {
      PermissionResolved: [
        { command: `touch '${join(ctx.dir, 'trap')}'`, dir: '/w' },
        { command: `touch '${join(ctx.dir, 'control')}'` },
      ],
    },
    ctx.onSettled,
  );

  run({ v: 4, ev: 'PermissionResolved', request: 'r1', decision: 'allow' }, null);

  const commands = await ctx.settled;

  expect(commands).toStrictEqual([`touch '${join(ctx.dir, 'control')}'`]);
  expect(existsSync(join(ctx.dir, 'trap'))).toBeFalse();
  expect(existsSync(join(ctx.dir, 'control'))).toBeTrue();
});

test('it runs nothing for an event with no configured hooks', async () => {
  await using ctx = setupTest();

  const run = makeHookRunner(
    { SessionAttached: [{ command: `touch '${join(ctx.dir, 'trap')}'` }] },
    ctx.onSettled,
  );

  run({ v: 4, ev: 'SessionState', session: { id: 's1' } }, { cwd: '/w', repoRoot: '/w' });

  const commands = await ctx.settled;

  expect(commands).toBeEmpty();
  expect(existsSync(join(ctx.dir, 'trap'))).toBeFalse();
});

test('it kills a hook that runs past its timeout', async () => {
  await using ctx = setupTest();

  const out = join(ctx.dir, 'out');

  const run = makeHookRunner(
    {
      SessionAttached: [{ command: `printf start >> '${out}'; exec sleep 30`, timeout: 500 }],
    },
    ctx.onSettled,
  );

  run({ v: 4, ev: 'SessionAttached' }, null);

  await ctx.settled;

  expect(readFileSync(out, 'utf8')).toBe('start');
});
