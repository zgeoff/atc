import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-stub-app-server-');

  return {
    directory: temporaryDirectory.path,
    script: join(import.meta.dir, 'run-stub-codex-app-server.ts'),
  };
}

test('it refuses arguments that are not an app server listening on a Unix socket', async () => {
  const ctx = setupTest();

  const result = await runCommand([
    process.execPath,
    ctx.script,
    ctx.directory,
    'resume',
    'thread-1',
  ]);

  expect(result.exitCode).toBe(2);
});

test('it serves with the scenario in the directory and logs each request there', async () => {
  const ctx = setupTest();
  const socket = join(ctx.directory, 'codex.sock');

  writeFileSync(
    join(ctx.directory, 'app-server-scenario.json'),
    JSON.stringify({ failTurnsListFrom: 1 }),
  );

  const subprocess = Bun.spawn(
    [process.execPath, ctx.script, ctx.directory, 'app-server', '--listen', `unix://${socket}`],
    { stdout: 'ignore', stderr: 'ignore' },
  );

  onTestFinished(() => {
    subprocess.kill();
  });

  const ws = await waitFor(
    () =>
      new Promise<WebSocket>((resolve, reject) => {
        const opened = new WebSocket(`ws+unix://${socket}`);

        opened.addEventListener(
          'open',
          () => {
            resolve(opened);
          },
          { once: true },
        );

        opened.addEventListener('error', reject, { once: true });
      }),
  );

  onTestFinished(() => {
    ws.close();
  });

  const answered = new Promise<unknown>((resolve) => {
    ws.addEventListener(
      'message',
      (messageEvent) => {
        const value: unknown = JSON.parse(String(messageEvent.data));

        resolve(value);
      },
      { once: true },
    );
  });

  ws.send(JSON.stringify({ id: 1, method: 'thread/turns/list', params: { threadId: 'missing' } }));

  const answer = await answered;

  expect(answer).toStrictEqual({
    id: 1,
    error: { code: -32_600, message: 'thread not loaded' },
  });

  expect(readFileSync(join(ctx.directory, 'app-server-requests.jsonl'), 'utf8')).toBe(
    '{"method":"thread/turns/list","params":{"threadId":"missing"}}\n',
  );
});
