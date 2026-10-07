import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubTUIClaude } from './build-stub-tui-claude';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// A home holding the stub and a reporter socket that keeps one line per
// connection; `start` runs the stub there and captures what it prints.
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-tui-claude-'));
  const lines: string[] = [];

  const listener = Bun.listen<{ buffer: string }>({
    unix: join(tmp.dir, 'report.sock'),
    socket: {
      open(socket) {
        socket.data = { buffer: '' };
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
      },
      close(socket) {
        lines.push(socket.data.buffer.trimEnd());
      },
    },
  });

  stack.defer(() => {
    listener.stop(true);
  });

  const bin = createStubBin(tmp.dir, 'claude', buildStubTUIClaude());
  const owned = stack.move();

  return {
    dir: tmp.dir,
    lines,
    start(args: readonly string[]) {
      const proc = Bun.spawn([bin, ...args], {
        env: {
          HOME: tmp.dir,
          PATH: '/usr/bin:/bin',
          ATC_SOCKET: join(tmp.dir, 'report.sock'),
          ATC_SESSION_ID: 's-1',
        },
        stdin: 'pipe',
        stdout: 'pipe',
      });

      onTestFinished(() => {
        proc.kill();
      });

      let out = '';

      void (async () => {
        for await (const chunk of proc.stdout) {
          out += Buffer.from(chunk).toString();
        }
      })();

      return { proc, read: () => out };
    },
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it prints its marker with its arguments', async () => {
  using ctx = setupTest();

  const run = ctx.start(['--model', 'opus']);

  const out = await waitFor(() => {
    expect(run.read()).toInclude('\n');

    return run.read();
  });

  expect(out).toBe('FAKE_CLAUDE_UP args: --model opus\n');
});

test('it reports SessionStart and then a permission notification through the reporter', async () => {
  using ctx = setupTest();

  ctx.start([]);

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  expect(ctx.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      atcId: 's-1',
      event: 'SessionStart',
      payload: {
        hook_event_name: 'SessionStart',
        session_id: 'fake-1',
        transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
      },
    },
    {
      atcId: 's-1',
      event: 'Notification',
      payload: {
        hook_event_name: 'Notification',
        session_id: 'fake-1',
        message: 'needs permission',
      },
    },
  ]);
});

test('it reports the events file in place of the notification', async () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'fake-claude-events.jsonl'),
    `${JSON.stringify({ hook_event_name: 'Stop', session_id: 'fake-1' })}\n`,
  );

  ctx.start([]);

  const second = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);

    return ctx.lines[1] ?? '';
  });

  expect(JSON.parse(second)).toStrictEqual({
    atcId: 's-1',
    event: 'Stop',
    payload: { hook_event_name: 'Stop', session_id: 'fake-1' },
  });
});

test('it prints its marker again on SIGWINCH', async () => {
  using ctx = setupTest();

  const run = ctx.start(['--x']);

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  run.proc.kill('SIGWINCH');

  await waitFor(() => {
    expect(run.read()).toBe('FAKE_CLAUDE_UP args: --x\nFAKE_CLAUDE_UP args: --x\n');
  });
});

test('it echoes each line it reads', async () => {
  using ctx = setupTest();

  const run = ctx.start([]);

  void run.proc.stdin.write('ping\n');
  void run.proc.stdin.flush();

  const out = await waitFor(() => {
    expect(run.read()).toInclude('GOT:ping\n');

    return run.read();
  });

  expect(out).toBe('FAKE_CLAUDE_UP args: \nGOT:ping\n');
});

test('it holds a resumed run until the hold file goes, printing nothing before', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-hold-resume'), '');

  const run = ctx.start(['--resume', 'fake-1']);

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'fake-claude-resume-held'))).toBe(true);
  });

  const printedWhileHeld = run.read();

  rmSync(join(ctx.dir, 'fake-claude-hold-resume'));

  const printedAfter = await waitFor(() => {
    expect(run.read()).toInclude('\n');

    return run.read();
  });

  expect({ printedWhileHeld, printedAfter }).toStrictEqual({
    printedWhileHeld: '',
    printedAfter: 'FAKE_CLAUDE_UP args: --resume fake-1\n',
  });
});
