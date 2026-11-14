import { expect, test } from 'bun:test';
import { findMCPResource } from './find-mcp-resource';

test.each([
  ['https://mcp.example.com/', 8414, 'https://mcp.example.com/mcp'],
  [null, 8414, 'http://127.0.0.1:8414/mcp'],
  [null, 0, null],
  ['not a url', 8414, null],
])('it finds the resource for public URL %p and port %p as %p', (publicURL, port, resource) => {
  expect(findMCPResource(publicURL, port)).toBe(resource);
});
