import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config';
import { GrokAdapter } from './grok-adapter';
import type { HookEvent } from './hooks';

function setupGrokHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-grok-home-'));
  const prev = process.env['GROK_HOME'];

  process.env['GROK_HOME'] = dir;

  onTestFinished(() => {
    if (prev === undefined) {
      delete process.env['GROK_HOME'];
    } else {
      process.env['GROK_HOME'] = prev;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

function buildGrokConfig(): Config {
  return {
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    leader: { code: 0, label: '^Space' },
  };
}

function buildGrokHook(event: string, payload: Readonly<Record<string, unknown>>): HookEvent {
  return { atcId: 's1', event, payload };
}

test('it plans a new spawn without resume or -p and appends --no-leader', () => {
  const plan = new GrokAdapter(buildGrokConfig()).planSpawn({
    prompt: 'fix the bug',
    resume: false,
  });

  expect(plan).toStrictEqual({
    bin: 'grok',
    args: ['--no-leader', 'fix the bug'],
  });

  expect(plan.args).not.toInclude('-p');
  expect(plan.args).not.toInclude('--single');
});

test('it plans adopt without --resume', () => {
  const plan = new GrokAdapter(buildGrokConfig()).planSpawn({ prompt: '', resume: true });

  expect(plan.args).toStrictEqual(['--no-leader']);
});

test('it plans restore with --resume after --no-leader', () => {
  const plan = new GrokAdapter(buildGrokConfig()).planSpawn({
    prompt: '',
    resume: '01a0148d-f30c-7091-9bbf-548c4a7ed49e',
  });

  expect(plan.args).toStrictEqual([
    '--no-leader',
    '--resume',
    '01a0148d-f30c-7091-9bbf-548c4a7ed49e',
  ]);
});

test('it drops a user --leader from grokArgs and still appends --no-leader', () => {
  setupGrokHome();

  const plan = new GrokAdapter({
    ...buildGrokConfig(),
    grokArgs: ['--leader', '--yolo'],
    codexBin: 'codex',
    codexArgs: [],
  }).planSpawn({ prompt: '', resume: false });

  expect(plan.args).toStrictEqual(['--yolo', '--no-leader']);
});

test('it yanks a captured id as grok --resume and an uncaptured session as grok', () => {
  const adapter = new GrokAdapter(buildGrokConfig());

  expect(adapter.buildResumeCommand("/tmp/o'reilly", 'sess-9')).toBe(
    String.raw`cd '/tmp/o'\''reilly' && grok --resume sess-9`,
  );

  expect(adapter.buildResumeCommand('/tmp/proj', undefined)).toBe("cd '/tmp/proj' && grok");
});

test('it maps permission_prompt to needs-input', () => {
  const ev = new GrokAdapter(buildGrokConfig()).normalizeHook(
    buildGrokHook('Notification', {
      sessionId: 'g1',
      notificationType: 'permission_prompt',
      message: 'allow edit?',
    }),
  );

  expect(ev).toStrictEqual({
    kind: 'needs-input',
    agentSessionID: 'g1',
    message: 'allow edit?',
    detail: 'allow edit?',
  });
});

test('it maps end-turn Stop, StopCancelled, and StopFailure to turn-done', () => {
  const adapter = new GrokAdapter(buildGrokConfig());

  expect(
    adapter.normalizeHook(
      buildGrokHook('Stop', { sessionId: 'g1', cwd: '/tmp', reason: 'end_turn' }),
    ).kind,
  ).toBe('turn-done');

  expect(
    adapter.normalizeHook(
      buildGrokHook('StopCancelled', { sessionId: 'g1', reason: 'user_interrupt' }),
    ).kind,
  ).toBe('turn-done');

  expect(
    adapter.normalizeHook(buildGrokHook('StopFailure', { sessionId: 'g1', error: 'rate_limit' }))
      .kind,
  ).toBe('turn-done');
});

test('it ignores session-end Stop and any event with a subagent type', () => {
  const adapter = new GrokAdapter(buildGrokConfig());

  expect(
    adapter.normalizeHook(buildGrokHook('Stop', { sessionId: 'g1', reason: 'channel_closed' }))
      .kind,
  ).toBe('heartbeat');

  expect(
    adapter.normalizeHook(buildGrokHook('Stop', { sessionId: 'g1', reason: 'shutdown' })).kind,
  ).toBe('heartbeat');

  expect(
    adapter.normalizeHook(
      buildGrokHook('Stop', { sessionId: 'g1', reason: 'end_turn', subagentType: 'explore' }),
    ).kind,
  ).toBe('heartbeat');
});

test('it ignores a stale promptId after a later submit', () => {
  const adapter = new GrokAdapter(buildGrokConfig());

  adapter.normalizeHook(
    buildGrokHook('UserPromptSubmit', { sessionId: 'g1', promptId: 'p2', prompt: 'next' }),
  );

  expect(
    adapter.normalizeHook(
      buildGrokHook('Stop', { sessionId: 'g1', reason: 'end_turn', promptId: 'p1' }),
    ).kind,
  ).toBe('heartbeat');
});

test('it treats idle_prompt after needs-input as a heartbeat', () => {
  const adapter = new GrokAdapter(buildGrokConfig());

  adapter.normalizeHook(
    buildGrokHook('Notification', { sessionId: 'g1', notificationType: 'permission_prompt' }),
  );

  expect(
    adapter.normalizeHook(
      buildGrokHook('Notification', { sessionId: 'g1', notificationType: 'idle_prompt' }),
    ).kind,
  ).toBe('heartbeat');
});

test('it treats idle_prompt after a submitted prompt as turn-done', () => {
  const adapter = new GrokAdapter(buildGrokConfig());

  adapter.normalizeHook(
    buildGrokHook('UserPromptSubmit', { sessionId: 'g1', promptId: 'p1', prompt: 'go' }),
  );

  expect(
    adapter.normalizeHook(
      buildGrokHook('Notification', {
        sessionId: 'g1',
        cwd: '/tmp',
        notificationType: 'idle_prompt',
      }),
    ).kind,
  ).toBe('turn-done');
});

test('it captures SessionStart without a transcript path', () => {
  setupGrokHome();

  const ev = new GrokAdapter(buildGrokConfig()).normalizeHook(
    buildGrokHook('SessionStart', { sessionId: 'g1', cwd: '/tmp/proj' }),
  );

  expect(ev.kind).toBe('started');
  expect(ev.agentSessionID).toBe('g1');
  expect(ev.transcriptSource).toBeUndefined();

  expect(ev.nameSource).toEndWith(
    join('sessions', encodeURIComponent('/tmp/proj'), 'g1', 'summary.json'),
  );
});

test('it loads a manual title over a user-typed name', async () => {
  const home = setupGrokHome();
  const file = join(home, 'summary.json');

  writeFileSync(
    file,
    JSON.stringify({
      title_is_manual: true,
      generated_title: 'renamed in grok',
      session_summary: 'auto blurb',
    }),
  );

  const update = await new GrokAdapter(buildGrokConfig()).loadName(file, 'user');

  expect(update).toStrictEqual({ name: 'renamed in grok', namedBy: 'agent' });
});

test('it loads an auto title only when the session was not user-named', async () => {
  const home = setupGrokHome();
  const file = join(home, 'summary.json');

  writeFileSync(
    file,
    JSON.stringify({ generated_title: 'auto title', session_summary: 'auto blurb' }),
  );

  const adapter = new GrokAdapter(buildGrokConfig());

  const auto = await adapter.loadName(file, 'auto');
  const user = await adapter.loadName(file, 'user');

  expect(auto).toStrictEqual({ name: 'auto title' });
  expect(user).toBeNull();
});

test('it resumes when a session id was captured and not from a summary path', () => {
  const adapter = new GrokAdapter(buildGrokConfig());

  expect(adapter.canResume({ agentSessionID: 'g1' })).toBe(true);

  expect(
    adapter.canResume({ agentSessionID: 'g1', transcriptSource: '/missing/summary.json' }),
  ).toBe(true);

  expect(adapter.canResume({})).toBe(false);
});
