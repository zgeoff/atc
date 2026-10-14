import { expect, test } from 'bun:test';
import { toScriptJSON } from './to-script-json';

test('it escapes the characters that could end a script block', () => {
  expect(toScriptJSON({ name: '</script><!-- & -->' })).toBe(
    String.raw`{"name":"\u003c/script\u003e\u003c!-- \u0026 --\u003e"}`,
  );
});

test('it parses back to the value it was given', () => {
  const value = { name: '</script><!-- & -->', count: 2 };

  expect(JSON.parse(toScriptJSON(value))).toStrictEqual(value);
});
