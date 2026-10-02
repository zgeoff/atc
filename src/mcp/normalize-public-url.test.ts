import { expect, test } from 'bun:test';
import { normalizePublicURL } from './normalize-public-url';

test.each([
  ['https://mcp.example.com', 'https://mcp.example.com'],
  ['https://mcp.example.com/', 'https://mcp.example.com'],
  ['https://MCP.example.com:8443', 'https://mcp.example.com:8443'],
  ['http://127.0.0.1:8414', 'http://127.0.0.1:8414'],
  ['http://localhost:8414/', 'http://localhost:8414'],
])('it normalizes %p to the origin %p', (raw, origin) => {
  expect(normalizePublicURL(raw)).toBe(origin);
});

test.each([
  ['not a url'],
  ['http://mcp.example.com'],
  ['https://mcp.example.com/mcp'],
  ['https://mcp.example.com/?a=1'],
  ['https://mcp.example.com/#top'],
  ['https://user:pass@mcp.example.com'],
])('it refuses %p as a public URL', (raw) => {
  expect(() => normalizePublicURL(raw)).toThrow();
});
