import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { parseRequestParams } from './parse-request-params';

test.each([
  ['daemon.hello', { client: 'atc/1.0' }, { client: 'atc/1.0' }],
  ['daemon.ping', {}, {}],
  ['daemon.quit', {}, {}],
  ['session.list', {}, {}],
  ['dirs.list', {}, {}],
  ['fleet.list', {}, {}],
  ['fleet.restore', { cols: 100, rows: 30 }, { cols: 100, rows: 30 }],
  [
    'session.spawn',
    { cwd: '/tmp', name: 'n', prompt: 'p', cols: 100, rows: 30, resume: 'abc', agent: 'grok' },
    { cwd: '/tmp', name: 'n', prompt: 'p', cols: 100, rows: 30, resume: 'abc', agent: 'grok' },
  ],
  ['session.kill', { session: 's1' }, { session: toSessionID('s1') }],
  ['session.ack', { session: 's1' }, { session: toSessionID('s1') }],
  [
    'session.update',
    { session: 's1', name: 'n', pinned: true },
    { session: toSessionID('s1'), name: 'n', pinned: true },
  ],
  [
    'session.attach',
    { session: 's1', cols: 100, rows: 30 },
    { session: toSessionID('s1'), cols: 100, rows: 30 },
  ],
  ['session.detach', { session: 's1' }, { session: toSessionID('s1') }],
  ['session.input', { session: 's1', d: 'x' }, { session: toSessionID('s1'), d: 'x' }],
  [
    'session.resize',
    { session: 's1', cols: 100, rows: 30 },
    { session: toSessionID('s1'), cols: 100, rows: 30 },
  ],
  ['session.resumeCommand', { session: 's1' }, { session: toSessionID('s1') }],
  [
    'session.eject',
    { session: 's1', prompt: 'keep going' },
    { session: toSessionID('s1'), prompt: 'keep going' },
  ],
  [
    'session.adopt',
    { session: 's1', cols: 100, rows: 30 },
    { session: toSessionID('s1'), cols: 100, rows: 30 },
  ],
  [
    'permission.respond',
    { request: 'r1', decision: 'allow' },
    { request: 'r1', decision: 'allow' },
  ],
] as const)('it parses a valid %s payload', (method, payload, expected) => {
  const parsed = parseRequestParams(method, payload);

  expect(parsed).toStrictEqual({ ok: true, data: expected });
});

test('it rejects session.spawn missing cwd as bad_args with a cwd-specific message', () => {
  const parsed = parseRequestParams('session.spawn', {});

  expect(parsed).toStrictEqual({ ok: false, message: 'session.spawn requires a cwd' });
});

test('it rejects session.spawn with a non-string cwd the same as a missing one', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: 42 });

  expect(parsed).toStrictEqual({ ok: false, message: 'session.spawn requires a cwd' });
});

test('it rejects session.spawn with an empty agent id', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/tmp', agent: '' });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'session.spawn agent must be a non-empty agent id',
  });
});

test('it accepts session.spawn with agent omitted', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/tmp' });

  expect(parsed.ok).toBeTrue();
  expect(parsed.ok && parsed.data.agent).toBeUndefined();
});

test('it rejects session.resize with cols below 1 as bad_args', () => {
  const parsed = parseRequestParams('session.resize', { session: 's1', cols: 0, rows: 5 });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'session.resize requires positive cols and rows',
  });
});

test('it rejects session.resize with rows below 1 as bad_args', () => {
  const parsed = parseRequestParams('session.resize', { session: 's1', cols: 5, rows: 0 });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'session.resize requires positive cols and rows',
  });
});

test('it rejects permission.respond missing a decision as bad_args', () => {
  const parsed = parseRequestParams('permission.respond', { request: 'r1' });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'permission.respond requires a request and a decision',
  });
});

test('it defaults session.spawn cols, rows, name, prompt, and resume', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/tmp' });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { cwd: '/tmp', name: '', prompt: '', cols: 80, rows: 24, resume: false },
  });
});

test('it drops an empty session.spawn parent instead of branding it', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/tmp', parent: '' });

  if (!parsed.ok) {
    throw new Error(parsed.message);
  }

  expect(parsed.data.parent).toBeUndefined();
});

test('it carries a session.spawn parent through as a session id', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/tmp', parent: 's-1' });

  expect(parsed).toMatchObject({ ok: true, data: { parent: 's-1' } });
});

test('it defaults session.attach cols and rows to 80 and 24', () => {
  const parsed = parseRequestParams('session.attach', { session: 's1' });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { session: toSessionID('s1'), cols: 80, rows: 24 },
  });
});

test('it defaults session.adopt cols and rows to 80 and 24', () => {
  const parsed = parseRequestParams('session.adopt', { session: 's1' });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { session: toSessionID('s1'), cols: 80, rows: 24 },
  });
});

test('it defaults fleet.restore cols and rows to 80 and 24', () => {
  const parsed = parseRequestParams('fleet.restore', {});

  expect(parsed).toStrictEqual({ ok: true, data: { cols: 80, rows: 24 } });
});

test('it defaults the eject prompt to the standalone-continue instruction', () => {
  const parsed = parseRequestParams('session.eject', { session: 's1' });

  expect(parsed).toStrictEqual({
    ok: true,
    data: {
      session: toSessionID('s1'),
      prompt:
        'Continue the task autonomously. Verify your work as you go and stop when it is complete.',
    },
  });
});

test('it falls back to the default eject prompt when the prompt is an empty string', () => {
  const parsed = parseRequestParams('session.eject', { session: 's1', prompt: '' });

  expect(parsed.ok).toBeTrue();

  expect(parsed.ok && parsed.data.prompt).toBe(
    'Continue the task autonomously. Verify your work as you go and stop when it is complete.',
  );
});

test('it leaves session.update name and pinned undefined when omitted', () => {
  const parsed = parseRequestParams('session.update', { session: 's1' });

  expect(parsed.ok).toBeTrue();
  expect(parsed.ok && parsed.data.name).toBeUndefined();
  expect(parsed.ok && parsed.data.pinned).toBeUndefined();
});

test('it tolerates a wrong-typed optional field by falling back to its default', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/tmp', cols: 'wide', rows: null });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { cwd: '/tmp', name: '', prompt: '', cols: 80, rows: 24, resume: false },
  });
});

test('it treats missing params as an empty object', () => {
  expect(parseRequestParams('daemon.ping', undefined)).toStrictEqual({ ok: true, data: {} });
});
