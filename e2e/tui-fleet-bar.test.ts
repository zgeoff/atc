import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { createDaemonClient } from '@atc/protocol/client';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';

// Two local targets make two places. 'alt' sorts before 'local', so a bar that starts with
// 'local' starts with the place of the attached session.
function setupTest() {
  const tui = startTUIHarness({ createStateDB: createMigratedStateDB });

  tui.writeConfig({
    targets: { local: { provider: 'local-pty' }, alt: { provider: 'local-pty', tag: 'alt' } },
    defaultTarget: 'local',
  });

  tui.boot();

  const spawnOn = async (target: string, name: string) => {
    const daemon = createDaemonClient(join(tui.home, 'atc-daemon.sock'));

    try {
      await daemon.sendHello('atc/test');

      await daemon.sendRequest('session.spawn', {
        cwd: tui.home,
        name,
        cols: 80,
        rows: 24,
        target,
      });
    } finally {
      daemon.stop();
    }
  };

  const attachFirst = async () => {
    tui.write(KEYS.ctrlSpace);

    await tui.waitFor('╭─ ');

    tui.resetScreen();
    tui.write(KEYS.enter);

    await tui.waitFor('FAKE_CLAUDE_UP');
    await tui.waitForGone('╭─ ');
  };

  const readLastRow = () => tui.read().split('\n').at(-1) ?? '';

  return { tui, spawnOn, attachFirst, readLastRow };
}

test('it draws the fleet bar on the last row while attached, with the attached place first', async () => {
  const ctx = setupTest();

  await ctx.tui.waitFor('n  new');
  await ctx.spawnOn('local', 'here');
  await ctx.attachFirst();
  await ctx.spawnOn('alt', 'there');
  await ctx.tui.waitFor('alt');

  expect(ctx.readLastRow()).toMatch(/^ {2}local(?: \S)+ {2}alt(?: \S)+ +\^Space\s*$/u);
});

test('it shows ◆ and the count on the right when a session needs you', async () => {
  const ctx = setupTest();

  await ctx.tui.waitFor('n  new');
  await ctx.spawnOn('local', 'here');
  await ctx.attachFirst();
  await ctx.spawnOn('alt', 'needy');
  await ctx.tui.waitFor('◆ 1 need you');

  expect(ctx.readLastRow()).toMatch(
    /^ {2}local(?: \S)+ {2}alt(?: \S)+ +◆ 1 need you {3}\^Space\s*$/u,
  );
});

test('it draws no fleet bar on home', async () => {
  const ctx = setupTest();

  await ctx.tui.waitFor('n  new');
  await ctx.spawnOn('alt', 'needy');
  await ctx.tui.waitFor('1 need you');

  expect(ctx.readLastRow()).not.toInclude('◆');
});

test('it keeps the fleet bar on the last row while the session list is open over the session', async () => {
  const ctx = setupTest();

  await ctx.tui.waitFor('n  new');
  await ctx.spawnOn('local', 'here');
  await ctx.attachFirst();

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('╭─ ');

  expect(ctx.readLastRow()).toMatch(/^ {2}local(?: \S)+ +\^Space\s*$/u);
});
