import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { StateStore } from '../store/state-store';
import { answerGrantRequest } from './answer-grant-request';
import type { GrantDesk } from './answer-grant-request';

async function setupTest() {
  const tmp = setupTempDir('atc-grant-desk-');

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  const clock = { now: 1000 };

  const desk: GrantDesk = {
    store: store.grants,
    policy: {
      accessMs: 3_600_000,
      refreshMs: 2_592_000_000,
      retryWindowMs: 120_000,
      clientGraceMs: 600_000,
    },
    now: () => clock.now,
  };

  return {
    desk,
    clock,
    async [Symbol.asyncDispose]() {
      await store.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it keeps a client past its grace once a grant for it is created', async () => {
  await using ctx = await setupTest();

  const registered = await answerGrantRequest(
    'grant.registerClient',
    { name: 'dots', redirectURIs: ['https://chatgpt.com/cb'] },
    ctx.desk,
  );

  if (!('ok' in registered)) {
    throw new Error('the registration was refused');
  }

  ctx.clock.now = 700_000;

  await answerGrantRequest(
    'grant.create',
    {
      clientID: registered.ok['clientID'],
      clientName: 'dots',
      scopes: ['read'],
      resource: 'https://atc.example/mcp',
      accessHash: 'a1',
      refreshHash: 'r1',
    },
    ctx.desk,
  );

  const found = await answerGrantRequest(
    'grant.findClient',
    { clientID: registered.ok['clientID'] },
    ctx.desk,
  );

  expect(found).toStrictEqual({
    ok: {
      client: {
        clientID: registered.ok['clientID'],
        name: 'dots',
        redirectURIs: ['https://chatgpt.com/cb'],
      },
    },
  });
});
