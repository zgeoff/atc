import { expect, onTestFinished, test } from 'bun:test';
import { takeFreePort } from './take-free-port';

test('it returns a port that a listener can bind', () => {
  const port = takeFreePort();
  const listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });

  onTestFinished(() => {
    listener.stop(true);
  });

  expect(listener.port).toBe(port);
});
