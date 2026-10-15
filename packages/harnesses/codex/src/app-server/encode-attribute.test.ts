import { expect, test } from 'bun:test';
import { encodeAttribute } from './encode-attribute';

test('it encodes the characters that end or open an attribute', () => {
  expect(encodeAttribute('a "b" <c> & d')).toBe('a &quot;b&quot; &lt;c&gt; &amp; d');
});
