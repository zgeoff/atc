import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { buildStubWaitClock } from '@atc/core/test-utils/build-stub-wait-clock';
import { KEYS } from '@atc/core/test-utils/keys';
import { waitFor } from '@zgeoff/testing';
import { startTUIHarness } from './start-tui-harness';

async function setupTest() {
  const tui = startTUIHarness({ createStateDB: () => {} });

  tui.boot();

  await tui.waitFor('no sessions');

  return { tui };
}

test('it boots the client in its home, where the client starts its daemon', async () => {
  const tui = startTUIHarness({ createStateDB: () => {} });

  tui.boot();

  await tui.waitFor('no sessions');

  const paths = resolvePaths({ HOME: tui.home, XDG_RUNTIME_DIR: tui.home });

  expect(readFileSync(paths.daemonPidFile, 'utf8')).toMatch(/^\d+$/u);
});

test("it creates the state database at its home's database path before a boot", () => {
  const createStateDB = mock<(dbPath: string) => void>();
  const tui = startTUIHarness({ createStateDB });

  expect(createStateDB.mock.calls).toStrictEqual([[resolvePaths({ HOME: tui.home }).dbFile]]);
});

test('it captures a later client that a second boot starts on the same home', async () => {
  const tui = startTUIHarness({ createStateDB: () => {} });

  // A version run prints and exits without a daemon, so each boot costs one
  // client start.
  const first = tui.boot(['--version']);

  await tui.waitForExit();

  tui.reset();

  const second = tui.boot(['--version']);

  await waitFor(() => {
    expect(tui.read()).toMatch(/\d+\.\d+\.\d+/u);
  });

  expect(second.pid).not.toBe(first.pid);
});

test('it stops capturing a client that a second boot replaced', async () => {
  const tui = startTUIHarness({ createStateDB: () => {} });
  const first = tui.boot();
  const firstOutput: string[] = [];

  first.onData((data) => {
    firstOutput.push(data);
  });

  await tui.waitFor('no sessions');

  tui.boot(['--version']);

  await tui.waitForExit();

  tui.reset();
  first.write('n');

  await waitFor(() => {
    expect(firstOutput.join('')).toInclude('spawn: agent');
  });

  expect(tui.read()).not.toInclude('spawn: agent');
});

test('it kills a client a later boot replaced on stop', async () => {
  const tui = startTUIHarness({ createStateDB: () => {} });
  const first = tui.boot();

  await tui.waitFor('no sessions');

  tui.boot(['--version']);

  await tui.waitForExit();
  await tui.stop();

  await waitFor(() => {
    expect(() => process.kill(first.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
});

test('it rejects a wait for text the client never draws with the tail of the capture', async () => {
  const clock = buildStubWaitClock();
  const tui = startTUIHarness({ createStateDB: () => {}, now: clock.now, wait: clock.wait });

  tui.boot();

  // The client boots in real time, which the stub clock never advances, so this waits for
  // the first draw on the real clock.
  await waitFor(
    () => {
      expect(tui.read()).toInclude('no sessions');
    },
    { timeoutMs: 9000 },
  );

  expect(tui.waitFor('never drawn', 100)).rejects.toThrowWithMessage(
    Error,
    /^timed out after 100 ms: timed out waiting for "never drawn"; tail: ".*no sessions/su,
  );
});

test('it rejects a wait made while the client has drawn nothing', () => {
  const clock = buildStubWaitClock();

  const tui = startTUIHarness({
    createStateDB: () => {},
    bootMs: 100,
    now: clock.now,
    wait: clock.wait,
  });

  expect(tui.waitFor('no sessions')).rejects.toThrow(
    'timed out waiting for "no sessions"; the client wrote nothing in 100ms of boot',
  );
});

test('it rejects a write before the client boots', () => {
  const tui = startTUIHarness({ createStateDB: () => {} });

  expect(() => {
    tui.write('n');
  }).toThrow('write before boot');
});

test('it rejects a wait for exit before the client boots', () => {
  const tui = startTUIHarness({ createStateDB: () => {} });

  expect(() => tui.waitForExit()).toThrow('wait for exit before boot');
});

test('it forgets the output the client wrote on reset', async () => {
  const ctx = await setupTest();

  ctx.tui.reset();

  expect(ctx.tui.read()).not.toInclude('\u001B[2J');
});

test('it forgets what the screen shows on a screen reset', async () => {
  const ctx = await setupTest();

  ctx.tui.resetScreen();

  expect(ctx.tui.read()).not.toInclude('no sessions');
});

test('it reads the text of the screen without the output before it', async () => {
  const ctx = await setupTest();

  ctx.tui.reset();

  expect(ctx.tui.readScreen()).toInclude('no sessions');
  expect(ctx.tui.read()).toBe(`\n${ctx.tui.readScreen()}`);
});

test('it waits for a text to leave the screen', async () => {
  const ctx = await setupTest();

  ctx.tui.write('n');

  await ctx.tui.waitFor('spawn: agent');

  ctx.tui.write(KEYS.esc);

  await ctx.tui.waitForGone('spawn: agent');

  expect(ctx.tui.readScreen()).not.toInclude('spawn: agent');
});

test('it formats a short text as the whole input row', () => {
  const tui = startTUIHarness({ createStateDB: () => {} });

  expect(tui.formatInput('/srv/ledger')).toBe('> /srv/ledger');
});

test('it formats a text too long for the input row as the tail the picker draws', async () => {
  const ctx = await setupTest();

  const typed = `/srv/${'orchard-'.repeat(12)}ledger`;

  ctx.tui.write('n');

  await ctx.tui.waitFor('spawn: agent');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('spawn: workspace');

  ctx.tui.write(typed);

  await ctx.tui.waitFor(`> …${typed.slice(-81)}`);

  expect(ctx.tui.formatInput(typed)).toBe(`> …${typed.slice(-81)}`);
});

test('it passes the arguments a boot gives to the client', async () => {
  const tui = startTUIHarness({ createStateDB: () => {} });

  tui.boot(['--version']);

  const exitCode = await tui.waitForExit();

  expect(exitCode).toBe(0);
  expect(tui.read()).toMatch(/\d+\.\d+\.\d+/u);
});

test('it writes the fake binaries and transports with the fields given laid over them', () => {
  const tui = startTUIHarness({ createStateDB: () => {} });

  tui.writeConfig({ leader: 'ctrl-]', workspaces: { sources: ['git'] } });

  expect(JSON.parse(readFileSync(tui.configPath, 'utf8'))).toStrictEqual({
    agents: {
      claude: { kind: 'claude', bin: join(tui.home, 'fake-claude') },
      grok: { kind: 'grok', bin: join(tui.home, 'fake-grok') },
      codex: { kind: 'codex', bin: join(tui.home, 'fake-codex') },
    },
    workspaces: { gitTransports: ['https', 'ssh', 'http', 'file'], sources: ['git'] },
    leader: 'ctrl-]',
  });
});

test('it moves the mark past a line the client logs after it', async () => {
  const ctx = await setupTest();

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('╭─ ');

  const mark = ctx.tui.countClientLogLines();

  ctx.tui.write('H');

  await ctx.tui.waitForClientLog('ignored H on a session that cannot eject', mark);

  expect(ctx.tui.countClientLogLines()).toBe(mark + 1);
});

test('it rejects a wait for a log line written only before the mark', async () => {
  const clock = buildStubWaitClock();
  const tui = startTUIHarness({ createStateDB: () => {}, now: clock.now, wait: clock.wait });

  tui.boot();

  // The client boots and answers in real time, which the stub clock never spends,
  // so these waits poll the screen and the log on real time. Boot gets 9 seconds,
  // the same budget the harness allows a real boot.
  await waitFor(
    () => {
      expect(tui.read()).toInclude('no sessions');
    },
    { timeoutMs: 9000 },
  );

  tui.reset();
  tui.write(KEYS.ctrlSpace);

  await waitFor(() => {
    expect(tui.read()).toInclude('╭─ ');
  });

  tui.write('H');

  await waitFor(() => {
    expect(readFileSync(tui.env.ATC_CLIENT_LOG, 'utf8')).toBe(
      'ignored H on a session that cannot eject\n',
    );
  });

  expect(tui.waitForClientLog('ignored H on a session that cannot eject', 1, 200)).rejects.toThrow(
    'the client log never held "ignored H on a session that cannot eject" after line 1',
  );
});

test('it resolves the exit code of the client it booted', async () => {
  const ctx = await setupTest();

  ctx.tui.write('q');

  const exitCode = await ctx.tui.waitForExit();

  expect(exitCode).toBe(0);
});

test('it stops the daemon the client started on stop', async () => {
  const ctx = await setupTest();

  const pid = Number(readFileSync(ctx.tui.paths.daemonPidFile, 'utf8'));

  await ctx.tui.stop();

  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

test('it removes its home on stop', async () => {
  const tui = startTUIHarness({ createStateDB: () => {} });

  await tui.stop();

  expect(existsSync(tui.home)).toBe(false);
});

test('it stops the daemon its pid file holds and removes the home once the test finishes', () => {
  const tui = startTUIHarness({ createStateDB: () => {} });

  // Cleanup uses SIGKILL because a bare kill() sends SIGTERM, which would pass the SIGTERM check
  // even if the harness never stopped this process.
  const daemon = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    daemon.kill('SIGKILL');
  });

  writeFileSync(tui.paths.daemonPidFile, String(daemon.pid));

  onTestFinished(async () => {
    await daemon.exited;

    expect(daemon.signalCode).toBe('SIGTERM');
    expect(existsSync(tui.home)).toBe(false);
  });
});
