import { expect, onTestFinished, test } from 'bun:test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { createStubHarnessGuest } from './create-stub-harness-guest';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-harness-guest-');

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it creates the script and the burst pipe under the directory', () => {
  using ctx = setupTest();

  const guest = createStubHarnessGuest(ctx.dir);

  expect({
    guest,
    executable: statSync(guest.path).mode & 0o111,
    pipe: statSync(guest.burstPath).isFIFO(),
  }).toStrictEqual({
    guest: { path: join(ctx.dir, 'harness'), burstPath: join(ctx.dir, 'burst') },
    executable: 0o111,
    pipe: true,
  });
});

test('it prints its pid on start, echoes each line, and exits 3 on quit', async () => {
  using ctx = setupTest();

  const guest = createStubHarnessGuest(ctx.dir);
  const proc = Bun.spawn([guest.path], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  onTestFinished(() => {
    proc.kill('SIGKILL');
  });

  void proc.stdin.write('one\nquit\n');

  await proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();

  expect({ stdout, code: await proc.exited }).toStrictEqual({
    stdout: `UP:${proc.pid} START:\nGOT:one\n`,
    code: 3,
  });
});

test('it prints the terminal size it starts at', async () => {
  using ctx = setupTest();

  const guest = createStubHarnessGuest(ctx.dir);

  const decoder = new TextDecoder();

  const output: string[] = [];

  const proc = Bun.spawn([guest.path], {
    terminal: {
      cols: 100,
      rows: 30,
      data: (_terminal, data) => {
        output.push(decoder.decode(data));
      },
    },
  });

  onTestFinished(() => {
    proc.kill('SIGKILL');
    proc.terminal?.close();
  });

  await waitFor(() => {
    expect(output.join('')).toInclude(`UP:${proc.pid} START:30 100\r\n`);
  });
});

test('it prints the terminal size again on size', async () => {
  using ctx = setupTest();

  const guest = createStubHarnessGuest(ctx.dir);

  const decoder = new TextDecoder();

  const output: string[] = [];

  const proc = Bun.spawn([guest.path], {
    terminal: {
      cols: 100,
      rows: 30,
      data: (_terminal, data) => {
        output.push(decoder.decode(data));
      },
    },
  });

  onTestFinished(() => {
    proc.kill('SIGKILL');
    proc.terminal?.close();
  });

  proc.terminal?.write('size\n');

  await waitFor(() => {
    expect(output.join('')).toInclude('SIZE:30 100\r\nGOT:size\r\n');
  });
});

test('it prints the burst on later once a line reaches the burst pipe', async () => {
  using ctx = setupTest();

  const guest = createStubHarnessGuest(ctx.dir);
  const output: string[] = [];
  const proc = Bun.spawn([guest.path], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  onTestFinished(() => {
    proc.kill('SIGKILL');
  });

  const read = proc.stdout.pipeThrough(new TextDecoderStream()).pipeTo(
    new WritableStream({
      write: (chunk) => {
        output.push(chunk);
      },
    }),
  );

  void proc.stdin.write('later\n');

  await proc.stdin.end();

  await waitFor(() => {
    invariant(output.join('').includes('GOT:later\n'));
  });

  // The burst waits on the pipe, so the output read here holds nothing that
  // follows the echo.
  const beforeBurst = output.join('');

  writeFileSync(guest.burstPath, 'go\n');

  await read;

  expect({ beforeBurst, afterBurst: output.join('') }).toStrictEqual({
    beforeBurst: `UP:${proc.pid} START:\nGOT:later\n`,
    afterBurst: `UP:${proc.pid} START:\nGOT:later\n${'x'.repeat(300_000)}\nBURST_DONE\n`,
  });
});
