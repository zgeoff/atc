import { expect, test } from 'bun:test';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { parseRequestParams } from './parse-request-params';

test.each([
  ['daemon.hello', { client: 'atc/1.0' }],
  ['daemon.ping', {}],
  ['daemon.quit', {}],
  ['session.list', {}],
  ['dirs.list', {}],
  ['fleet.list', {}],
  ['fleet.restore', { cols: 100, rows: 30 }],
  [
    'session.spawn',
    { cwd: '/tmp', name: 'n', prompt: 'p', cols: 100, rows: 30, resume: 'abc', agent: 'grok' },
  ],
  ['session.kill', { session: 's1' }],
  ['session.ack', { session: 's1' }],
  ['session.update', { session: 's1', name: 'n', pinned: true }],
  ['session.attach', { session: 's1', cols: 100, rows: 30 }],
  ['session.detach', { session: 's1' }],
  ['session.input', { session: 's1', d: 'x' }],
  ['session.submit', { session: 's1', text: 'x' }],
  ['note.get', { note: 'r1' }],
  ['session.resize', { session: 's1', cols: 100, rows: 30 }],
  ['session.resumeCommand', { session: 's1' }],
  ['session.eject', { session: 's1', prompt: 'keep going' }],
  ['session.adopt', { session: 's1', cols: 100, rows: 30 }],
  ['permission.respond', { request: 'r1', decision: 'allow' }],
  ['session.get', { session: 's1' }],
  ['session.read', { session: 's1', cursor: 'c', limit: 10 }],
  ['events.read', { cursor: 'c', limit: 10, waitMs: 500 }],
  ['sources.list', { source: 'github', target: 'box', scope: 'zgeoff' }],
  ['sources.list', { source: 'dirs' }],
  ['sources.interpret', { source: 'github', input: 'zgeoff/', target: 'box' }],
  ['git.probe', { url: 'zgeoff/atc', ref: 'main', target: 'box' }],
] as const)('it parses the valid %s payload %j as it is', (method, payload) => {
  // Each row's expected data is its own payload, which carries plain
  // strings where the parse result holds branded ids.
  const parsed: unknown = parseRequestParams(method, payload);

  expect(parsed).toStrictEqual({ ok: true, data: payload });
});

test('it parses session.spawn without a cwd for a git workspace to pick the directory of', () => {
  const parsed = parseRequestParams('session.spawn', {
    workspace: { kind: 'git', url: 'https://example.com/r.git', ref: 'main' },
  });

  expect(parsed).toStrictEqual({
    ok: true,
    data: {
      name: '',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      workspace: { kind: 'git', url: 'https://example.com/r.git', ref: 'main' },
    },
  });
});

test('it rejects session.spawn with an empty cwd with a cwd-specific message', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '' });

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

test('it rejects session.resize with cols below 1', () => {
  const parsed = parseRequestParams('session.resize', {
    session: 's1',
    cols: 0,
    rows: 5,
  });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'cols and rows must be whole numbers from 1 to 4096',
  });
});

test('it rejects session.resize with rows below 1', () => {
  const parsed = parseRequestParams('session.resize', {
    session: 's1',
    cols: 5,
    rows: 0,
  });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'cols and rows must be whole numbers from 1 to 4096',
  });
});

test('it rejects permission.respond missing a decision', () => {
  const parsed = parseRequestParams('permission.respond', { request: 'r1' });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'permission.respond requires a request and a decision',
  });
});

test('it defaults session.spawn cols, rows, name, prompt, and resume and leaves agent unset', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/tmp' });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { cwd: '/tmp', name: '', prompt: '', cols: 80, rows: 24, resume: false },
  });
});

test('it drops an empty session.spawn parent instead of branding it', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/tmp', parent: '' });

  expect(parsed).toStrictEqual({
    ok: true,
    data: {
      cwd: '/tmp',
      name: '',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      parent: undefined,
    },
  });
});

test('it carries a session.spawn parent through as a session id', () => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/tmp', parent: 's-1' });

  expect(parsed).toStrictEqual({
    ok: true,
    data: {
      cwd: '/tmp',
      name: '',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      parent: toSessionID('s-1'),
    },
  });
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

  expect(parsed).toStrictEqual({
    ok: true,
    data: {
      session: toSessionID('s1'),
      prompt:
        'Continue the task autonomously. Verify your work as you go and stop when it is complete.',
    },
  });
});

test('it leaves session.update name and pinned undefined when omitted', () => {
  const parsed = parseRequestParams('session.update', { session: 's1' });

  expect(parsed).toStrictEqual({ ok: true, data: { session: toSessionID('s1') } });
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

  expect(parsed).toStrictEqual({ ok: true, data: { limit: 50, waitMs: 0, session: undefined } });
});

test('it clamps session.read limit to 200', () => {
  const parsed = parseRequestParams('session.read', { session: 's1', limit: 999 });

  expect(parsed).toStrictEqual({ ok: true, data: { session: toSessionID('s1'), limit: 200 } });
});

test('it rejects session.message without text', () => {
  const parsed = parseRequestParams('session.message', {
    session: 's1',
    from: 'alice',
  });

  expect(parsed).toStrictEqual({ ok: false, message: 'session.message requires text' });
});

test('it defaults session.message from to unknown', () => {
  const parsed = parseRequestParams('session.message', {
    session: 's1',
    text: 'hi',
    from: '',
  });

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

test('it rejects note.get without a note', () => {
  const parsed = parseRequestParams('note.get', {});

  expect(parsed).toStrictEqual({ ok: false, message: 'note.get requires a note' });
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
] as const)(
  'it rejects %s params %j whose terminal size is not a whole number from 1 to 4096',
  (method, params) => {
    const parsed = parseRequestParams(method, params);

    expect(parsed).toStrictEqual({
      ok: false,
      message: 'cols and rows must be whole numbers from 1 to 4096',
    });
  },
);

test('it rejects session.adopt with rows that are not a number', () => {
  const parsed = parseRequestParams('session.adopt', {
    session: 's1',
    cols: 80,
    rows: Number.NaN,
  });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'cols and rows must be whole numbers from 1 to 4096',
  });
});

test('it rejects session.resize with fractional rows', () => {
  const parsed = parseRequestParams('session.resize', {
    session: 's1',
    cols: 80,
    rows: 24.5,
  });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'cols and rows must be whole numbers from 1 to 4096',
  });
});

test.each([
  { kind: 'path', path: '/src/repo', allowDirty: 'warn' },
  { kind: 'git', url: 'https://example.com/r.git', ref: 'main' },
  {
    kind: 'git',
    url: 'git@example.com:o/r.git',
    sha: 'a'.repeat(40),
    credentialRef: { kind: 'env', name: 'GIT_TOKEN' },
  },
  { kind: 'git', url: 'zgeoff/atc', ref: 'main', sha: 'a'.repeat(40) },
] as const)('it carries the workspace %j through as the session.spawn workspace', (workspace) => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/w', workspace });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { cwd: '/w', name: '', prompt: '', cols: 80, rows: 24, resume: false, workspace },
  });
});

test.each([
  [{ kind: 'path', path: 'repo' }, 'a path workspace requires an absolute path'],
  [{ kind: 'path' }, 'a path workspace requires an absolute path'],
  [{ kind: 'git', url: '/r.git' }, 'a git workspace takes a ref, a sha, or both'],
  [{ kind: 'git', url: '/r.git', sha: 'abc1234' }, 'a git workspace sha is a full commit id'],
  [
    { kind: 'git', url: '--upload-pack=x', ref: 'main' },
    'a git workspace url must not start with -',
  ],
  [{ kind: 'git', url: '/r.git', ref: '' }, 'a git workspace ref must not be empty'],
  [{ kind: 'git', url: '/r.git', ref: '-x' }, 'a git workspace ref must not start with -'],
  [
    { kind: 'git', url: '/r.git', ref: 'main', credentialRef: { kind: 'env', name: 'A B' } },
    'a credentialRef names an environment variable',
  ],
] as const)(
  'it rejects the session.spawn workspace %j with the message %s',
  (workspace, message) => {
    const parsed = parseRequestParams('session.spawn', { cwd: '/w', workspace });

    expect(parsed).toStrictEqual({ ok: false, message });
  },
);

test.each([
  [{}, 'source must be a source id'],
  [{ source: '' }, 'source must be a source id'],
  [{ source: 'github', scope: '' }, 'scope must be non-empty'],
  [{ source: 'github', target: '' }, 'target must be a non-empty target id'],
] as const)('it rejects sources.list params %j with the message %s', (params, message) => {
  const parsed = parseRequestParams('sources.list', params);

  expect(parsed).toStrictEqual({ ok: false, message });
});

test('it rejects a sources.list source id over 64 characters', () => {
  const parsed = parseRequestParams('sources.list', { source: 'x'.repeat(65) });

  expect(parsed).toStrictEqual({ ok: false, message: 'source must be a source id' });
});

test('it rejects sources.interpret without an input', () => {
  const parsed = parseRequestParams('sources.interpret', { source: 'github' });

  expect(parsed).toStrictEqual({ ok: false, message: 'source text must be a string' });
});

test('it rejects sources.interpret with an input over 4096 characters', () => {
  const parsed = parseRequestParams('sources.interpret', {
    source: 'github',
    input: 'a'.repeat(4097),
  });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'source text must be at most 4096 characters',
  });
});

test.each([
  [{}, 'a git workspace requires a url'],
  [{ url: '-u' }, 'a git workspace url must not start with -'],
  [
    { url: 'zgeoff/atc', ref: 'main', sha: 'a'.repeat(40) },
    'git.probe takes at most one of ref or sha',
  ],
  [{ url: 'zgeoff/atc', sha: 'abc1234' }, 'a git workspace sha is a full commit id'],
] as const)('it rejects git.probe params %j with the message %s', (params, message) => {
  const parsed = parseRequestParams('git.probe', params);

  expect(parsed).toStrictEqual({ ok: false, message });
});

test.each([true, false])(
  'it preserves the per-launch clone trust decision %s',
  (trustClonedWorkspace) => {
    const parsed = parseRequestParams('session.spawn', { cwd: '/w', trustClonedWorkspace });

    expect(parsed).toStrictEqual({
      ok: true,
      data: {
        cwd: '/w',
        name: '',
        prompt: '',
        cols: 80,
        rows: 24,
        resume: false,
        trustClonedWorkspace,
      },
    });
  },
);

test.each(['true', 1, null])('it rejects non-boolean clone trust %s', (trustClonedWorkspace) => {
  const parsed = parseRequestParams('session.spawn', { cwd: '/w', trustClonedWorkspace });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'session.spawn trustClonedWorkspace must be a boolean',
  });
});

test('it ignores a resumeInterruptedTurns param an older caller sends on session.spawn', () => {
  const parsed = parseRequestParams('session.spawn', {
    cwd: '/tmp',
    resumeInterruptedTurns: true,
  });

  expect(parsed).toStrictEqual({
    ok: true,
    data: { cwd: '/tmp', name: '', prompt: '', resume: false, cols: 80, rows: 24 },
  });
});

test.each([
  ['session.spawn', { cwd: '/tmp', idempotencyKey: 5 }, 'idempotencyKey must be a string'],
  ['session.spawn', { cwd: '/tmp', idempotencyKey: '' }, 'idempotencyKey must not be empty'],
  ['session.spawn', { cwd: '/tmp', replayOnly: 'yes' }, 'replayOnly must be a boolean'],
  ['session.spawn', { cwd: '/tmp', model: 5 }, 'session.spawn model must be a string'],
  ['session.spawn', { cwd: '/tmp', effort: 5 }, 'session.spawn effort must be a string'],
  [
    'session.spawn',
    { cwd: '/tmp', target: '' },
    'session.spawn target must be a non-empty target id',
  ],
  [
    'session.message',
    { session: 's1', text: 'hi', idempotencyKey: '' },
    'idempotencyKey must not be empty',
  ],
  ['session.message', { session: 's1', text: 'hi', replayOnly: 1 }, 'replayOnly must be a boolean'],
  [
    'daemon.hello',
    { client: 'atc/1.0', principal: '' },
    'daemon.hello principal must be a non-empty string',
  ],
  [
    'session.forget',
    { session: 's1', confirmToken: 5 },
    'session.forget confirmToken must be a string',
  ],
  [
    'session.forget',
    { session: 's1', confirmToken: '' },
    'session.forget confirmToken must not be empty',
  ],
  [
    'session.forget',
    { session: 's1', refusePinned: 'yes' },
    'session.forget refusePinned must be a boolean',
  ],
  [
    'session.forget',
    { session: 's1', refuseLive: 'yes' },
    'session.forget refuseLive must be a boolean',
  ],
  ['session.resize', { session: 's1', rows: 30 }, 'session.resize requires positive cols and rows'],
  [
    'session.resize',
    { session: 's1', cols: 100 },
    'session.resize requires positive cols and rows',
  ],
] as const)('it rejects %s params %j with the message %s', (method, params, message) => {
  const parsed = parseRequestParams(method, params);

  expect(parsed).toStrictEqual({ ok: false, message });
});

test('it rejects a session.spawn idempotencyKey over 200 characters', () => {
  const parsed = parseRequestParams('session.spawn', {
    cwd: '/tmp',
    idempotencyKey: 'k'.repeat(201),
  });

  expect(parsed).toStrictEqual({
    ok: false,
    message: 'idempotencyKey must be at most 200 characters',
  });
});
