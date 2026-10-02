import { expect, test } from 'bun:test';
import { buildConsentBinding } from './build-consent-binding';

test('it builds the same binding from the login and consent queries of one request', () => {
  const login = buildConsentBinding(
    'client_id=c1&redirect_uri=https%3A%2F%2Fdots.example%2Fcb&state=s1&code_challenge=x1&prompt=login+consent&exp=1&ba_iat=1&sig=a',
  );

  const consent = buildConsentBinding(
    'client_id=c1&redirect_uri=https%3A%2F%2Fdots.example%2Fcb&state=s1&code_challenge=x1&prompt=consent&exp=2&ba_iat=2&sig=b',
  );

  expect(consent).toBe(login);
});

test.each([
  ['client_id=c2&redirect_uri=https%3A%2F%2Fdots.example%2Fcb&state=s1&code_challenge=x1'],
  ['client_id=c1&redirect_uri=https%3A%2F%2Fother.example%2Fcb&state=s1&code_challenge=x1'],
  ['client_id=c1&redirect_uri=https%3A%2F%2Fdots.example%2Fcb&state=s2&code_challenge=x1'],
  ['client_id=c1&redirect_uri=https%3A%2F%2Fdots.example%2Fcb&state=s1&code_challenge=x2'],
  ['client_id=c1&redirect_uri=https%3A%2F%2Fdots.example%2Fcb&code_challenge=x1'],
])('it builds a different binding for the query %p', (other) => {
  const approved = buildConsentBinding(
    'client_id=c1&redirect_uri=https%3A%2F%2Fdots.example%2Fcb&state=s1&code_challenge=x1',
  );

  expect(buildConsentBinding(other)).not.toBe(approved);
});
