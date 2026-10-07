import { expect, onTestFinished, test } from 'bun:test';
import { sendLinesBeforeHandshake } from './send-lines-before-handshake';

test('it sends one line on each of its connections and waits for the server to close them', async () => {
  const received: string[] = [];

  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, data) {
        received.push(data.toString());
        socket.end();
      },
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  await sendLinesBeforeHandshake(server.port, 150);

  expect(received).toStrictEqual(Array.from({ length: 150 }, () => 'not a handshake\n'));
});
