import { expect, test } from 'bun:test';
import { formatListenRefusal } from './format-listen-refusal';

test('it names the refused host and the ranges a listener may bind', () => {
  expect(formatListenRefusal('0.0.0.0')).toBe(
    "--listen refuses '0.0.0.0': bind a loopback address or one in 100.64.0.0/10 or fd7a:115c:a1e4::/48",
  );
});
