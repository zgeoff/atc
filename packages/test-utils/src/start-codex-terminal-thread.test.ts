import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import type { Server } from 'bun';
import { setupTempDir } from './setup-temp-dir';
import { startCodexTerminalThread } from './start-codex-terminal-thread';
import { startStubCodexAppServer } from './start-stub-codex-app-server';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-terminal-thread-');
  const socket = join(temporaryDirectory.path, 'codex.sock');

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

test('it rejects when no App Server listens on the socket', () => {
  const ctx = setupTest();

  expect(startCodexTerminalThread(ctx.socket)).rejects.toThrow(
    `the App Server connection at ${ctx.socket} failed`,
  );
});

test('it rejects when the App Server closes the connection before it answers', () => {
  const ctx = setupTest();

  const answerUpgrade = (request: Request, bunServer: Server<undefined>) =>
    bunServer.upgrade(request) ? undefined : new Response(`${ctx.socket} speaks only WebSocket`);

  const server = Bun.serve({
    unix: ctx.socket,
    fetch: answerUpgrade,
    websocket: {
      message: (ws) => {
        ws.close();
      },
    },
  });

  onTestFinished(() => server.stop(true));

  expect(startCodexTerminalThread(ctx.socket)).rejects.toThrow(
    `the App Server at ${ctx.socket} closed the connection before answering`,
  );
});
