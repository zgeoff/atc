import { expect, test } from 'bun:test';
import { sendLinesBeforeHandshake } from './send-lines-before-handshake';
import { startStubRefusingListener } from './start-stub-refusing-listener';

test('it sends one line on each of its connections and waits for the server to close them', async () => {
  using listener = startStubRefusingListener();

  await sendLinesBeforeHandshake(listener.port, 150);

  expect(listener.received).toStrictEqual(Array.from({ length: 150 }, () => 'not a handshake\n'));
});
