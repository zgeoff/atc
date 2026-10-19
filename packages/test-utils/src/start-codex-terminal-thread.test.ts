import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startCodexTerminalThread } from './start-codex-terminal-thread';
import { startStubCodexAppServer } from './start-stub-codex-app-server';

function setupTest() {
  const tmp = setupTempDir('atc-terminal-thread-');
  const socket = join(tmp.dir, 'codex.sock');

  return { socket };
}

test('it resolves with the id of the thread the App Server started', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});

  onTestFinished(() => server.stop());

  const thread = await startCodexTerminalThread(ctx.socket);

  expect(thread).toBe('thread-1');
});

test('it initializes the client before it starts the thread', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});

  onTestFinished(() => server.stop());

  await startCodexTerminalThread(ctx.socket);

  expect(server.requests.map((request) => request.method)).toStrictEqual([
    'initialize',
    'thread/start',
  ]);
});
