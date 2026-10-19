import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBrokeredClaude } from './create-stub-brokered-claude';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { updateEnv } from './update-env';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-brokered-claude-');
  const received: string[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      received.push(request.headers.get('authorization') ?? '');

      return new Response('{}', { status: 200 });
    },
  });

  onTestFinished(async () => {
    await server.stop(true);
  });

  return { dir: temporaryDirectory.dir, url: `http://127.0.0.1:${server.port}/user`, received };
}

test('it returns the path of the stub under the directory', () => {
  const ctx = setupTest();

  expect(createStubBrokeredClaude(ctx.dir, ctx.url)).toBe(join(ctx.dir, 'fake-claude'));
});

test('it writes no status before it runs', () => {
  const ctx = setupTest();

  createStubBrokeredClaude(ctx.dir, ctx.url);

  expect(existsSync(join(ctx.dir, 'brokered-status'))).toBeFalse();
});

test('it sends the auth token of its settings file as a bearer token and writes the status', async () => {
  const ctx = setupTest();

  updateEnv('HTTPS_PROXY', undefined);
  updateEnv('https_proxy', undefined);

  const bin = createStubBrokeredClaude(ctx.dir, ctx.url);
  const settings = join(ctx.dir, 'settings.json');

  writeFileSync(
    settings,
    JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' } }, null, 2),
  );

  const run = Bun.spawn([bin, '--model', 'opus', '--settings', settings]);

  registerTestCleanup(() => {
    run.kill();
  });

  await waitFor(() => {
    expect(readFileSync(join(ctx.dir, 'brokered-status'), 'utf8')).toBe('200');
  });

  expect(ctx.received).toStrictEqual(['Bearer broker-placeholder']);
});

test('it exports the proxy variables of the process that creates it', () => {
  const ctx = setupTest();

  updateEnv('HTTPS_PROXY', "http://proxy.example:3128/it's");

  const bin = createStubBrokeredClaude(ctx.dir, ctx.url);

  expect(readFileSync(bin, 'utf8')).toInclude(
    String.raw`export HTTPS_PROXY='http://proxy.example:3128/it'\''s'`,
  );
});
