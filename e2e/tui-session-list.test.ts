import { expect, test } from 'bun:test';
import { spawnDaemonSession } from '@atc/app/test-utils/spawn-daemon-session';
import { startTUIDaemon } from '@atc/app/test-utils/start-tui-daemon';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { KEYS } from '@atc/core/test-utils/keys';
import { createDaemonClient } from '@atc/protocol/client';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';

// The client attaches to a daemon in the test's process, so a boot loads one process instead of
// two. The stand-in claude echoes each line it reads as `GOT:<line>`.
async function setupTest() {
  const tui = startTUIHarness({ createStateDB: createMigratedStateDB });

  await startTUIDaemon(tui);

  tui.boot();

  await tui.waitFor('n  new');

  const daemon = createDaemonClient(tui.paths.daemonSocketPath);

  registerTestCleanup(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const attachFirst = async () => {
    tui.write(KEYS.ctrlSpace);

    await tui.waitFor('╭─ ');

    tui.resetScreen();
    tui.write(KEYS.enter);

    await tui.waitFor('FAKE_CLAUDE_UP args:');
    await tui.waitForGone('╭─ ');
  };

  const readSessionScreen = async (id: string): Promise<string> => {
    const answer = await daemon.sendRequest('session.screen', { session: id });

    return String(answer['text']);
  };

  return { tui, daemon, attachFirst, readSessionScreen };
}

test('it opens the list over an attached session that keeps drawing', async () => {
  const ctx = await setupTest();
  const id = await spawnDaemonSession(ctx.tui, 'shown');

  await ctx.attachFirst();

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('╭─ ');
  await ctx.daemon.sendRequest('session.input', { session: id, data: `ping${KEYS.enter}` });

  await waitFor(() => {
    expect(ctx.tui.readScreen()).toInclude('GOT:ping');
  });

  expect(ctx.tui.readScreen()).toInclude('╭─ ');
  expect(ctx.tui.readScreen()).not.toInclude('n  new');
});

test('it cycles the grouping with g, and shows the place groups with their headers', async () => {
  const ctx = await setupTest();

  await spawnDaemonSession(ctx.tui, 'shown');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('shown');

  ctx.tui.write('g');

  await ctx.tui.waitFor('by repo');

  ctx.tui.write('g');

  await ctx.tui.waitFor('by place');

  expect(ctx.tui.readScreen()).toMatch(/^\s*│ local {2}1/mu);
});

test('it fades the rows a typed letter misses, labels the rest, and attaches the label key', async () => {
  const ctx = await setupTest();

  await spawnDaemonSession(ctx.tui, 'tango');

  const kiteID = await spawnDaemonSession(ctx.tui, 'kite');

  await spawnDaemonSession(ctx.tui, 'mango');

  ctx.tui.write(KEYS.ctrlSpace);

  // The rows settle in their last order before a letter is typed, since a state change reorders them.
  await waitFor(() => {
    expect(ctx.tui.readScreen().match(/needs you: /gu)).toHaveLength(3);
  });

  ctx.tui.write('f');

  await waitFor(() => {
    expect(ctx.tui.readScreen()).toInclude('tango');
  });

  ctx.tui.write('t');

  // The label stands over the letter after each first t, and the row without a t stays as it was.
  const label = await waitFor(() => {
    const screen = ctx.tui.readScreen();
    const match = /kit(?<label>[a-z])(?!\p{L})/u.exec(screen);

    if (
      match?.groups?.['label'] === undefined ||
      !/t[a-z]ngo/u.test(screen) ||
      screen.includes('tango')
    ) {
      throw new Error('no labels over the rows that hold a t');
    }

    return match.groups['label'];
  });

  expect(ctx.tui.readScreen()).toInclude('mango');

  ctx.tui.write(label);

  await ctx.tui.waitForGone('╭─ ');

  ctx.tui.write(`hello${KEYS.enter}`);

  await waitFor(async () => {
    const screen = await ctx.readSessionScreen(kiteID);

    expect(screen).toInclude('GOT:hello');
  });
});

test('it attaches at once the one session a typed letter matches', async () => {
  const ctx = await setupTest();

  await spawnDaemonSession(ctx.tui, 'tango');

  const kiteID = await spawnDaemonSession(ctx.tui, 'kite');

  await spawnDaemonSession(ctx.tui, 'mango');

  ctx.tui.write(KEYS.ctrlSpace);

  await waitFor(() => {
    expect(ctx.tui.readScreen().match(/needs you: /gu)).toHaveLength(3);
  });

  ctx.tui.write('f');
  ctx.tui.write('k');

  await ctx.tui.waitForGone('╭─ ');

  ctx.tui.write(`hello${KEYS.enter}`);

  await waitFor(async () => {
    const screen = await ctx.readSessionScreen(kiteID);

    expect(screen).toInclude('GOT:hello');
  });
});

test('it asks before it ends a dead session, and removes it on y', async () => {
  const ctx = await setupTest();

  await spawnDaemonSession(ctx.tui, 'doomed');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('doomed');

  ctx.tui.write('K');

  await ctx.tui.waitFor('kill doomed? · y / n');

  ctx.tui.write('y');

  await ctx.tui.waitFor('X end');

  ctx.tui.write('X');

  await ctx.tui.waitFor('end doomed? stops the agent and removes it from the list · y / n');

  ctx.tui.write('y');

  await ctx.tui.waitFor('no sessions — n to spawn');

  expect(ctx.tui.readScreen()).not.toInclude('doomed');
});

test('it opens the list on a leader typed in one chunk with the next key, and gives the list that key', async () => {
  const ctx = await setupTest();
  const id = await spawnDaemonSession(ctx.tui, 'shown');

  await ctx.attachFirst();

  ctx.tui.reset();
  ctx.tui.write(`${KEYS.ctrlSpace}i`);

  await ctx.tui.waitFor('n  new');

  const sessionScreen = await ctx.readSessionScreen(id);

  // the session's terminal echoes a NUL as ^@
  expect(sessionScreen).not.toInclude('^@i');
});

test('it shows home behind the list once K kills the attached session', async () => {
  const ctx = await setupTest();

  await spawnDaemonSession(ctx.tui, 'doomed');

  await ctx.attachFirst();

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('╭─ ');

  ctx.tui.write('K');

  await ctx.tui.waitFor('kill doomed? · y / n');

  ctx.tui.write('y');

  await ctx.tui.waitFor('X end');

  await waitFor(() => {
    expect(ctx.tui.readScreen()).toInclude('n  new');
  });
});

test('it keeps the fleet bar on the last row while the list is open', async () => {
  const ctx = await setupTest();

  await spawnDaemonSession(ctx.tui, 'shown');

  await ctx.attachFirst();

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('╭─ ');

  await waitFor(() => {
    expect(ctx.tui.readScreen().split('\n').at(-1)).toMatch(/^ {2}local(?: \S)+ +\^Space\s*$/u);
  });
});

test('it keeps the home screen behind a list that opens after i went home', async () => {
  const ctx = await setupTest();

  await spawnDaemonSession(ctx.tui, 'shown');

  await ctx.attachFirst();

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('╭─ ');

  ctx.tui.write('i');

  await ctx.tui.waitFor('n  new');
  await ctx.tui.waitForGone('╭─ ');

  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('╭─ ');

  expect(ctx.tui.readScreen()).toInclude('n  new');

  ctx.tui.write(KEYS.esc);

  await ctx.tui.waitForGone('╭─ ');

  expect(ctx.tui.readScreen()).toInclude('n  new');
  expect(ctx.tui.readScreen()).not.toInclude('FAKE_CLAUDE_UP');
});
