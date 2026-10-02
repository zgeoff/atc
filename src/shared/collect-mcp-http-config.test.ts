import { expect, test } from 'bun:test';
import { collectMCPHTTPConfig } from './collect-mcp-http-config';

test('it reads every mcpHTTP setting', () => {
  expect(
    collectMCPHTTPConfig({
      publicURL: 'https://mcp.example.com',
      port: 9000,
      allowedHosts: ['pc.tailnet.ts.net'],
      clientMetadataHosts: ['chatgpt.com'],
    }),
  ).toStrictEqual({
    publicURL: 'https://mcp.example.com',
    port: 9000,
    allowedHosts: ['pc.tailnet.ts.net'],
    clientMetadataHosts: ['chatgpt.com'],
  });
});

test('it falls back to the defaults for an absent section', () => {
  expect(collectMCPHTTPConfig(undefined)).toStrictEqual({
    publicURL: null,
    port: 8414,
    allowedHosts: [],
    clientMetadataHosts: [],
  });
});

test('it drops wrong-typed settings and entries', () => {
  expect(
    collectMCPHTTPConfig({
      publicURL: 7,
      port: 'x',
      allowedHosts: ['a', 3],
      clientMetadataHosts: 'b',
    }),
  ).toStrictEqual({ publicURL: null, port: 8414, allowedHosts: ['a'], clientMetadataHosts: [] });
});
