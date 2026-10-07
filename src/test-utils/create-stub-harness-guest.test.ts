import { expect, test } from 'bun:test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubHarnessGuest } from './create-stub-harness-guest';
import { setupTempDir } from './setup-temp-dir';

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

  void proc.stdin.write('one\nquit\n');

  await proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();

  expect({ stdout, code: await proc.exited }).toStrictEqual({
    stdout: `UP:${proc.pid} START:\nGOT:one\n`,
    code: 3,
  });
});

test('it prints the terminal size on size', async () => {
  using ctx = setupTest();

  const guest = createStubHarnessGuest(ctx.dir);

  // With no terminal on its input, the size it reads is empty.
  const proc = Bun.spawn([guest.path], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  void proc.stdin.write('size\nquit\n');

  await proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();

  expect(stdout).toBe(`UP:${proc.pid} START:\nSIZE:\nGOT:size\n`);
});

test('it prints the burst on later once a line reaches the burst pipe', async () => {
  using ctx = setupTest();

  const guest = createStubHarnessGuest(ctx.dir);
  const proc = Bun.spawn([guest.path], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  const decoder = new TextDecoder();

  const reader = proc.stdout.getReader();
  let output = '';

  void proc.stdin.write('later\n');

  await proc.stdin.end();

  // The burst waits on the pipe, so nothing follows the echo until a line
  // reaches it.
  while (!output.endsWith('GOT:later\n')) {
    const chunk = await reader.read();

    if (chunk.done) {
      throw new Error(`the guest ended before it echoed the line: ${output}`);
    }

    output += decoder.decode(chunk.value);
  }

  writeFileSync(guest.burstPath, 'go\n');

  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    output += decoder.decode(chunk.value);
  }

  expect(output).toBe(`UP:${proc.pid} START:\nGOT:later\n${'x'.repeat(300_000)}\nBURST_DONE\n`);
});
