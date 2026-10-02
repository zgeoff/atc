import { expect, test } from 'bun:test';
import { AuthorizationState } from './authorization-state';

test('it approves a pending request with its code typed in any case and with a dash', () => {
  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => 1000);

  const approval = state.createPending({
    client: {
      clientID: 'c1',
      name: 'dots',
      redirectURIs: ['https://dots.example/cb'],
      verified: false,
    },
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
    client: {
      clientID: 'c1',
      name: 'dots',
      redirectURIs: ['https://dots.example/cb'],
      verified: false,
    },
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

test("it drops a client's oldest waiting approval when it starts a fourth", () => {
  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => 1000);

  const request = {
    client: {
      clientID: 'c1',
      name: 'dots',
      redirectURIs: ['https://dots.example/cb'],
      verified: false,
    },
    redirectURI: 'https://dots.example/cb',
    state: null,
    codeChallenge: 'challenge',
    scopes: ['read' as const],
    resource: 'https://atc.example/mcp',
  };

  const created = Array.from({ length: 4 }, () => state.createPending(request));

  const found = created.map((approval) => {
    if (approval === null) {
      throw new Error('an approval was refused');
    }

    return state.findPending(approval.id);
  });

  expect(found).toStrictEqual(created.with(0, null));
});

test('it drops the oldest waiting approval to make room for a seventeenth', () => {
  let now = 1000;

  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => now);

  const created = Array.from({ length: 17 }, (_, index) => {
    now = 1000 + index * 7000;

    return state.createPending({
      client: {
        clientID: `c${index}`,
        name: `c${index}`,
        redirectURIs: ['https://dots.example/cb'],
        verified: false,
      },
      redirectURI: 'https://dots.example/cb',
      state: null,
      codeChallenge: 'challenge',
      scopes: ['read'],
      resource: 'https://atc.example/mcp',
    });
  });

  now = 1000 + 16 * 7000;

  const found = created.map((approval) => {
    if (approval === null) {
      throw new Error('an approval was refused');
    }

    return state.findPending(approval.id);
  });

  expect(found).toStrictEqual(created.with(0, null));
});

test('it refuses an eleventh approval started within a minute', () => {
  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => 1000);

  const created = Array.from({ length: 11 }, (_, index) =>
    state.createPending({
      client: {
        clientID: `c${index}`,
        name: `c${index}`,
        redirectURIs: ['https://dots.example/cb'],
        verified: false,
      },
      redirectURI: 'https://dots.example/cb',
      state: null,
      codeChallenge: 'challenge',
      scopes: ['read'],
      resource: 'https://atc.example/mcp',
    }),
  );

  expect(created.slice(0, 10)).toSatisfyAll((approval) => approval !== null);
  expect(created[10]).toBeNull();
});

test('it starts approvals again a minute after the limit was reached', () => {
  let now = 1000;

  const state = new AuthorizationState({ pendingMs: 600_000, codeMs: 60_000 }, () => now);

  const request = {
    client: {
      clientID: 'c1',
      name: 'dots',
      redirectURIs: ['https://dots.example/cb'],
      verified: false,
    },
    redirectURI: 'https://dots.example/cb',
    state: null,
    codeChallenge: 'challenge',
    scopes: ['read' as const],
    resource: 'https://atc.example/mcp',
  };

  Array.from({ length: 10 }, () => state.createPending(request));

  now = 1000 + 60_000;

  expect(state.createPending(request)).not.toBeNull();
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

  expect(first).toStrictEqual({
    kind: 'claimed',
    code: {
      clientID: 'c1',
      clientName: 'dots',
      redirectURI: 'https://dots.example/cb',
      codeChallenge: 'challenge',
      scopes: ['read'],
      resource: 'https://atc.example/mcp',
      expiresAt: 61_000,
    },
  });

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
