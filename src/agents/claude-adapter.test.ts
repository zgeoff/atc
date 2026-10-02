import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import type { Config } from '../shared/config';
import { toSessionID } from '../shared/to-session-id';
import { ClaudeAdapter } from './claude-adapter';

function buildClaudeConfig(): Config {
  return {
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    dirs: { roots: [] },
    gateways: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
  };
}

test('it resumes when no transcript was reported or the reported file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-claude-resume-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const transcript = join(dir, 'transcript.jsonl');

  writeFileSync(transcript, '');

  const adapter = new ClaudeAdapter(buildClaudeConfig());

  expect(adapter.canResume({})).toBe(true);
  expect(adapter.canResume({ transcriptSource: transcript })).toBe(true);
  expect(adapter.canResume({ transcriptSource: join(dir, 'missing.jsonl') })).toBe(false);
});

test('it maps a non-object hook payload to a bare heartbeat instead of throwing', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',

    // oxlint-disable-next-line no-unsafe-type-assertion -- exercising a payload shape the HookEvent type rules out but a hostile or buggy reporter could still send
    payload: 'garbage' as unknown as Record<string, unknown>,
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 42, transcript_path: null, last_assistant_message: ['pong'] },
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});

test('it carries the whole last assistant message of a finished turn as its result', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 'c-1', last_assistant_message: 'x'.repeat(700) },
  });

  expect(ev).toMatchObject({ kind: 'turn-done', result: 'x'.repeat(700) });
  expect(ev.detail).toHaveLength(600);
});

test('it takes inbox messages', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  expect(adapter.takesMessages).toBe(true);
});

test('it hands a headless run the folder of the atc-bridge mod', () => {
  using tmp = setupTempDir('atc-claude-bridge-');

  let received: Readonly<Record<string, unknown>> = {};

  const adapter = new ClaudeAdapter(
    buildClaudeConfig(),
    (opts) => {
      received = { ...opts };

      return { stop: () => {} };
    },
    join(tmp.dir, 'atc-bridge'),
  );

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(received).toMatchObject({ cwd: '/tmp', pluginDir: expect.toEndWith('atc-bridge') });
});

test('it advertises the documented model aliases and effort levels with the configured defaults', () => {
  const adapter = new ClaudeAdapter({
    ...buildClaudeConfig(),
    claudeArgs: ['--model', 'opus', '--effort=high'],
  });

  expect(adapter.profile.spawnOptions).toStrictEqual({
    model: {
      supported: true,
      values: null,
      examples: [
        { value: 'best', resolvesTo: null },
        { value: 'fable', resolvesTo: null },
        { value: 'opus', resolvesTo: null },
        { value: 'sonnet', resolvesTo: null },
        { value: 'haiku', resolvesTo: null },
        { value: 'opus[1m]', resolvesTo: null },
        { value: 'sonnet[1m]', resolvesTo: null },
        { value: 'opusplan', resolvesTo: null },
      ],
      default: 'opus',
      backendEffect: 'applied',
      note: 'An alias or a full model name, passed as --model.',
    },
    effort: {
      supported: true,
      values: ['low', 'medium', 'high', 'xhigh', 'max'],
      examples: [],
      default: 'high',
      backendEffect: 'applied',
      note: 'Passed as --effort. Which levels a session honours depends on its model.',
    },
  });
});

test('it advertises no default model or effort when the configured arguments set none', () => {
  const options = new ClaudeAdapter(buildClaudeConfig()).profile.spawnOptions;

  expect([options.model.default, options.effort.default]).toStrictEqual([null, null]);
});
