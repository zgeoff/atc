import { expect, test } from 'bun:test';
import { spawnDaemonSession } from '@atc/app/test-utils/spawn-daemon-session';
import { startTUIDaemon } from '@atc/app/test-utils/start-tui-daemon';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { createDaemonClient } from '@atc/protocol/client';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';

// The client attaches to a daemon in the test's process, so a boot loads one process instead of
// two. The stand-in claude echoes each line it reads as `GOT:<line>`, so a line typed with escape
// sequences makes the session write those sequences.
async function setupTest() {
  const tui = startTUIHarness({ createStateDB: createMigratedStateDB });

  await startTUIDaemon(tui);

  const client = tui.boot();

  await tui.waitFor('atc — control tower');

  const sessionID = await spawnDaemonSession(tui, 'shown');

  const attach = async () => {
    tui.write(KEYS.ctrlSpace);

    await tui.waitFor('┌ sessions ');

    tui.resetScreen();
    tui.write(KEYS.enter);
  };

  return { tui, client, sessionID, attach };
}

test('it shows the screen of the session it attaches to', async () => {
  const ctx = await setupTest();

  await ctx.attach();
  await ctx.tui.waitFor('FAKE_CLAUDE_UP args:');

  expect(ctx.tui.read().split('\n').at(-30)).toStartWith('FAKE_CLAUDE_UP args:');
});

test('it shows the main screen again after a reattach when the session left the alternate screen', async () => {
  const ctx = await setupTest();

  await ctx.attach();
  await ctx.tui.waitFor('FAKE_CLAUDE_UP args:');

  ctx.tui.write(`${KEYS.esc}[?1049hALT_ONLY${KEYS.enter}`);

  // the terminal echoes a typed line before the session reads it, and the session reads in order,
  // so its answer to a second line shows it entered the alternate screen
  ctx.tui.write(`MARKER${KEYS.enter}`);

  await ctx.tui.waitFor('GOT:MARKER');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('┌ sessions ');

  ctx.tui.resetScreen();
  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('ALT_ONLY');

  ctx.tui.resetScreen();
  ctx.tui.write(`${KEYS.esc}[?1049l${KEYS.enter}`);

  await ctx.tui.waitFor('FAKE_CLAUDE_UP args:');

  expect(ctx.tui.read()).not.toInclude('GOT:MARKER');
});

test('it mirrors the input modes of the session while it has focus and resets them when the list opens', async () => {
  const ctx = await setupTest();

  await ctx.attach();
  await ctx.tui.waitFor('FAKE_CLAUDE_UP args:');

  ctx.tui.reset();
  ctx.tui.write(`${KEYS.esc}[?2004h${KEYS.esc}[?1h${KEYS.enter}`);

  await ctx.tui.waitFor(`${KEYS.esc}[?2004h`);
  await ctx.tui.waitFor(`${KEYS.esc}[?1h`);

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor(`${KEYS.esc}[?2004l`);

  expect(ctx.tui.read()).toInclude(`${KEYS.esc}[?1l`);
});

test('it resets the mirrored input modes and exits from the list', async () => {
  const ctx = await setupTest();

  await ctx.attach();
  await ctx.tui.waitFor('FAKE_CLAUDE_UP args:');

  ctx.tui.write(`${KEYS.esc}[?2004h${KEYS.esc}[?1h${KEYS.enter}`);

  await ctx.tui.waitFor(`${KEYS.esc}[?1h`);

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('┌ sessions ');

  ctx.tui.reset();
  ctx.tui.write('q');

  const exitCode = await ctx.tui.waitForExit();

  expect([exitCode, ctx.tui.read()]).toStrictEqual([0, expect.stringContaining(`${KEYS.esc}[?1l`)]);
});

test('it opens the list on the leader key in the kitty encoding while the session has kitty flags set', async () => {
  const ctx = await setupTest();

  await ctx.attach();
  await ctx.tui.waitFor('FAKE_CLAUDE_UP args:');

  ctx.tui.write(`${KEYS.esc}[>1u${KEYS.enter}`);

  await ctx.tui.waitFor('GOT:');

  ctx.tui.write(`${KEYS.esc}[32;5u`);

  await ctx.tui.waitFor('┌ sessions ');
});

test('it keeps an answer of the terminal that arrives late out of the session', async () => {
  const ctx = await setupTest();

  await ctx.attach();
  await ctx.tui.waitFor('FAKE_CLAUDE_UP args:');

  ctx.tui.write(`${KEYS.esc}]11;rgb:1111/2222/3333${KEYS.bel}typed${KEYS.enter}`);

  await ctx.tui.waitFor('GOT:typed');
});

test('it keeps the last row of the terminal for the fleet bar, out of the session', async () => {
  const ctx = await setupTest();

  await ctx.attach();
  await ctx.tui.waitFor('FAKE_CLAUDE_UP args:');

  const viewer = createDaemonClient(ctx.tui.paths.daemonSocketPath);

  registerTestCleanup(() => {
    viewer.stop();
  });

  await viewer.sendHello('atc/test');

  const screen = await viewer.sendRequest('session.screen', { session: ctx.sessionID });

  expect([screen['rows'], ctx.tui.read().split('\n').at(-1)]).toStrictEqual([
    29,
    expect.stringContaining('^Space'),
  ]);
});
