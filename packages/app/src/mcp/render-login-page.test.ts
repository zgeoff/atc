import { expect, test } from 'bun:test';
import { renderLoginPage } from './render-login-page';

test('it escapes a client name and redirect URI that carry markup', () => {
  const page = renderLoginPage({
    oauthQuery: 'q=1',
    clientName: '<b>dots</b>',
    redirectURI: 'https://dots.example/cb?x=<i>',
    options: { challenge: 'Y2hhbGxlbmdl', rpId: 'atc.example' },
    error: null,
  });

  expect(page).not.toInclude('<b>dots</b>');
  expect(page).toInclude('&lt;b&gt;dots&lt;/b&gt;');
  expect(page).toInclude('https://dots.example/cb?x=&lt;i&gt;');
});

test('it shows the error it was given', () => {
  const page = renderLoginPage({
    oauthQuery: 'q=1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
    options: { challenge: 'Y2hhbGxlbmdl', rpId: 'atc.example' },
    error: 'That passkey did not sign in.',
  });

  expect(page).toInclude('<p class="error">That passkey did not sign in.</p>');
});

test('it holds the request options for the passkey prompt in a data block', () => {
  const page = renderLoginPage({
    oauthQuery: 'q=1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
    options: { challenge: 'Y2hhbGxlbmdl', rpId: 'atc.example' },
    error: null,
  });

  expect(page).toInclude(
    '<script type="application/json" id="atc-passkey">{"mode":"get","options":{"challenge":"Y2hhbGxlbmdl","rpId":"atc.example"}}</script>',
  );
});

test('it offers no sign-in and says how to enroll when no passkey is enrolled', () => {
  const page = renderLoginPage({
    oauthQuery: 'q=1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
    options: null,
    error: null,
  });

  expect(page).not.toInclude('<form');
  expect(page).toInclude('<code>atc passkeys enroll</code>');
});
