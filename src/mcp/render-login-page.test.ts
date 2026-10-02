import { expect, test } from 'bun:test';
import { renderLoginPage } from './render-login-page';

test('it escapes a client name and redirect URI that carry markup', () => {
  const page = renderLoginPage({
    oauthQuery: 'q=1',
    clientName: '<b>dots</b>',
    redirectURI: 'https://dots.example/cb?x=<i>',
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
    error: 'That approval code is wrong.',
  });

  expect(page).toInclude('<p class="error">That approval code is wrong.</p>');
});
