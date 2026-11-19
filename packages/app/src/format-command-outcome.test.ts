import { expect, test } from 'bun:test';
import { formatCommandOutcome } from './format-command-outcome';
import type { CommandOutcome } from './send-types';

test.each([
  {
    title: '0, answered',
    outcome: {
      exitCode: 0,
      key: 'k-1',
      session: 's-1',
      message: 'm-1',
      progress: { status: 'answered', answer: 'yes' },
      view: {
        message: 'm-1',
        session: 's-1',
        from: 'atc-send',
        text: 'hi',
        status: 'answered',
        sentAt: 1,
        answer: 'yes',
        turn: null,
        answeredWith: [],
      },
      error: null,
    },
    send: {
      plain: { stdout: 'yes', stderr: null },
      json: '{"key":"k-1","session":"s-1","message":"m-1","status":"answered","answer":"yes"}',
    },
    get: {
      plain: { stdout: 'answered\nyes', stderr: null },
      json: '{"message":"m-1","session":"s-1","from":"atc-send","text":"hi","status":"answered","sentAt":1,"answer":"yes","turn":null,"answeredWith":[]}',
    },
  },
  {
    title: '0, queued',
    outcome: {
      exitCode: 0,
      key: 'k-1',
      session: 's-1',
      message: 'm-1',
      progress: { status: 'queued' },
      view: null,
      error: null,
    },
    send: {
      plain: { stdout: 'm-1', stderr: null },
      json: '{"key":"k-1","session":"s-1","message":"m-1","status":"queued"}',
    },
    get: { plain: { stdout: 'queued', stderr: null }, json: '{"error":null}' },
  },
  {
    title: '7, unanswered',
    outcome: {
      exitCode: 7,
      key: 'k-1',
      session: 's-1',
      message: 'm-1',
      progress: { status: 'unanswered', unansweredReason: 'session_ended' },
      view: {
        message: 'm-1',
        session: 's-1',
        from: 'atc-send',
        text: 'hi',
        status: 'unanswered',
        sentAt: 1,
        unansweredReason: 'session_ended',
        turn: null,
        answeredWith: [],
      },
      error: { code: 'unanswered', message: 'session_ended' },
    },
    send: {
      plain: { stdout: null, stderr: 'atc send: unanswered: session_ended (key k-1, message m-1)' },
      json: '{"key":"k-1","session":"s-1","message":"m-1","status":"unanswered","unansweredReason":"session_ended"}',
    },
    get: {
      plain: {
        stdout: 'unanswered',
        stderr: 'atc message get: unanswered: session_ended (key k-1, message m-1)',
      },
      json: '{"message":"m-1","session":"s-1","from":"atc-send","text":"hi","status":"unanswered","sentAt":1,"unansweredReason":"session_ended","turn":null,"answeredWith":[]}',
    },
  },
  {
    title: '8, wait_timeout',
    outcome: {
      exitCode: 8,
      key: 'k-1',
      session: 's-1',
      message: 'm-1',
      progress: { status: 'delivered' },
      view: {
        message: 'm-1',
        session: 's-1',
        from: 'atc-send',
        text: 'hi',
        status: 'delivered',
        sentAt: 1,
        turn: null,
        answeredWith: [],
      },
      error: { code: 'wait_timeout', message: 'still delivered' },
    },
    send: {
      plain: {
        stdout: 'm-1',
        stderr: 'atc send: wait_timeout: still delivered (key k-1, message m-1)',
      },
      json: '{"key":"k-1","session":"s-1","message":"m-1","status":"delivered"}',
    },
    get: {
      plain: {
        stdout: 'delivered',
        stderr: 'atc message get: wait_timeout: still delivered (key k-1, message m-1)',
      },
      json: '{"message":"m-1","session":"s-1","from":"atc-send","text":"hi","status":"delivered","sentAt":1,"turn":null,"answeredWith":[]}',
    },
  },
  {
    title: '3, no_such_session',
    outcome: {
      exitCode: 3,
      key: 'k-1',
      session: null,
      message: null,
      progress: null,
      view: null,
      error: { code: 'no_such_session', message: 'no session' },
    },
    send: {
      plain: { stdout: null, stderr: 'atc send: no_such_session: no session (key k-1)' },
      json: '{"key":"k-1","error":{"code":"no_such_session","message":"no session"}}',
    },
    get: {
      plain: { stdout: null, stderr: 'atc message get: no_such_session: no session (key k-1)' },
      json: '{"error":{"code":"no_such_session","message":"no session"}}',
    },
  },
  {
    title: '1, session_dead with the adopt hint',
    outcome: {
      exitCode: 1,
      key: 'k-1',
      session: 's-1',
      message: null,
      progress: null,
      view: null,
      error: { code: 'session_dead', message: 'no live process' },
    },
    send: {
      plain: {
        stdout: null,
        stderr:
          'atc send: session_dead: no live process; start it with: atc session adopt s-1 (key k-1)',
      },
      json: '{"key":"k-1","error":{"code":"session_dead","message":"no live process"}}',
    },
    get: {
      plain: {
        stdout: null,
        stderr:
          'atc message get: session_dead: no live process; start it with: atc session adopt s-1 (key k-1)',
      },
      json: '{"error":{"code":"session_dead","message":"no live process"}}',
    },
  },
  {
    title: '6, outcome_unknown with the message id',
    outcome: {
      exitCode: 6,
      key: 'k-1',
      session: 's-1',
      message: 'm-9',
      progress: null,
      view: null,
      error: { code: 'outcome_unknown', message: 'unknown' },
    },
    send: {
      plain: { stdout: null, stderr: 'atc send: outcome_unknown: unknown (key k-1, message m-9)' },
      json: '{"key":"k-1","message":"m-9","error":{"code":"outcome_unknown","message":"unknown"}}',
    },
    get: {
      plain: {
        stdout: null,
        stderr: 'atc message get: outcome_unknown: unknown (key k-1, message m-9)',
      },
      json: '{"error":{"code":"outcome_unknown","message":"unknown"}}',
    },
  },
] as const satisfies readonly {
  title: string;
  outcome: CommandOutcome;
  send: unknown;
  get: unknown;
}[])('it formats an outcome of exit $title as plain text and as JSON', (row) => {
  const formatted = {
    sendPlain: formatCommandOutcome(row.outcome, { command: 'send', json: false }),
    sendJSON: formatCommandOutcome(row.outcome, { command: 'send', json: true }),
    getPlain: formatCommandOutcome(row.outcome, { command: 'message get', json: false }),
    getJSON: formatCommandOutcome(row.outcome, { command: 'message get', json: true }),
  };

  expect(formatted).toStrictEqual({
    sendPlain: row.send.plain,
    sendJSON: { stdout: row.send.json, stderr: null },
    getPlain: row.get.plain,
    getJSON: { stdout: row.get.json, stderr: null },
  });
});
