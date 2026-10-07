import { expect, test } from 'bun:test';
import { closeSync, constants, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';

/**
 * A daemon in a process of its own whose TCP listener logs every refusal
 * on a line of its own to the daemon's stderr, a named pipe nothing reads
 * until `readStderr` starts to read it into `output`. A pipe from the
 * spawn itself would not do: the runtime reads those as they fill. `refuse` sends the given
 * number of lines before any handshake, each on a connection of its own,
 * and resolves once the listener has closed every one. `ping` times a
 * `daemon.ping` from a new client on the daemon's unix socket. `stop` sends
 * the daemon SIGTERM at once and resolves with its exit code and how long
 * it took to exit.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-non-blocking-log-');
  const fifo = join(tmp.dir, 'stderr');

  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  Bun.spawnSync(['mkfifo', fifo]);

  // The read end opens first and never blocks, so the write end opens at
  // once, and the daemon's writes block once the pipe is full.
  const readEnd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const writeEnd = openSync(fifo, constants.O_WRONLY);

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, '..', 'test-utils', 'run-listener-daemon.ts')],
    {
      env: { ...process.env, ATC_TEST_DIR: tmp.dir },
      stdout: 'pipe',
      stderr: writeEnd,
    },
  );

  closeSync(writeEnd);

  const stdout = proc.stdout.getReader();

  const first = await stdout.read();

  const port = Number(new TextDecoder().decode(first.value).trim());
  const output: string[] = [];
  let reader: ReturnType<typeof setInterval> | undefined;

  return {
    output,
    async refuse(count: number): Promise<void> {
      const batch = 100;

      for (let start = 0; start < count; start += batch) {
        await Promise.all(
          Array.from({ length: Math.min(batch, count - start) }, async () => {
            const closed = Promise.withResolvers<void>();

            await Bun.connect({
              hostname: '127.0.0.1',
              port,
              socket: {
                open(socket) {
                  socket.write('not a handshake\n');
                },
                data() {},
                close() {
                  closed.resolve();
                },
              },
            });

            await closed.promise;
          }),
        );
      }
    },
    async ping(): Promise<number> {
      const client = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));

      const started = performance.now();

      await client.sendHello('atc/test-build');
      await client.sendRequest('daemon.ping', {});

      client.stop();

      return performance.now() - started;
    },
    async stop(): Promise<{ exitCode: number; elapsedMs: number }> {
      const started = performance.now();

      proc.kill('SIGTERM');

      const exitCode = await proc.exited;

      return { exitCode, elapsedMs: performance.now() - started };
    },
    readStderr(): void {
      const buffer = Buffer.alloc(64 * 1024);

      reader = setInterval(() => {
        try {
          for (;;) {
            const read = readSync(readEnd, buffer);

            if (read === 0) {
              return;
            }

            output.push(buffer.toString('utf8', 0, read));
          }
        } catch {
          // An empty pipe read without blocking throws EAGAIN.
        }
      }, 5);
    },
    async [Symbol.asyncDispose]() {
      clearInterval(reader);

      proc.kill('SIGKILL');

      await proc.exited;

      closeSync(readEnd);

      tmp[Symbol.dispose]();
    },
  };
}

test('it answers another client within a second while a flood of refusals fills the unread stderr', async () => {
  await using daemon = await setupTest();

  await daemon.refuse(3000);

  const elapsed = await daemon.ping();

  expect(elapsed).toBeLessThan(1000);
});

test('it logs how many lines it dropped once the stderr reader reads again', async () => {
  await using daemon = await setupTest();

  await daemon.refuse(3000);

  daemon.readStderr();

  await waitFor(() => {
    expect(daemon.output.join('')).toMatch(/^atc log dropped=\d+$/mu);
  });
});

test('it delivers every line to a stderr reader that keeps reading', async () => {
  await using daemon = await setupTest();

  daemon.readStderr();

  await daemon.refuse(2000);

  await waitFor(() => {
    expect(daemon.output.join('').split('\n')).toStrictEqual([
      expect.toStartWith('atc tcp event=listening '),
      ...Array.from(
        { length: 2000 },
        () => 'atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=1',
      ),
      '',
    ]);
  });
});

test('it exits within three seconds of SIGTERM while a flood of refusals fills the unread stderr', async () => {
  await using daemon = await setupTest();

  await daemon.refuse(3000);

  const stopped = await daemon.stop();

  expect(stopped).toStrictEqual({ exitCode: 0, elapsedMs: expect.toBeWithin(0, 3000) });
});

test('it writes every line it holds at SIGTERM, and the count of the ones it dropped, to a stderr reader that starts to read after it', async () => {
  await using daemon = await setupTest();

  await daemon.refuse(3000);

  const stopping = daemon.stop();

  daemon.readStderr();

  const stopped = await stopping;

  expect(stopped).toMatchObject({ exitCode: 0 });

  // Every refusal arrives as a line of its own or is counted on a dropped
  // line, however much of the flood the host's pipe took before the log
  // started to queue and drop.
  await waitFor(() => {
    const lines = daemon.output.join('').split('\n');

    const refusals = lines.filter(
      (line) =>
        line === 'atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=1',
    ).length;

    const dropped = lines
      .filter((line) => line.startsWith('atc log dropped='))
      .reduce((sum, line) => sum + Number(line.slice('atc log dropped='.length)), 0);

    expect(lines[0]).toStartWith('atc tcp event=listening ');

    expect(lines.slice(1, -1)).toSatisfyAll((line: string) =>
      /^(?:atc tcp event=handshake_refused peer=127\.0\.0\.1 reason=unexpected_line count=1|atc log dropped=\d+)$/u.test(
        line,
      ),
    );

    expect(lines.at(-1)).toBe('');
    expect(refusals + dropped).toBe(3000);
  });
});
