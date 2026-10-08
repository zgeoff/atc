import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from '../shared/is-process-alive';
import { KEYS } from './keys';
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

test('it captures a later client that a second boot starts on the same home', async () => {
  const tui = startTUIHarness();
  const first = tui.boot();

  await tui.waitFor('atc — control tower');

  tui.reset();

  const second = tui.boot();

  await tui.waitFor('atc — control tower');

  expect(second.pid).not.toBe(first.pid);
  expect(tui.read()).toInclude('atc — control tower');
});

test('it stops capturing a client that a second boot replaced', async () => {
  const tui = startTUIHarness();
  const first = tui.boot();
  const firstOutput: string[] = [];

  first.onData((data) => {
    firstOutput.push(data);
  });

  await tui.waitFor('atc — control tower');

  tui.boot();

  await tui.waitFor('atc — control tower');

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

  tui.boot();

  await tui.waitFor('atc — control tower');
  await tui.stop();

  await waitFor(() => {
    expect(isProcessAlive(first.pid)).toBeFalse();
  });
});

test('it rejects a wait for text the client never draws with the tail of the capture', async () => {
  const ctx = await setupTest();

  expect(ctx.tui.waitFor('never drawn', 100)).rejects.toThrowWithMessage(
    Error,
    /^timed out waiting for "never drawn"; tail: ".*atc — control tower/su,
  );
});

test('it rejects a wait made while the client has drawn nothing', () => {
  const tui = startTUIHarness({ bootMs: 100 });

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

test('it writes the fake binaries and transports with the fields given laid over them', () => {
  const tui = startTUIHarness();

  tui.writeConfig({ leader: 'ctrl-]', workspaces: { sources: ['git'] } });

  expect(JSON.parse(readFileSync(tui.configPath, 'utf8'))).toStrictEqual({
    claudeBin: join(tui.home, 'fake-claude'),
    claudeArgs: [],
    grokBin: join(tui.home, 'fake-grok'),
    grokArgs: [],
    codexBin: join(tui.home, 'fake-codex'),
    codexArgs: [],
    gateways: [],
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
  const ctx = await setupTest();

  ctx.tui.reset();
  ctx.tui.write(KEYS.ctrlSpace);

  await ctx.tui.waitFor('┌ sessions ─');

  const before = ctx.tui.countClientLogLines();

  ctx.tui.write('H');

  await ctx.tui.waitForClientLog('ignored H on a session that cannot eject', before);

  const after = ctx.tui.countClientLogLines();

  expect(
    ctx.tui.waitForClientLog('ignored H on a session that cannot eject', after, 200),
  ).rejects.toThrow(
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
  const ctx = await setupTest();

  await ctx.tui.stop();

  expect(existsSync(ctx.tui.home)).toBe(false);
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
