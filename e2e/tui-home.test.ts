import { expect, test } from 'bun:test';
import { spawnClaudeSession } from '@atc/app/test-utils/spawn-claude-session';
import { spawnDaemonSession } from '@atc/app/test-utils/spawn-daemon-session';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { waitFor } from '@zgeoff/testing';

function setupTest(cols = 110, rows = 30) {
  return startTUIHarness({ createStateDB: createMigratedStateDB, cols, rows });
}

test('it shows the fleet line for no sessions and the two keys on home', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('no sessions');
  await ctx.waitFor('^Space  sessions');
  await ctx.waitFor('n  new');

  expect(ctx.readScreen()).not.toInclude('need you');
});

test('it counts the sessions on home and the ones that need you', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('no sessions');

  await spawnDaemonSession(ctx, 'first');

  await ctx.waitFor('1 session');

  await spawnDaemonSession(ctx, 'second');

  await ctx.waitFor('2 sessions');
});

test('it updates the count of sessions that need you when a session enters needs_you', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('no sessions');

  await spawnDaemonSession(ctx, 'needy');

  await ctx.waitFor('1 session  ·  ◆ 1 need you');
});

test('it opens the session list over home when the leader key is pressed', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('n  new');

  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('╭─ ');

  expect(ctx.readScreen()).toInclude('n  new');
});

test('it opens the spawn picker when n is pressed on home', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('n  new');

  ctx.write('n');

  await ctx.waitFor('spawn: agent');
});

test('it keeps home under the session list when the attached session dies while the list is open', async () => {
  const ctx = setupTest();

  ctx.boot();

  await ctx.waitFor('n  new');

  await spawnClaudeSession(ctx, 'doomed');

  ctx.reset();
  ctx.write(KEYS.ctrlSpace);

  await ctx.waitFor('╭─ ');

  ctx.write('K');

  await ctx.waitFor('kill doomed? · y / n');

  ctx.write('y');

  await ctx.waitFor('killed');

  await waitFor(() => {
    const screen = ctx.readScreen();

    expect(screen).toInclude('╭─ ');
    expect(screen).toInclude('n  new');
  });
});

test('it shows the text wordmark in a small window', async () => {
  const ctx = setupTest(30, 9);

  ctx.boot();

  await ctx.waitFor('no sessions');

  expect(
    ctx
      .readScreen()
      .split('\n')
      .map((line) => line.trim()),
  ).toContain('atc');
});
