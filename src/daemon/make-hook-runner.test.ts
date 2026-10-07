import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventMsg } from '../protocol/protocol';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { makeHookRunner } from './make-hook-runner';
import type { HookOutcome } from './make-hook-runner';

// A temp directory for the hooks to write into, the outcomes of the hooks a
// runner call started, which resolve once every one of them has ended, and
// the kills the runner armed, which the test fires in place of the timer.
function setupTest() {
  const tmp = setupTempDir('atc-hook-runner-');
  const settled = Promise.withResolvers<readonly HookOutcome[]>();
  const kills: { readonly kill: () => void; readonly timeoutMs: number }[] = [];

  return {
    dir: tmp.dir,
    settled: settled.promise,
    kills,
    options: {
      onSettled: (_event: EventMsg, outcomes: readonly HookOutcome[]) => {
        settled.resolve(outcomes);
      },
      scheduleKill: (kill: () => void, timeoutMs: number) => {
        kills.push({ kill, timeoutMs });

        return () => {};
      },
    },
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test('it runs a hook with the event JSON on stdin and the event name in the environment', async () => {
  using ctx = setupTest();

  const out = join(ctx.dir, 'out');

  const run = makeHookRunner(
    { SessionAttached: [{ command: `cat > '${out}'; printf '%s\n' "$ATC_EVENT" >> '${out}'` }] },
    ctx.options,
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
  using ctx = setupTest();

  const run = makeHookRunner(
    {
      SessionAttached: [
        { command: `touch '${join(ctx.dir, 'exact')}'`, dir: '/w/repo' },
        { command: `touch '${join(ctx.dir, 'above')}'`, dir: '/w' },
      ],
    },
    ctx.options,
  );

  run({ v: 4, ev: 'SessionAttached' }, { cwd: '/w/repo/sub', repoRoot: '/w/repo' });

  await ctx.settled;

  expect([existsSync(join(ctx.dir, 'exact')), existsSync(join(ctx.dir, 'above'))]).toStrictEqual([
    true,
    true,
  ]);
});

test('it skips a dir hook when the session path only shares a string prefix', async () => {
  using ctx = setupTest();

  const run = makeHookRunner(
    {
      SessionAttached: [
        { command: `touch '${join(ctx.dir, 'trap')}'`, dir: '/w/b' },
        { command: `touch '${join(ctx.dir, 'control')}'` },
      ],
    },
    ctx.options,
  );

  run({ v: 4, ev: 'SessionAttached' }, { cwd: '/w/bc', repoRoot: '/w/bc' });

  const outcomes = await ctx.settled;

  expect(outcomes).toStrictEqual([
    { command: `touch '${join(ctx.dir, 'control')}'`, exitCode: 0, signalCode: null },
  ]);

  expect(existsSync(join(ctx.dir, 'trap'))).toBeFalse();
  expect(existsSync(join(ctx.dir, 'control'))).toBeTrue();
});

test('it skips dir hooks for an event that carries no session', async () => {
  using ctx = setupTest();

  const run = makeHookRunner(
    {
      PermissionResolved: [
        { command: `touch '${join(ctx.dir, 'trap')}'`, dir: '/w' },
        { command: `touch '${join(ctx.dir, 'control')}'` },
      ],
    },
    ctx.options,
  );

  run({ v: 4, ev: 'PermissionResolved', request: 'r1', decision: 'allow' }, null);

  const outcomes = await ctx.settled;

  expect(outcomes).toStrictEqual([
    { command: `touch '${join(ctx.dir, 'control')}'`, exitCode: 0, signalCode: null },
  ]);

  expect(existsSync(join(ctx.dir, 'trap'))).toBeFalse();
  expect(existsSync(join(ctx.dir, 'control'))).toBeTrue();
});

test('it runs nothing for an event with no configured hooks', async () => {
  using ctx = setupTest();

  const run = makeHookRunner(
    { SessionAttached: [{ command: `touch '${join(ctx.dir, 'trap')}'` }] },
    ctx.options,
  );

  run({ v: 4, ev: 'SessionState', session: { id: 's1' } }, { cwd: '/w', repoRoot: '/w' });

  const outcomes = await ctx.settled;

  expect(outcomes).toBeEmpty();
  expect(existsSync(join(ctx.dir, 'trap'))).toBeFalse();
});

test('it kills a hook that runs past its timeout', async () => {
  using ctx = setupTest();

  const command = 'exec sleep 30';
  const run = makeHookRunner({ SessionAttached: [{ command, timeout: 500 }] }, ctx.options);

  run({ v: 4, ev: 'SessionAttached' }, null);

  for (const armed of ctx.kills) {
    armed.kill();
  }

  const outcomes = await ctx.settled;

  expect({ timeouts: ctx.kills.map((armed) => armed.timeoutMs), outcomes }).toStrictEqual({
    timeouts: [500],
    outcomes: [{ command, exitCode: null, signalCode: 'SIGTERM' }],
  });
});

test('it arms the default timeout for a hook that sets none', async () => {
  using ctx = setupTest();

  const run = makeHookRunner({ SessionAttached: [{ command: 'true' }] }, ctx.options);

  run({ v: 4, ev: 'SessionAttached' }, null);

  await ctx.settled;

  expect(ctx.kills.map((armed) => armed.timeoutMs)).toStrictEqual([10_000]);
});
