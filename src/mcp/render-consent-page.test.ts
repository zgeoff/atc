import { expect, test } from 'bun:test';
import { renderConsentPage } from './render-consent-page';

test('it escapes a client name that carries markup', () => {
  const page = renderConsentPage({
    oauthQuery: 'q=1',
    clientName: '<script>alert(1)</script>',
    redirectURI: 'https://dots.example/cb',
    scopes: ['read'],
  });

  expect(page).not.toInclude('<script>alert(1)</script>');
  expect(page).toInclude('&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('it starts with only read granted', () => {
  const page = renderConsentPage({
    oauthQuery: 'q=1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
    scopes: ['read', 'message', 'spawn', 'kill'],
  });

  expect(page).toInclude('value="read" checked');
  expect(page).toInclude('value="message">');
  expect(page).toInclude('value="spawn">');
  expect(page).toInclude('value="kill">');
});

test('it describes the message scope as instructing agents that can run commands', () => {
  const page = renderConsentPage({
    oauthQuery: 'q=1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
    scopes: ['message'],
  });

  expect(page).toInclude(
    'value="message"> Send instructions to your agents, which can run commands on this machine',
  );
});

test('it escapes the signed query it posts back', () => {
  const page = renderConsentPage({
    oauthQuery: 'a="><b>',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
    scopes: ['read'],
  });

  expect(page).toInclude('name="oauth_query" value="a=&quot;&gt;&lt;b&gt;"');
});
