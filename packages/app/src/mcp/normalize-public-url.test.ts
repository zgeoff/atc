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
  ['not a url', "the public URL 'not a url' is not a URL"],
  [
    'http://mcp.example.com',
    "the public URL 'http://mcp.example.com' must use https unless its host is loopback",
  ],
  [
    'https://mcp.example.com/mcp',
    "the public URL 'https://mcp.example.com/mcp' must be a bare origin, with no path, query, or fragment",
  ],
  [
    'https://mcp.example.com/?a=1',
    "the public URL 'https://mcp.example.com/?a=1' must be a bare origin, with no path, query, or fragment",
  ],
  [
    'https://mcp.example.com/#top',
    "the public URL 'https://mcp.example.com/#top' must be a bare origin, with no path, query, or fragment",
  ],
  [
    'https://user:pass@mcp.example.com',
    "the public URL 'https://user:pass@mcp.example.com' must not carry credentials",
  ],
])('it refuses %p as a public URL with the message %p', (raw, message) => {
  expect(() => normalizePublicURL(raw)).toThrowWithMessage(Error, message);
});
