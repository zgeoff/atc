import { expect, test } from 'bun:test';
import { startStubRefusingListener } from '@atc/protocol/test-utils/start-stub-refusing-listener';
import { sendLinesBeforeHandshake } from './send-lines-before-handshake';

function setupTest() {
  const listener = startStubRefusingListener();

  return { port: listener.port, received: listener.received };
}

test('it sends one line on each of its connections and waits for the server to close them', async () => {
  const ctx = setupTest();

  await sendLinesBeforeHandshake(ctx.port, 150);

  expect(ctx.received).toStrictEqual(Array.from({ length: 150 }, () => 'not a handshake\n'));
});
