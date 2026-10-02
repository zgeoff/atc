import { expect, test } from 'bun:test';
import { renderApprovalPage } from './render-approval-page';

test('it escapes a client name that carries markup', () => {
  const page = renderApprovalPage({
    pendingID: 'p1',
    clientName: '<script>alert(1)</script>',
    redirectHost: 'dots.example',
    scopes: ['read'],
    error: null,
  });

  expect(page).not.toInclude('<script>alert(1)</script>');
  expect(page).toInclude('&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('it starts with read and message granted and spawn and kill withheld', () => {
  const page = renderApprovalPage({
    pendingID: 'p1',
    clientName: 'dots',
    redirectHost: 'dots.example',
    scopes: ['read', 'message', 'spawn', 'kill'],
    error: null,
  });

  expect(page).toInclude('value="read" checked');
  expect(page).toInclude('value="message" checked');
  expect(page).toInclude('value="spawn">');
  expect(page).toInclude('value="kill">');
});

test('it offers only the scopes the client requested', () => {
  const page = renderApprovalPage({
    pendingID: 'p1',
    clientName: 'dots',
    redirectHost: 'dots.example',
    scopes: ['read'],
    error: null,
  });

  expect(page).not.toInclude('value="kill"');
});
