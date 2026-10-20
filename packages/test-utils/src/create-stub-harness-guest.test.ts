import { expect, test } from 'bun:test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { createStubHarnessGuest } from './create-stub-harness-guest';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-harness-guest-');

  return { directory: temporaryDirectory.path };
}

test('it creates the script and the burst pipe under the directory', async () => {
  const ctx = setupTest();

  const guest = await createStubHarnessGuest(ctx.directory);

  expect(guest).toStrictEqual({
    path: join(ctx.directory, 'harness'),
    burstPath: join(ctx.directory, 'burst'),
  });

  expect(statSync(guest.path).mode & 0o111).toBe(0o111);
  expect(statSync(guest.burstPath).isFIFO()).toBe(true);
});

test('it prints its pid on start, echoes each line, and exits 3 on quit', async () => {
  const ctx = setupTest();

  const guest = await createStubHarnessGuest(ctx.directory);

  const subprocess = Bun.spawn([guest.path], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
  });

  void subprocess.stdin.write('one\nquit\n');

  await subprocess.stdin.end();

  const stdout = await new Response(subprocess.stdout).text();

  expect({ stdout, code: await subprocess.exited }).toStrictEqual({
    stdout: `UP:${subprocess.pid} START:\nGOT:one\n`,
    code: 3,
  });
});

test('it prints the terminal size it starts at', async () => {
  const ctx = setupTest();

  const guest = await createStubHarnessGuest(ctx.directory);

  const decoder = new TextDecoder();

  const output: string[] = [];

  const subprocess = Bun.spawn([guest.path], {
    terminal: {
      cols: 100,
      rows: 30,
      data: (_terminal, data) => {
        output.push(decoder.decode(data));
      },
    },
  });

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
    subprocess.terminal?.close();
  });

  await waitFor(() => {
    expect(output.join('')).toInclude(`UP:${subprocess.pid} START:30 100\r\n`);
  });
});

test('it prints the terminal size again on size', async () => {
  const ctx = setupTest();

  const guest = await createStubHarnessGuest(ctx.directory);

  const decoder = new TextDecoder();

  const output: string[] = [];

  const subprocess = Bun.spawn([guest.path], {
    terminal: {
      cols: 100,
      rows: 30,
      data: (_terminal, data) => {
        output.push(decoder.decode(data));
      },
    },
  });

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
    subprocess.terminal?.close();
  });

  subprocess.terminal?.write('size\n');

  await waitFor(() => {
    expect(output.join('')).toInclude('SIZE:30 100\r\nGOT:size\r\n');
  });
});

test('it prints the burst on later once a line reaches the burst pipe', async () => {
  const ctx = setupTest();

  const guest = await createStubHarnessGuest(ctx.directory);

  const output: string[] = [];
  const subprocess = Bun.spawn([guest.path], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
  });

  const read = subprocess.stdout.pipeThrough(new TextDecoderStream()).pipeTo(
    new WritableStream({
      write: (chunk) => {
        output.push(chunk);
      },
    }),
  );

  void subprocess.stdin.write('later\n');

  await subprocess.stdin.end();

  await waitFor(() => {
    invariant(output.join('').includes('GOT:later\n'));
  });

  // The burst waits on the pipe, so the output read here holds nothing that
  // follows the echo.
  const beforeBurst = output.join('');

  writeFileSync(guest.burstPath, 'go\n');

  await read;

  expect(beforeBurst).toBe(`UP:${subprocess.pid} START:\nGOT:later\n`);

  expect(output.join('')).toBe(
    `UP:${subprocess.pid} START:\nGOT:later\n${'x'.repeat(300_000)}\nBURST_DONE\n`,
  );
});
