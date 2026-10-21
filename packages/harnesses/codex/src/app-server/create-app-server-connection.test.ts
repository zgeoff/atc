import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir, startStubCodexAppServer, waitFor } from '@atc/test-utils';
import { createAppServerConnection } from './create-app-server-connection';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-app-server-conn-');

  return { socket: join(temporaryDirectory.path, 'codex.sock') };
}

test('it resolves a request with the result the server answers', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});

  onTestFinished(() => server.stop());

  const conn = await createAppServerConnection(`ws+unix://${ctx.socket}`);

  onTestFinished(() => {
    conn.dispose();
  });

  const result = await conn.sendRequest('initialize', {});

  expect(result).toStrictEqual({
    userAgent: 'stub-codex-app-server',
  });
});

test('it rejects a request with the code of the error the server answers', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});

  onTestFinished(() => server.stop());

  const conn = await createAppServerConnection(`ws+unix://${ctx.socket}`);

  onTestFinished(() => {
    conn.dispose();
  });

  expect(conn.sendRequest('thread/resume', { threadId: 'missing' })).rejects.toMatchObject({
    code: -32_600,
    message: 'thread not loaded',
  });
});

test('it rejects a request on a connection that closed', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, {});

  const conn = await createAppServerConnection(`ws+unix://${ctx.socket}`);

  let closed = false;

  conn.onClose = () => {
    closed = true;
  };

  await server.stop();

  await waitFor(() => {
    expect(closed).toBe(true);
  });

  expect(conn.isOpen).toBe(false);
  expect(conn.sendRequest('initialize', {})).rejects.toMatchObject({ code: -1 });
});

test('it refuses to open where no server listens', () => {
  const ctx = setupTest();

  expect(createAppServerConnection(`ws+unix://${ctx.socket}`)).rejects.toMatchObject({ code: -1 });
});

test('it hands notifications and server requests to their listeners and sends a result back', async () => {
  const ctx = setupTest();
  const server = startStubCodexAppServer(ctx.socket, { holdTurns: true });

  onTestFinished(() => server.stop());

  const conn = await createAppServerConnection(`ws+unix://${ctx.socket}`);

  const methods: string[] = [];

  onTestFinished(() => {
    conn.dispose();
  });

  conn.onNotification = (notification) => {
    methods.push(notification.method);
  };

  conn.onRequest = (request) => {
    conn.sendResult(request.id, { success: true, contentItems: [] });
  };

  await conn.sendRequest('thread/start', {});
  await conn.sendRequest('turn/start', { threadId: 'thread-1', input: [{ text: 'one' }] });

  const result = await server.callTool('note', { text: 'halfway' });

  expect(result).toStrictEqual({ success: true, contentItems: [] });

  expect(methods).toStrictEqual([
    'thread/started',
    'turn/started',
    'item/started',
    'item/completed',
  ]);
});
