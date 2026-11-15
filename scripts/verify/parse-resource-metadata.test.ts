import { expect, test } from 'bun:test';
import { parseResourceMetadata } from './parse-resource-metadata.ts';

test('it gives the resource of a server that names its own origin', () => {
  const answer = {
    status: 200,
    json: {
      resource: 'https://tower.example/mcp',
      authorization_servers: ['https://tower.example'],
    },
  };

  expect(parseResourceMetadata(answer, 'https://tower.example')).toBe('https://tower.example/mcp');
});

test.each([
  {
    fault: 'a status other than 200',
    status: 404,
    json: {
      resource: 'https://tower.example/mcp',
      authorization_servers: ['https://tower.example'],
    },
  },
  { fault: 'a body that is not metadata', status: 200, json: { error: 'not_found' } },
  {
    fault: 'another resource',
    status: 200,
    json: {
      resource: 'https://hangar.example/mcp',
      authorization_servers: ['https://tower.example'],
    },
  },
  {
    fault: 'another authorization server',
    status: 200,
    json: {
      resource: 'https://tower.example/mcp',
      authorization_servers: ['https://hangar.example'],
    },
  },
])('it gives null for a server that answers with $fault', (row) => {
  expect(parseResourceMetadata(row, 'https://tower.example')).toBeNull();
});
