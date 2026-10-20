import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { createStubAppServerCodex } from './create-stub-app-server-codex';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-app-server-codex-');

  return { directory: temporaryDirectory.path };
}

test('it prints its arguments and keeps running as the terminal', async () => {
  const ctx = setupTest();
  const stub = createStubAppServerCodex(ctx.directory);
  const subprocess = Bun.spawn([stub, '--remote', 'unix:///tmp/codex.sock'], { stdout: 'pipe' });

  onTestFinished(() => {
    subprocess.kill();
  });

  const reader = subprocess.stdout.getReader();

  const first = await reader.read();

  expect(new TextDecoder().decode(first.value)).toBe(
    'FAKE_CODEX_UP args: --remote unix:///tmp/codex.sock\n',
  );

  expect(subprocess.exitCode).toBeNull();
});

test('it serves the stand-in App Server on the socket it listens on', async () => {
  const ctx = setupTest();
  const stub = createStubAppServerCodex(ctx.directory);
  const socket = join(ctx.directory, 'codex.sock');
  const subprocess = Bun.spawn([stub, 'app-server', '--listen', `unix://${socket}`]);

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

  ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }));

  const answer = await answered;

  expect(answer).toStrictEqual({
    id: 1,
    result: { userAgent: 'stub-codex-app-server' },
  });
});
