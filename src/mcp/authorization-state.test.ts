import { expect, test } from 'bun:test';
import { AuthorizationState } from './authorization-state';

test('it approves a pending request with its code typed in any case and with a dash', () => {
  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => 1000);

  const approval = state.createPending({
    client: { clientID: 'c1', name: 'dots', redirectURIs: ['https://dots.example/cb'] },
    redirectURI: 'https://dots.example/cb',
    state: null,
    codeChallenge: 'challenge',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
  });

  if (approval === null) {
    throw new Error('the approval was refused');
  }

  const typed = `${approval.approvalCode.slice(0, 4)}-${approval.approvalCode.slice(4)}`;

  expect(state.verifyApprovalCode(approval.id, typed.toLowerCase())).toBe('ok');
  expect(state.findPending(approval.id)).toBeNull();
});

test('it drops a pending request after the fifth wrong code', () => {
  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => 1000);

  const approval = state.createPending({
    client: { clientID: 'c1', name: 'dots', redirectURIs: ['https://dots.example/cb'] },
    redirectURI: 'https://dots.example/cb',
    state: null,
    codeChallenge: 'challenge',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
  });

  if (approval === null) {
    throw new Error('the approval was refused');
  }

  const results = [1, 2, 3, 4, 5].map(() => state.verifyApprovalCode(approval.id, 'WRONG000'));

  expect(results).toStrictEqual(['wrong', 'wrong', 'wrong', 'wrong', 'locked']);
  expect(state.verifyApprovalCode(approval.id, approval.approvalCode)).toBe('locked');
});

test('it refuses a sixth pending request while five wait', () => {
  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => 1000);

  const request = {
    client: { clientID: 'c1', name: 'dots', redirectURIs: ['https://dots.example/cb'] },
    redirectURI: 'https://dots.example/cb',
    state: null,
    codeChallenge: 'challenge',
    scopes: ['read' as const],
    resource: 'https://atc.example/mcp',
  };

  const created = [1, 2, 3, 4, 5].map(() => state.createPending(request));

  expect(created).toSatisfyAll((approval) => approval !== null);
  expect(state.createPending(request)).toBeNull();
});

test('it reports a second exchange of a code as reuse of the grant it produced', () => {
  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => 1000);

  const code = state.createCode({
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
    codeChallenge: 'challenge',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
  });

  const first = state.claimCode(code);

  state.updateCodeGrant(code, 'g-1');

  expect(first).toMatchObject({ kind: 'claimed' });
  expect(state.claimCode(code)).toStrictEqual({ kind: 'reused', grantID: 'g-1' });
});

test('it asks for the grant to be revoked when a code is reused before its grant exists', () => {
  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => 1000);

  const code = state.createCode({
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
    codeChallenge: 'challenge',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
  });

  state.claimCode(code);
  state.claimCode(code);

  expect(state.updateCodeGrant(code, 'g-1')).toBeTrue();
});

test('it forgets a code once it expires', () => {
  let now = 1000;

  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => now);

  const code = state.createCode({
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
    codeChallenge: 'challenge',
    scopes: ['read'],
    resource: 'https://atc.example/mcp',
  });

  now = 70_000;

  expect(state.claimCode(code)).toStrictEqual({ kind: 'unknown' });
});
