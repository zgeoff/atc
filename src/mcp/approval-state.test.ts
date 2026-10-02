import { expect, test } from 'bun:test';
import { ApprovalState } from './approval-state';

test('it approves a pending request with its code typed in any case and with a dash', () => {
  const state = new ApprovalState(600_000, () => 1000);

  const approval = state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  if (approval === null) {
    throw new Error('the approval was refused');
  }

  const typed = `${approval.approvalCode.slice(0, 4)}-${approval.approvalCode.slice(4)}`;

  expect(state.verifyApprovalCode('q1', typed.toLowerCase())).toBe('ok');
  expect(state.findPending('q1')).toBeNull();
});

test('it drops a pending request after the fifth wrong code', () => {
  const state = new ApprovalState(600_000, () => 1000);

  const approval = state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  if (approval === null) {
    throw new Error('the approval was refused');
  }

  const results = [1, 2, 3, 4, 5].map(() => state.verifyApprovalCode('q1', 'WRONG000'));

  expect(results).toStrictEqual(['wrong', 'wrong', 'wrong', 'wrong', 'locked']);
  expect(state.verifyApprovalCode('q1', approval.approvalCode)).toBe('locked');
});

test('it forgets a pending request once it expires', () => {
  let now = 1000;

  const state = new ApprovalState(600_000, () => now);

  state.createPending({
    key: 'q1',
    clientID: 'c1',
    clientName: 'dots',
    redirectURI: 'https://dots.example/cb',
  });

  now = 601_000;

  expect(state.findPending('q1')).toBeNull();
});

test("it drops a client's oldest waiting approval when it starts a fourth", () => {
  const state = new ApprovalState(600_000, () => 1000);

  const created = ['q1', 'q2', 'q3', 'q4'].map((key) =>
    state.createPending({
      key,
      clientID: 'c1',
      clientName: 'dots',
      redirectURI: 'https://dots.example/cb',
    }),
  );

  const found = ['q1', 'q2', 'q3', 'q4'].map((key) => state.findPending(key));

  expect(found).toStrictEqual(created.with(0, null));
});

test('it drops the oldest waiting approval to make room for a seventeenth', () => {
  let now = 1000;

  const state = new ApprovalState(600_000, () => now);

  const created = Array.from({ length: 17 }, (_, index) => {
    now = 1000 + index * 7000;

    return state.createPending({
      key: `q${index}`,
      clientID: `c${index}`,
      clientName: `c${index}`,
      redirectURI: 'https://dots.example/cb',
    });
  });

  const found = Array.from({ length: 17 }, (_, index) => state.findPending(`q${index}`));

  expect(found).toStrictEqual(created.with(0, null));
});

test('it refuses an eleventh approval started within a minute', () => {
  const state = new ApprovalState(600_000, () => 1000);

  const created = Array.from({ length: 11 }, (_, index) =>
    state.createPending({
      key: `q${index}`,
      clientID: `c${index}`,
      clientName: `c${index}`,
      redirectURI: 'https://dots.example/cb',
    }),
  );

  expect(created.slice(0, 10)).toSatisfyAll((approval) => approval !== null);
  expect(created[10]).toBeNull();
});

test('it starts approvals again a minute after the limit was reached', () => {
  let now = 1000;

  const state = new ApprovalState(600_000, () => now);

  Array.from({ length: 10 }, (_, index) =>
    state.createPending({
      key: `q${index}`,
      clientID: `c${index}`,
      clientName: `c${index}`,
      redirectURI: 'https://dots.example/cb',
    }),
  );

  now = 1000 + 60_000;

  expect(
    state.createPending({
      key: 'q10',
      clientID: 'c10',
      clientName: 'c10',
      redirectURI: 'https://dots.example/cb',
    }),
  ).not.toBeNull();
});
