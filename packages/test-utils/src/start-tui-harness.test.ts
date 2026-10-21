import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { buildStubWaitClock } from './build-stub-wait-clock';
import { KEYS } from './keys';
import { registerTestCleanup } from './register-test-cleanup';
import { startTUIHarness } from './start-tui-harness';
import { waitFor } from './wait-for';

// A harness whose client has booted and drawn its home screen.
async function setupTest() {
  const tui = startTUIHarness();

  tui.boot();

  await tui.waitFor('atc — control tower');

  return { tui };
}

test('it boots the client in its home, where the client starts its daemon', async () => {
  const tui = startTUIHarness();

  tui.boot();

  await tui.waitFor('atc — control tower');

  expect(readFileSync(join(tui.home, 'atc-daemon.pid'), 'utf8')).toMatch(/^\d+$/u);
});

test("it puts a copy of the run's migrated database in its home before a boot", () => {
  const tui = startTUIHarness();
  const runTemplate = process.env['ATC_TEST_STATE_TEMPLATE'];

  invariant(runTemplate !== undefined, 'the test script exports no state template');

  const copy = new Database(join(tui.home, '.local', 'state', 'atc', 'atc.db'), { readonly: true });
  const template = new Database(runTemplate, { readonly: true });

  registerTestCleanup(() => {
    copy.close();
    template.close();
  });

  const ledger = 'SELECT name FROM kysely_migration ORDER BY name';

  expect(copy.query(ledger).values()).toStrictEqual(template.query(ledger).values());
});

test('it captures a later client that a second boot starts on the same home', async () => {
  const tui = startTUIHarness();

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
  const tui = startTUIHarness();
  const first = tui.boot();
  const firstOutput: string[] = [];

  first.onData((data) => {
    firstOutput.push(data);
  });

  await tui.waitFor('atc — control tower');

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
  const tui = startTUIHarness();
  const first = tui.boot();

  await tui.waitFor('atc — control tower');

  tui.boot(['--version']);

  await tui.waitForExit();
  await tui.stop();

  await waitFor(() => {
    expect(() => process.kill(first.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
});

test('it rejects a wait for text the client never draws with the tail of the capture', async () => {
  const clock = buildStubWaitClock();
  const tui = startTUIHarness({ now: clock.now, wait: clock.wait });

  tui.boot();

  // The client's boot takes real time, which the stub clock never spends,
  // so the boot is awaited on the capture with the harness's 9-second boot
  // budget.
  await waitFor(
    () => {
      expect(tui.read()).toInclude('atc — control tower');
    },
    { timeoutMs: 9000 },
  );

  expect(tui.waitFor('never drawn', 100)).rejects.toThrowWithMessage(
    Error,
    /^timed out waiting for "never drawn"; tail: ".*atc — control tower/su,
  );
});

test('it rejects a wait made while the client has drawn nothing', () => {
  const clock = buildStubWaitClock();
  const tui = startTUIHarness({ bootMs: 100, now: clock.now, wait: clock.wait });

  expect(tui.waitFor('atc — control tower')).rejects.toThrow(
    'timed out waiting for "atc — control tower"; the client wrote nothing in 100ms of boot',
  );
});

test('it rejects a write before the client boots', () => {
  const tui = startTUIHarness();

  expect(() => {
    tui.write('n');
  }).toThrow('write before boot');
});

test('it rejects a wait for exit before the client boots', () => {
  const tui = startTUIHarness();

  expect(() => tui.waitForExit()).toThrow('wait for exit before boot');
});

test('it forgets what the client drew on reset', async () => {
  const ctx = await setupTest();

  ctx.tui.reset();

  expect(ctx.tui.read()).not.toInclude('atc — control tower');
});

test('it formats a short text as the whole input row', () => {
  const tui = startTUIHarness();

  expect(tui.formatInput('/srv/ledger')).toBe('> /srv/ledger');
});

test('it formats a text too long for the input row as the tail the picker draws', async () => {
  const ctx = await setupTest();

  const typed = `/srv/${'orchard-'.repeat(12)}ledger`;

  ctx.tui.write('n');

  await ctx.tui.waitFor('spawn: agent');

  ctx.tui.write(KEYS.enter);

  await ctx.tui.waitFor('spawn: directory');

  ctx.tui.write(typed);

  await ctx.tui.waitFor(`> …${typed.slice(-81)}`);

  expect(ctx.tui.formatInput(typed)).toBe(`> …${typed.slice(-81)}`);
});

test('it passes the arguments a boot gives to the client', async () => {
  const tui = startTUIHarness();

  tui.boot(['--version']);

  const exitCode = await tui.waitForExit();

  expect(exitCode).toBe(0);
  expect(tui.read()).toMatch(/\d+\.\d+\.\d+/u);
});

test('it writes the fake binaries and transports with the fields given laid over them', () => {
  const tui = startTUIHarness();

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

  await ctx.tui.waitFor('┌ sessions ─');

  const mark = ctx.tui.countClientLogLines();

  ctx.tui.write('H');

  await ctx.tui.waitForClientLog('ignored H on a session that cannot eject', mark);

  expect(ctx.tui.countClientLogLines()).toBe(mark + 1);
});

test('it rejects a wait for a log line written only before the mark', async () => {
  const clock = buildStubWaitClock();
  const tui = startTUIHarness({ now: clock.now, wait: clock.wait });

  tui.boot();

  // The client's boot and its answers take real time, which the stub clock
  // never spends, so they are awaited on the capture and the log, the boot
  // with the harness's 9-second boot budget.
  await waitFor(
    () => {
      expect(tui.read()).toInclude('atc — control tower');
    },
    { timeoutMs: 9000 },
  );

  tui.reset();
  tui.write(KEYS.ctrlSpace);

  await waitFor(() => {
    expect(tui.read()).toInclude('┌ sessions ─');
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

  const pid = Number(readFileSync(join(ctx.tui.home, 'atc-daemon.pid'), 'utf8'));

  await ctx.tui.stop();

  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

test('it removes its home on stop', async () => {
  const tui = startTUIHarness();

  await tui.stop();

  expect(existsSync(tui.home)).toBe(false);
});

test('it stops the daemon its pid file holds and removes the home once the test finishes', () => {
  const tui = startTUIHarness();

  // A stand-in for the daemon the client would start; the harness stops it
  // with SIGTERM, which a later kill of the stand-in never sends.
  const daemon = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    daemon.kill('SIGKILL');
  });

  writeFileSync(join(tui.home, 'atc-daemon.pid'), String(daemon.pid));

  onTestFinished(async () => {
    await daemon.exited;

    expect(daemon.signalCode).toBe('SIGTERM');
    expect(existsSync(tui.home)).toBe(false);
  });
});
