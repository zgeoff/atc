import { expect, test } from 'bun:test';
import { renderApprovalPage } from './render-approval-page';

test('it escapes a client name that carries markup', () => {
  const page = renderApprovalPage({
    pendingID: 'p1',
    client: {
      clientID: 'c1',
      name: '<script>alert(1)</script>',
      redirectURIs: ['https://dots.example/cb'],
      verified: false,
    },
    redirectURI: 'https://dots.example/cb',
    scopes: ['read'],
    error: null,
  });

  expect(page).not.toInclude('<script>alert(1)</script>');
  expect(page).toInclude('&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('it starts with only read granted', () => {
  const page = renderApprovalPage({
    pendingID: 'p1',
    client: {
      clientID: 'c1',
      name: 'dots',
      redirectURIs: ['https://dots.example/cb'],
      verified: false,
    },
    redirectURI: 'https://dots.example/cb',
    scopes: ['read', 'message', 'spawn', 'kill'],
    error: null,
  });

  expect(page).toInclude('value="read" checked');
  expect(page).toInclude('value="message">');
  expect(page).toInclude('value="spawn">');
  expect(page).toInclude('value="kill">');
});

test('it describes the message scope as instructing agents that can run commands', () => {
  const page = renderApprovalPage({
    pendingID: 'p1',
    client: {
      clientID: 'c1',
      name: 'dots',
      redirectURIs: ['https://dots.example/cb'],
      verified: false,
    },
    redirectURI: 'https://dots.example/cb',
    scopes: ['message'],
    error: null,
  });

  expect(page).toInclude(
    'value="message"> Send instructions to your agents, which can run commands on this machine',
  );
});

test('it labels a self-registered client unverified and shows its full redirect uri', () => {
  const page = renderApprovalPage({
    pendingID: 'p1',
    client: {
      clientID: 'c1',
      name: 'ChatGPT',
      redirectURIs: ['https://evil.example/oauth/cb?x=1'],
      verified: false,
    },
    redirectURI: 'https://evil.example/oauth/cb?x=1',
    scopes: ['read'],
    error: null,
  });

  expect(page).toInclude('<strong class="warning">unverified</strong>: it registered itself');
  expect(page).toInclude('<code>https://evil.example/oauth/cb?x=1</code>');
});

test('it shows the host that published a verified client', () => {
  const page = renderApprovalPage({
    pendingID: 'p1',
    client: {
      clientID: 'https://chatgpt.com/oauth/client.json',
      name: 'ChatGPT',
      redirectURIs: ['https://chatgpt.com/connector/oauth/cb'],
      verified: true,
    },
    redirectURI: 'https://chatgpt.com/connector/oauth/cb',
    scopes: ['read'],
    error: null,
  });

  expect(page).toInclude('verified: its identity is published at <strong>chatgpt.com</strong>');
  expect(page).not.toInclude('unverified');
});

test('it offers only the scopes the client requested', () => {
  const page = renderApprovalPage({
    pendingID: 'p1',
    client: {
      clientID: 'c1',
      name: 'dots',
      redirectURIs: ['https://dots.example/cb'],
      verified: false,
    },
    redirectURI: 'https://dots.example/cb',
    scopes: ['read'],
    error: null,
  });

  expect(page).not.toInclude('value="kill"');
});
