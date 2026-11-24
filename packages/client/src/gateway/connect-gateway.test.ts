import { expect, test } from 'bun:test';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import { buildStubEventStream } from '../test-utils/build-stub-event-stream';
import { buildStubGatewayError } from '../test-utils/build-stub-gateway-error';
import { buildStubGatewayFetch } from '../test-utils/build-stub-gateway-fetch';
import { connectGateway } from './connect-gateway';

test('it calls the rpc path under the url with the bearer and the major version', async () => {
  const stub = buildStubGatewayFetch([() => Response.json({ json: { dirs: ['/work'] } })]);

  const atc = connectGateway({
    url: 'https://atc.example.com/',
    token: 'tok-1',
    fetch: stub.fetch,
  });

  const answer = await atc.dirs.list({});

  expect([answer, stub.requests]).toStrictEqual([
    { dirs: ['/work'] },
    [
      {
        url: 'https://atc.example.com/rpc/dirs/list',
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer tok-1',
          'x-atc-major': String(CONTRACT_MAJOR),
        }),
        body: { json: {} },
      },
    ],
  ]);
});

test('it calls a token function before each call', async () => {
  const stub = buildStubGatewayFetch([
    () => Response.json({ json: { dirs: [] } }),
    () => Response.json({ json: { dirs: [] } }),
  ]);

  let issued = 0;

  const atc = connectGateway({
    url: 'https://atc.example.com',
    token: () => {
      issued += 1;

      return Promise.resolve(`tok-${issued}`);
    },
    fetch: stub.fetch,
  });

  await atc.dirs.list({});
  await atc.dirs.list({});

  expect(stub.requests.map((request) => request.headers['authorization'])).toStrictEqual([
    'Bearer tok-1',
    'Bearer tok-2',
  ]);
});

test('it reconnects a dropped stream after its last event id with a fresh token and neither loses nor repeats an event', async () => {
  const stub = buildStubGatewayFetch([
    () => buildStubEventStream([{ id: 'g1.a', data: { kind: 'event', seq: 1 } }], 'drop'),
    () =>
      buildStubEventStream(
        [
          { id: 'g1.b', data: { kind: 'event', seq: 2 } },
          { id: 'g1.c', data: { kind: 'event', seq: 3 } },
        ],
        'end',
      ),
  ]);

  let issued = 0;

  const atc = connectGateway({
    url: 'https://atc.example.com',
    token: () => {
      issued += 1;

      return `tok-${issued}`;
    },
    fetch: stub.fetch,
  });

  const seen: string[] = [];

  const stream = await atc.events.stream({ cursor: 'g1.0' });

  for await (const item of stream) {
    seen.push(JSON.stringify(item));
  }

  expect([
    seen,
    stub.requests.map((request) => [
      request.headers['authorization'],
      request.headers['last-event-id'] ?? null,
    ]),
  ]).toStrictEqual([
    ['{"kind":"event","seq":1}', '{"kind":"event","seq":2}', '{"kind":"event","seq":3}'],
    [
      ['Bearer tok-1', null],
      ['Bearer tok-2', 'g1.a'],
    ],
  ]);
});

test.each(['bad_args', 'protocol_mismatch', 'too_many_streams'])(
  'it never retries a stream the gateway ended with %s',
  async (code) => {
    const stub = buildStubGatewayFetch([() => buildStubGatewayError(code)]);
    const atc = connectGateway({ url: 'https://atc.example.com', token: 't', fetch: stub.fetch });
    const opened = atc.events.stream({});

    expect(opened).rejects.toMatchObject({ code });

    await opened.catch(() => {});

    expect(stub.requests).toHaveLength(1);
  },
);

test('it never retries a stream the gateway refused with HTTP 401', async () => {
  const stub = buildStubGatewayFetch([
    () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } }),
  ]);

  const atc = connectGateway({ url: 'https://atc.example.com', token: 't', fetch: stub.fetch });
  const opened = atc.events.stream({});

  expect(opened).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });

  await opened.catch(() => {});

  expect(stub.requests).toHaveLength(1);
});

test('it never retries a call, so a failed spawn surfaces at once', async () => {
  const stub = buildStubGatewayFetch([() => buildStubGatewayError('daemon_unavailable')]);
  const atc = connectGateway({ url: 'https://atc.example.com', token: 't', fetch: stub.fetch });
  const spawned = atc.session.spawn({ cwd: '/work', idempotencyKey: 'k' });

  expect(spawned).rejects.toMatchObject({ code: 'daemon_unavailable' });

  await spawned.catch(() => {});

  expect(stub.requests).toHaveLength(1);
});
