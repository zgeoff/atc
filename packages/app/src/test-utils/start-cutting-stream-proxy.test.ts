import { expect, onTestFinished, test } from 'bun:test';
import { startCuttingStreamProxy } from './start-cutting-stream-proxy';

function setupTest() {
  const messages = 'event: message\ndata: 1\nid: a\n\nevent: message\ndata: 2\nid: b\n\n';

  // oxlint-disable-next-line zgeoff/function-verb -- Bun.serve names its handler fetch
  const upstream = Bun.serve({ port: 0, fetch: () => new Response(messages) });

  onTestFinished(async () => {
    await upstream.stop(true);
  });

  const proxy = startCuttingStreamProxy(`http://127.0.0.1:${upstream.port}`);

  onTestFinished(async () => {
    await proxy.stop();
  });

  return { proxy, messages };
}

test('it forwards a request that is no event stream untouched', async () => {
  const ctx = setupTest();

  const response = await fetch(`${ctx.proxy.url}/rpc/dirs/list`, { method: 'POST' });
  const text = await response.text();

  expect(text).toBe(ctx.messages);
});

test('it cuts the first event stream after its first message and forwards the next whole', async () => {
  const ctx = setupTest();

  const cut = await fetch(`${ctx.proxy.url}/rpc/events/stream`, { method: 'POST' });

  const reader = cut.body?.getReader();

  const first = await reader?.read();

  const bytes: unknown = first?.value;

  const whole = await fetch(`${ctx.proxy.url}/rpc/events/stream`, {
    method: 'POST',
    headers: { 'last-event-id': 'a' },
  });

  const wholeText = await whole.text();

  expect([
    bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : null,
    wholeText,
    ctx.proxy.streamRequests,
  ]).toStrictEqual(['event: message\ndata: 1\nid: a\n\n', ctx.messages, [null, 'a']]);

  expect(reader?.read()).rejects.toThrow();
});
