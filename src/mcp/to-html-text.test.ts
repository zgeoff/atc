import { expect, test } from 'bun:test';
import { toHTMLText } from './to-html-text';

test('it escapes every character that could open markup or end an attribute', () => {
  expect(toHTMLText(`<a href="x" onclick='y'>&</a>`)).toBe(
    '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
  );
});
