import { expect, test } from 'bun:test';
import { acquireSharedImpd } from './acquire-shared-impd';

test('it hands the same impd to each acquire with the same options', async () => {
  const first = await acquireSharedImpd({ version: '2.2.0' });
  const second = await acquireSharedImpd({ version: '2.2.0' });

  expect(second).toBe(first);
});

test('it hands another impd to an acquire with other options', async () => {
  const first = await acquireSharedImpd({ version: '2.2.0' });
  const second = await acquireSharedImpd({ version: '2.3.0' });
  const info = await second.client.system.info();

  expect(second).not.toBe(first);
  expect(info.version).toBe('2.3.0');
});

test('it seeds the ubuntu image', async () => {
  const impd = await acquireSharedImpd();

  await impd.client.imps.create({ name: 'box', image: 'ubuntu' });

  const imps = await impd.client.imps.list();

  expect(imps.map((imp) => imp.name)).toStrictEqual(['box']);
});

test('it removes the imps, secrets and tokens an earlier test made', async () => {
  const first = await acquireSharedImpd();

  await first.client.imps.create({ name: 'box', image: 'ubuntu' });

  await first.client.secrets.add({
    kind: 'static',
    name: 'key',
    value: 'value',
    rules: [{ host: 'api.example.test', header: 'authorization', scheme: 'bearer' }],
  });

  await first.client.tokens.create({ name: 'extra', scope: 'manage' });

  const second = await acquireSharedImpd();
  const imps = await second.client.imps.list();
  const secrets = await second.client.secrets.list();
  const tokens = await second.client.tokens.list();

  expect([imps, secrets, tokens]).toStrictEqual([[], [], []]);
});

test('it clears the faults an earlier test set', async () => {
  const first = await acquireSharedImpd();

  first.fail('system/info', { status: 500, body: { message: 'down' } });

  const second = await acquireSharedImpd();

  await expect(second.client.system.info()).toResolve();
});
