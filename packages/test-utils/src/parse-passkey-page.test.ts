import { expect, test } from 'bun:test';
import { parsePasskeyPage } from './parse-passkey-page';

test('it reads the request options of a sign-in page', () => {
  const page = parsePasskeyPage(
    '<p>x</p><script type="application/json" id="atc-passkey">{"mode":"get","options":{"challenge":"Y2g","rpId":"atc.example","timeout":1}}</script>',
  );

  expect(page).toStrictEqual({ mode: 'get', options: { challenge: 'Y2g', rpId: 'atc.example' } });
});

test('it reads the creation options of an enrollment page', () => {
  const page = parsePasskeyPage(
    '<script type="application/json" id="atc-passkey">{"mode":"create","options":{"challenge":"Y2g","rp":{"id":"atc.example","name":"atc"},"user":{"id":"b3du"}}}</script>',
  );

  expect(page).toStrictEqual({
    mode: 'create',
    options: { challenge: 'Y2g', rp: { id: 'atc.example' }, user: { id: 'b3du' } },
  });
});

test('it throws on a page with no passkey ceremony', () => {
  expect(() => parsePasskeyPage('<p>no passkey</p>')).toThrow('holds no passkey ceremony');
});

test('it throws on a ceremony of neither kind', () => {
  expect(() =>
    parsePasskeyPage(
      '<script type="application/json" id="atc-passkey">{"mode":"other","options":{}}</script>',
    ),
  ).toThrow();
});
