import { expect, test } from 'bun:test';
import { sendLinesBeforeHandshake } from './send-lines-before-handshake';
import { startStubRefusingListener } from './start-stub-refusing-listener';

// The listener the lines go to, which records each read and ends the
// connection it came on; disposal stops it.
function setupTest() {
  return startStubRefusingListener();
}

test('it sends one line on each of its connections and waits for the server to close them', async () => {
  using ctx = setupTest();

  await sendLinesBeforeHandshake(ctx.port, 150);

  expect(ctx.received).toStrictEqual(Array.from({ length: 150 }, () => 'not a handshake\n'));
});
