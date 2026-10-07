import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubMCPClaude } from './build-stub-mcp-claude';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-mcp-claude-'));
  const lines: string[] = [];

  // The reporter the script reports through sends one line per connection
  // here.
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

  const bin = createStubBin(tmp.dir, 'claude', buildStubMCPClaude());
  const owned = stack.move();

  return {
    dir: tmp.dir,
    bin,
    lines,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it prints its marker and arguments, then stays up', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-hold-start'), '');

  const proc = Bun.spawn([ctx.bin, '--model', 'opus'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const first = await proc.stdout.getReader().read();

  expect(new TextDecoder().decode(first.value)).toBe('FAKE_CLAUDE_UP args: --model opus\n');
  expect(proc.exitCode).toBeNull();
});

test('it reports SessionStart with its session id and transcript through the reporter', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdout: 'ignore',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const line = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(1);

    return ctx.lines[0];
  });

  expect(JSON.parse(line ?? '')).toStrictEqual({
    atcId: 's-1',
    event: 'SessionStart',
    payload: {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
    },
  });
});

test('it files the note file as a decision report', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-note'), 'pick the second option');

  const proc = Bun.spawn([ctx.bin], {
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdout: 'ignore',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const line = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);

    return ctx.lines[1];
  });

  expect(JSON.parse(line ?? '')).toStrictEqual({
    atcId: 's-1',
    event: 'Report',
    payload: { kind: 'note', label: 'decision', text: 'pick the second option' },
  });
});
