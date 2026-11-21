import { expect, test } from 'bun:test';
import { measureWidth } from './measure-width';

test.each([
  { title: 'ascii', text: 'laptop', width: 6 },
  { title: 'a wide character', text: '界', width: 2 },
  { title: 'wide characters among ascii', text: 'a界b', width: 4 },
  { title: 'a spinner glyph', text: '⠋', width: 1 },
  { title: 'an emoji with a presentation selector', text: '❤\u{FE0F}', width: 2 },
  { title: 'a control character', text: '\u0007', width: 0 },
  { title: 'nothing', text: '', width: 0 },
])('#measureWidth counts $title in terminal columns', (row) => {
  expect(measureWidth(row.text)).toBe(row.width);
});
