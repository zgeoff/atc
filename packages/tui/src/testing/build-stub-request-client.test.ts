import { expect, test } from 'bun:test';
import { buildStubRequestClient } from './build-stub-request-client';

test('it answers a method from its table and records the method', async () => {
  const client = buildStubRequestClient({ 'session.list': { sessions: [] } });

  const answer = await client.sendRequest('session.list');

  expect({ answer, asked: client.asked }).toStrictEqual({
    answer: { sessions: [] },
    asked: ['session.list'],
  });
});

test('it answers a method outside its table with nothing', async () => {
  const client = buildStubRequestClient({});

  const answer = await client.sendRequest('fleet.list');

  expect(answer).toStrictEqual({});
});

test('it refuses every request when it is built with a failure', () => {
  const client = buildStubRequestClient({}, new Error('the connection dropped'));

  expect(client.sendRequest('session.list')).rejects.toThrow('the connection dropped');
});
