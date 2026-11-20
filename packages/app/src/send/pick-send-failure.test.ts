import { expect, test } from 'bun:test';
import { AtcError } from '@atcx/contract/light';
import { pickSendFailure } from './pick-send-failure';

test.each([
  {
    title: 'no_such_session on a send',
    code: 'no_such_session',
    stage: 'send',
    exit: 3,
    as: 'no_such_session',
  },
  {
    title: 'outcome_unknown on a local send',
    code: 'outcome_unknown',
    stage: 'send',
    exit: 5,
    as: 'outcome_unknown',
  },
  {
    title: 'outcome_unknown on a remote send',
    code: 'outcome_unknown',
    stage: 'send',
    remote: true,
    exit: 6,
    as: 'outcome_unknown',
  },
  {
    title: 'idempotency_conflict',
    code: 'idempotency_conflict',
    stage: 'send',
    exit: 6,
    as: 'idempotency_conflict',
  },
  {
    title: 'internal on a closed connection',
    code: 'internal',
    stage: 'send',
    closed: true,
    exit: 4,
    as: 'unreachable',
  },
  {
    title: 'internal on an open connection',
    code: 'internal',
    stage: 'send',
    exit: 1,
    as: 'internal',
  },
  { title: 'session_dead', code: 'session_dead', stage: 'send', exit: 1, as: 'session_dead' },
  { title: 'unsupported', code: 'unsupported', stage: 'send', exit: 1, as: 'unsupported' },
  { title: 'unauthorized', code: 'unauthorized', stage: 'send', exit: 1, as: 'unauthorized' },
  { title: 'bad_args on a send', code: 'bad_args', stage: 'send', exit: 1, as: 'bad_args' },
  {
    title: 'bad_args on the read that settles a local send',
    code: 'bad_args',
    stage: 'recover',
    exit: 5,
    as: 'outcome_unknown',
  },
  {
    title: 'bad_args on the read that settles a remote send',
    code: 'bad_args',
    stage: 'recover',
    remote: true,
    exit: 6,
    as: 'outcome_unknown',
  },
  {
    title: 'another refusal of the read that settles a send',
    code: 'unauthorized',
    stage: 'recover',
    exit: 6,
    as: 'outcome_unknown',
  },
  { title: 'bad_args during the wait', code: 'bad_args', stage: 'wait', exit: 1, as: 'bad_args' },
  {
    title: 'internal on a closed connection during the wait',
    code: 'internal',
    stage: 'wait',
    closed: true,
    exit: 4,
    as: 'unreachable',
  },
  {
    title: 'an error of the session list',
    code: 'unauthorized',
    stage: 'list',
    exit: 1,
    as: 'unauthorized',
  },
] as const)('it ends exit $exit as $as for $title', (row) => {
  const picked = pickSendFailure(new AtcError(row.code, 'refused'), {
    stage: row.stage,
    closed: 'closed' in row,
    remote: 'remote' in row,
  });

  expect(picked).toStrictEqual({
    kind: 'ended',
    exitCode: row.exit,
    error: { code: row.as, message: expect.toInclude('refused') },
  });
});

test.each([{ code: 'outcome_unknown' }, { code: 'internal' }] as const)(
  'it asks to read the message of the effectRef of a $code send',
  (row) => {
    const picked = pickSendFailure(new AtcError(row.code, 'refused', { effectRef: 'm-9' }), {
      stage: 'send',
      closed: false,
      remote: false,
    });

    expect(picked).toStrictEqual({ kind: 'recover', effectRef: 'm-9' });
  },
);

test('it treats an error that is no daemon error as an internal error', () => {
  const picked = pickSendFailure(new Error('boom'), {
    stage: 'send',
    closed: false,
    remote: false,
  });

  expect(picked).toStrictEqual({
    kind: 'ended',
    exitCode: 1,
    error: { code: 'internal', message: expect.toInclude('boom') },
  });
});
