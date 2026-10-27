import { expect, test } from 'bun:test';
import { collectMCPHTTPConfig } from './collect-mcp-http-config';

test('it reads every mcpHTTP setting', () => {
  expect(
    collectMCPHTTPConfig({
      publicURL: 'https://mcp.example.com',
      host: '0.0.0.0',
      port: 9000,
      allowedHosts: ['pc.tailnet.ts.net'],
      trustForwardedFrom: ['127.0.0.1'],
      allowedOrigins: ['https://panel.example.com'],
    }),
  ).toStrictEqual({
    publicURL: 'https://mcp.example.com',
    host: '0.0.0.0',
    port: 9000,
    allowedHosts: ['pc.tailnet.ts.net'],
    trustForwardedFrom: ['127.0.0.1'],
    allowedOrigins: ['https://panel.example.com'],
  });
});

test('it falls back to the defaults for an absent section', () => {
  expect(collectMCPHTTPConfig(undefined)).toStrictEqual({
    publicURL: null,
    host: '127.0.0.1',
    port: 8414,
    allowedHosts: [],
    trustForwardedFrom: [],
    allowedOrigins: [],
  });
});

test('it drops wrong-typed settings and entries', () => {
  expect(
    collectMCPHTTPConfig({
      publicURL: 7,
      host: 1,
      port: 'x',
      allowedHosts: ['a', 3],
      trustForwardedFrom: ['127.0.0.1', 4, ''],
      allowedOrigins: ['https://panel.example.com', 5],
    }),
  ).toStrictEqual({
    publicURL: null,
    host: '127.0.0.1',
    port: 8414,
    allowedHosts: ['a'],
    trustForwardedFrom: ['127.0.0.1'],
    allowedOrigins: ['https://panel.example.com'],
  });
});

test('it trusts no proxy when trustForwardedFrom is not a list', () => {
  expect(collectMCPHTTPConfig({ trustForwardedFrom: '127.0.0.1' })).toStrictEqual({
    publicURL: null,
    host: '127.0.0.1',
    port: 8414,
    allowedHosts: [],
    trustForwardedFrom: [],
    allowedOrigins: [],
  });
});

test.each([0, 65_536, 80.5])('it falls back to port 8414 for a configured port of %p', (port) => {
  expect(collectMCPHTTPConfig({ port })).toStrictEqual({
    publicURL: null,
    host: '127.0.0.1',
    port: 8414,
    allowedHosts: [],
    trustForwardedFrom: [],
    allowedOrigins: [],
  });
});
