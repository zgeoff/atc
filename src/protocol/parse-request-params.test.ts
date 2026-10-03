import { expect, test } from 'bun:test';
import { toMessageID } from '../shared/to-message-id';
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
  ['session.submit', { session: 's1', text: 'x' }, { session: toSessionID('s1'), text: 'x' }],
  ['report.get', { report: 'r1' }, { report: 'r1' }],
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
  ['session.get', { session: 's1' }, { session: toSessionID('s1') }],
  [
    'session.read',
    { session: 's1', cursor: 'c', limit: 10 },
    { session: toSessionID('s1'), cursor: 'c', limit: 10 },
  ],
  ['events.read', { cursor: 'c', limit: 10, waitMs: 500 }, { cursor: 'c', limit: 10, waitMs: 500 }],
  ['repos.list', { owner: 'zgeoff', target: 'box' }, { owner: 'zgeoff', target: 'box' }],
  ['repos.list', {}, {}],
  [
    'repos.probe',
    { url: 'zgeoff/atc', ref: 'main', target: 'box' },
    { url: 'zgeoff/atc', ref: 'main', target: 'box' },
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
    message: 'cols and rows must be whole numbers from 1 to 4096',
  });
});

test('it rejects session.resize with rows below 1 as bad_args', () => {
  const parsed = parseRequestParams('session.resize', { session: 's1', cols: 5, rows: 0 });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'cols and rows must be whole numbers from 1 to 4096',
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

test('it defaults events.read to 50 events with no wait', () => {
  const parsed = parseRequestParams('events.read', {});

  expect(parsed).toStrictEqual({ ok: true, data: { limit: 50, waitMs: 0 } });
});

test.each([
  [
    { limit: 1000, waitMs: 120_000 },
    { limit: 200, waitMs: 30_000 },
  ],
  [
    { limit: 0, waitMs: -5 },
    { limit: 1, waitMs: 0 },
  ],
] as const)('it clamps events.read %p into range', (payload, expected) => {
  expect(parseRequestParams('events.read', payload)).toStrictEqual({ ok: true, data: expected });
});

test('it carries an events.read session filter through as a session id', () => {
  const parsed = parseRequestParams('events.read', { session: 's1' });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { limit: 50, waitMs: 0, session: toSessionID('s1') },
  });
});

test('it reads an empty events.read session filter as the whole fleet', () => {
  const parsed = parseRequestParams('events.read', { session: '' });

  if (!parsed.ok) {
    throw new Error(parsed.message);
  }

  expect(parsed.data.session).toBeUndefined();
});

test('it clamps session.read limit to 200', () => {
  const parsed = parseRequestParams('session.read', { session: 's1', limit: 999 });

  expect(parsed).toStrictEqual({ ok: true, data: { session: toSessionID('s1'), limit: 200 } });
});

test('it rejects session.message without text', () => {
  const parsed = parseRequestParams('session.message', { session: 's1', from: 'alice' });

  expect(parsed).toStrictEqual({ ok: false, message: 'session.message requires text' });
});

test('it defaults session.message from to unknown', () => {
  const parsed = parseRequestParams('session.message', { session: 's1', text: 'hi', from: '' });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { session: toSessionID('s1'), from: 'unknown', text: 'hi' },
  });
});

test('it rejects message.ack without a message', () => {
  const parsed = parseRequestParams('message.ack', { session: 's1' });

  expect(parsed).toStrictEqual({ ok: false, message: 'message.ack requires a message' });
});

test('it rejects message.get without a message', () => {
  const parsed = parseRequestParams('message.get', {});

  expect(parsed).toStrictEqual({ ok: false, message: 'message.get requires a message' });
});

test('it rejects report.get without a report', () => {
  const parsed = parseRequestParams('report.get', {});

  expect(parsed).toStrictEqual({ ok: false, message: 'report.get requires a report' });
});

test('it parses message.get with a message id', () => {
  const parsed = parseRequestParams('message.get', { message: 'm-1' });

  expect(parsed).toStrictEqual({ ok: true, data: { message: toMessageID('m-1'), waitMs: 0 } });
});

test.each([
  [120_000, 30_000],
  [-5, 0],
  [1500.7, 1500],
] as const)('it clamps a message.get waitMs of %p to %p', (waitMs, expected) => {
  const parsed = parseRequestParams('message.get', { message: 'm-1', waitMs });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { message: toMessageID('m-1'), waitMs: expected },
  });
});

test.each([
  ['session.spawn', { cwd: '/tmp', cols: 80, rows: 24.5 }],
  ['session.spawn', { cwd: '/tmp', cols: 0, rows: 24 }],
  ['session.spawn', { cwd: '/tmp', cols: 80, rows: 5000 }],
  ['fleet.restore', { cols: 80.5, rows: 24 }],
  ['session.attach', { session: 's1', cols: 80, rows: -1 }],
  ['session.adopt', { session: 's1', cols: 80, rows: Number.NaN }],
] as const)(
  'it rejects %s with a terminal size outside whole numbers from 1 to 4096 as bad_args',
  (method, params) => {
    const parsed = parseRequestParams(method, params);

    expect(parsed).toStrictEqual({
      ok: false,
      message: 'cols and rows must be whole numbers from 1 to 4096',
    });
  },
);

test('it rejects session.resize with fractional rows as bad_args', () => {
  const parsed = parseRequestParams('session.resize', { session: 's1', cols: 80, rows: 24.5 });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'cols and rows must be whole numbers from 1 to 4096',
  });
});

test.each([
  ['a path source', { kind: 'path', path: '/src/repo', allowDirty: 'warn' }],
  ['a git source at a ref', { kind: 'git', url: 'https://example.com/r.git', ref: 'main' }],
  [
    'a git source at a commit with a credentialRef',
    {
      kind: 'git',
      url: 'git@example.com:o/r.git',
      sha: 'a'.repeat(40),
      credentialRef: { kind: 'env', name: 'GIT_TOKEN' },
    },
  ],
  [
    'a git source at a commit resolved from a ref',
    { kind: 'git', url: 'zgeoff/atc', ref: 'main', sha: 'a'.repeat(40) },
  ],
] as const)('it carries %s through as the session.spawn workspace', (_, workspace) => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/w', workspace });

  expect(parsed).toMatchObject({ ok: true, data: { workspace } });
});

test.each([
  ['a relative path', { kind: 'path', path: 'repo' }, 'a path workspace requires an absolute path'],
  [
    'a git source with neither ref nor sha',
    { kind: 'git', url: '/r.git' },
    'a git workspace takes a ref, a sha, or both',
  ],
  [
    'an abbreviated sha',
    { kind: 'git', url: '/r.git', sha: 'abc1234' },
    'a git workspace sha is a full commit id',
  ],
  [
    'a url that reads as an option',
    { kind: 'git', url: '--upload-pack=x', ref: 'main' },
    'a git workspace url must not start with -',
  ],
  [
    'a credentialRef that is not a variable name',
    { kind: 'git', url: '/r.git', ref: 'main', credentialRef: { kind: 'env', name: 'A B' } },
    'a credentialRef names an environment variable',
  ],
])('it rejects %s as the session.spawn workspace', (_, workspace, message) => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/w', workspace });

  expect(parsed).toStrictEqual({ ok: false, message });
});

test.each([
  [
    'an owner that reads as an option',
    { owner: '--hostname=evil' },
    'owner must be a GitHub account or organization',
  ],
  [
    'an owner with a slash',
    { owner: 'zgeoff/atc' },
    'owner must be a GitHub account or organization',
  ],
  ['an empty target', { target: '' }, 'target must be a non-empty target id'],
])('it rejects repos.list with %s', (_, params, message) => {
  const parsed = parseRequestParams('repos.list', params);

  expect(parsed).toStrictEqual({ ok: false, message });
});

test.each([
  ['no url', {}, 'a git workspace requires a url'],
  ['a url that reads as an option', { url: '-u' }, 'a git workspace url must not start with -'],
  [
    'both a ref and a sha',
    { url: 'zgeoff/atc', ref: 'main', sha: 'a'.repeat(40) },
    'repos.probe takes at most one of ref or sha',
  ],
  [
    'an abbreviated sha',
    { url: 'zgeoff/atc', sha: 'abc1234' },
    'a git workspace sha is a full commit id',
  ],
])('it rejects repos.probe with %s', (_, params, message) => {
  const parsed = parseRequestParams('repos.probe', params);

  expect(parsed).toStrictEqual({ ok: false, message });
});
