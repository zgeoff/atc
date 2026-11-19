import { expect, onTestFinished, test } from 'bun:test';
import { createSpritesApiPort } from './create-sprites-api-port';

function setupTest() {
  const seen: { readonly path: string; readonly authorization: string | null }[] = [];

  const answerRequest = (request: Request): Response => {
    const url = new URL(request.url);

    const authorization = request.headers.get('authorization');

    seen.push({ path: url.pathname, authorization });

    if (url.pathname === '/v1/oauth/connections') {
      return Response.json({
        connections: [
          {
            id: 'conn_a',
            provider: 'custom_api',
            access_policy: { allow_all: false, name_prefix: 'atc-' },
          },
          { id: 'conn_b', provider: 'custom_api', access_policy: {} },
          { id: 'conn_c', provider: 'github' },
        ],
      });
    }

    if (url.pathname === '/v1/sprites/atc-gone') {
      return new Response('not found', { status: 404 });
    }

    if (url.pathname === '/v1/sprites/atc-down') {
      return new Response(`the gateway echoed ${authorization ?? ''}`, { status: 502 });
    }

    return new Response('unexpected', { status: 500 });
  };

  const server = Bun.serve({ port: 0, fetch: answerRequest });

  onTestFinished(async () => {
    await server.stop(true);
  });

  const port = createSpritesApiPort({
    apiURL: `http://127.0.0.1:${server.port}`,
    readToken: () => 'org/id/secret-token',
  });

  return { port, seen };
}

test('it reads the connectors with their name prefixes, and null for a connector with none', async () => {
  const ctx = setupTest();

  const connectors = await ctx.port.readConnectors();

  expect(connectors).toStrictEqual([
    { id: 'conn_a', provider: 'custom_api', namePrefix: 'atc-' },
    { id: 'conn_b', provider: 'custom_api', namePrefix: null },
    { id: 'conn_c', provider: 'github', namePrefix: null },
  ]);

  expect(ctx.seen).toStrictEqual([
    { path: '/v1/oauth/connections', authorization: 'Bearer org/id/secret-token' },
  ]);
});

test('it reads a sprite the API does not know as null', async () => {
  const ctx = setupTest();

  const sprite = await ctx.port.readSprite('atc-gone');

  expect(sprite).toBeNull();
});

test('it rejects with the API status and a message that never holds the token', async () => {
  const ctx = setupTest();
  const reading = ctx.port.readSprite('atc-down');

  const outcome = await reading.catch((error: unknown) => error);

  expect(outcome).toMatchObject({ name: 'SpritesApiError', status: 502 });
  expect(outcome).toHaveProperty('message', expect.stringContaining('the gateway echoed'));
  expect(outcome).toHaveProperty('message', expect.not.stringContaining('secret-token'));
});

test('it treats a sprite the API no longer holds as already deleted', () => {
  const ctx = setupTest();

  expect(ctx.port.removeSprite('atc-gone')).resolves.toBeUndefined();
});
