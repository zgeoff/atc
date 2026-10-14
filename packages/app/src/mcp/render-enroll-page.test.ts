import { expect, test } from 'bun:test';
import { renderEnrollPage } from './render-enroll-page';

test('it asks for the enrollment token before any passkey prompt', () => {
  const page = renderEnrollPage({ ceremony: null, error: null });

  expect(page).toInclude('<input name="token" autocomplete="off" autofocus required>');
  expect(page).not.toInclude('id="atc-passkey"');
});

test('it holds the creation options and the token once the token checks out', () => {
  const page = renderEnrollPage({
    ceremony: { token: 'atc-enroll-sample', options: { challenge: 'Y2hhbGxlbmdl' } },
    error: null,
  });

  expect(page).toInclude(
    '<script type="application/json" id="atc-passkey">{"mode":"create","options":{"challenge":"Y2hhbGxlbmdl"}}</script>',
  );

  expect(page).toInclude('<input type="hidden" name="token" value="atc-enroll-sample">');
});

test('it escapes the token and the error it was given', () => {
  const page = renderEnrollPage({
    ceremony: { token: '"><b>x</b>', options: { challenge: 'Y2hhbGxlbmdl' } },
    error: '<i>no</i>',
  });

  expect(page).not.toInclude('<b>x</b>');
  expect(page).toInclude('<p class="error">&lt;i&gt;no&lt;/i&gt;</p>');
});
