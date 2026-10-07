import { expect, test } from 'bun:test';
import { readJSONRecord } from './read-json-record';

test('it reads a JSON object body as a record', async () => {
  const response = new Response('{"token_type":"Bearer","expires_in":3600}');

  const body = await readJSONRecord(response);

  expect(body).toStrictEqual({ token_type: 'Bearer', expires_in: 3600 });
});

test('it rejects a JSON array body', () => {
  const response = new Response('[{"id":"g-1"}]');

  expect(readJSONRecord(response)).rejects.toThrowWithMessage(
    TypeError,
    'response body is not a JSON object',
  );
});

test('it rejects a JSON null body', () => {
  const response = new Response('null');

  expect(readJSONRecord(response)).rejects.toThrowWithMessage(
    TypeError,
    'response body is not a JSON object',
  );
});
