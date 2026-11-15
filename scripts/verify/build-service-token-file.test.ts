import { expect, test } from 'bun:test';
import { buildServiceTokenFile } from './build-service-token-file.ts';

test('it names the origin and /mcp as the resource, and gives the run client every scope and the digest alone', () => {
  expect(buildServiceTokenFile('http://127.0.0.1:41234', 'a'.repeat(64))).toStrictEqual({
    resource: 'http://127.0.0.1:41234/mcp',
    clients: {
      'verify-local': {
        scopes: ['read', 'message', 'spawn', 'kill'],
        secretDigests: ['a'.repeat(64)],
      },
    },
  });
});
