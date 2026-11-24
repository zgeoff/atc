import { expect, test } from 'bun:test';
import { formatRequestLine } from './format-request-line';

test.each([
  {
    url: 'http://gateway.test/rpc/session/spawn?token=abc',
    logged: 'POST /rpc/session/spawn 200 12ms',
  },
  { url: 'http://gateway.test/rpc/session/spawn/extra?x=1', logged: 'POST /rpc 200 12ms' },
  { url: 'http://gateway.test/mcp?x=1', logged: 'POST /mcp 200 12ms' },
])('it records $url as $logged, with no query and no extra path under /rpc', (row) => {
  const request = new Request(row.url, { method: 'POST' });

  expect(formatRequestLine(request, null, 200, 12)).toBe(row.logged);
});
