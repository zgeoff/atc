import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { isRecord } from '../shared/report';
import { ImpClientPort } from './imp-client-port';
import { readImpToken } from './read-imp-token';

// An impd stand-in on a real HTTP port that records the authorization
// header of each call and WebSocket upgrade, answers every call as system
// info, and answers a tunnel listen as listening, keeping that control
// socket so a test can announce a guest connection on it. Plus a temp
// directory for the token file.
function setupTest() {
  const tmp = setupTempDir('atc-imp-client-port-');
  const authorizations: (string | null)[] = [];
  const controls: ServerWebSocket[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, bunServer) => {
      authorizations.push(request.headers.get('authorization'));

      const isUpgraded = new URL(request.url).pathname === '/tunnel' && bunServer.upgrade(request);

      return isUpgraded
        ? undefined
        : Response.json({ json: { features: { sessionOffsets: true, leases: true } } });
    },
    websocket: {
      message: (socket, message) => {
        const parsed: unknown = JSON.parse(String(message));

        if (isRecord(parsed) && parsed['type'] === 'listen') {
          controls.push(socket);

          socket.send(
            JSON.stringify({ type: 'listening', listener: 'l1', path: '/tmp/r.sock', port: null }),
          );
        }
      },
    },
  });

  return {
    dir: tmp.dir,
    url: `http://127.0.0.1:${String(server.port)}`,
    authorizations,
    controls,
    async [Symbol.asyncDispose]() {
      await server.stop(true);

      tmp[Symbol.dispose]();
    },
  };
}

test('it calls impd with the token its token file holds', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, 'file-token\n');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const features = await port.readFeatures();

  expect(features).toStrictEqual({ sessionOffsets: true, leases: true });
  expect(impd.authorizations).toStrictEqual(['Bearer file-token']);
});

test('it calls impd with the new token on the next call after the token file changes', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, 'first-token\n');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  await port.readFeatures();

  writeFileSync(tokenPath, 'second-token\n');

  await port.readFeatures();

  expect(impd.authorizations).toStrictEqual(['Bearer first-token', 'Bearer second-token']);
});

test('it refuses a call as unauthorized without reaching impd when the token file is empty', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, '\n');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const refusal: unknown = await port.readFeatures().catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'UNAUTHORIZED' });
  expect(impd.authorizations).toStrictEqual([]);
});

test('it ends a session connection as unauthorized without reaching impd when the token file is empty', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, '');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const connection = port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: false },
    { onStarted: () => {}, onOutput: () => {} },
  );

  const outcome = await connection.outcome;

  expect(outcome).toStrictEqual({ kind: 'unauthorized' });
  expect(impd.authorizations).toStrictEqual([]);
});

test('it refuses a reverse forward as unauthorized without reaching impd when the token file is empty', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, '');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  const refusal: unknown = await forward.listening.catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'UNAUTHORIZED' });
  expect(impd.authorizations).toStrictEqual([]);
});

test('it opens a guest connection relay with the token its token file holds when the relay opens', async () => {
  await using impd = setupTest();

  const tokenPath = join(impd.dir, 'imp-token');

  writeFileSync(tokenPath, 'first-token\n');

  const port = new ImpClientPort({ url: impd.url, readToken: () => readImpToken(tokenPath) });

  const forward = port.openReverseForward('imp-a', '/tmp/atc/report.sock', () => {});

  onTestFinished(() => {
    forward.stop();
  });

  await forward.listening;

  writeFileSync(tokenPath, 'second-token\n');

  const [control] = impd.controls;

  if (control === undefined) {
    throw new Error('expected a tunnel control socket');
  }

  control.send(JSON.stringify({ type: 'connection', id: 1 }));

  await waitFor(
    () => {
      expect(impd.authorizations).toStrictEqual(['Bearer first-token', 'Bearer second-token']);
    },
    { timeoutMs: 2000 },
  );
});
