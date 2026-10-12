import { expect, test } from 'bun:test';
import { sendLinesBeforeHandshake } from './send-lines-before-handshake';
import { startStubRefusingListener } from './start-stub-refusing-listener';

// The listener the lines go to, which records each read and ends the
// connection it came on; it stops once the test finishes.
function setupTest() {
  const listener = startStubRefusingListener();

  return { port: listener.port, received: listener.received };
}

test('it sends one line on each of its connections and waits for the server to close them', async () => {
  const ctx = setupTest();

  await sendLinesBeforeHandshake(ctx.port, 150);

  expect(ctx.received).toStrictEqual(Array.from({ length: 150 }, () => 'not a handshake\n'));
});
