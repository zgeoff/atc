import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { ImpClientPort } from './imp-client-port';
import { readImpToken } from './read-imp-token';

// An impd stand-in on a real HTTP port that records the authorization
// header of each call and answers every call as system info, plus a temp
// directory for the token file.
function setupTest() {
  const tmp = setupTempDir('atc-imp-client-port-');
  const authorizations: (string | null)[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      authorizations.push(request.headers.get('authorization'));

      return Response.json({ json: { features: { sessionOffsets: true, leases: true } } });
    },
  });

  return {
    dir: tmp.dir,
    url: `http://127.0.0.1:${String(server.port)}`,
    authorizations,
    async [Symbol.asyncDispose]() {
      await server.stop(true);

      tmp[Symbol.dispose]();
    },
  };
}

test('it calls impd with the token its token file holds, without the trailing newline', async () => {
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
