import { expect, test } from 'bun:test';
import { buildMockAgentAdapter } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildAgentList } from './build-agent-list';
import { parseSpawnOverrides } from './parse-spawn-overrides';

test('it accepts every model and effort value agents.list advertises as available', () => {
  const agents = buildAgentList(
    [
      buildMockAgentAdapter({
        id: 'claude',
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'claude',
          models: null,
          spawnOptions: {
            model: {
              supported: true,
              values: null,
              examples: [
                { value: 'best', resolvesTo: null },
                { value: 'opus', resolvesTo: null },
                { value: 'opus[1m]', resolvesTo: null },
              ],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
            effort: {
              supported: true,
              values: ['low', 'medium', 'high', 'xhigh', 'max'],
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
        },
      }),
      buildMockAgentAdapter({
        id: 'grok',
        profile: {
          label: 'Grok',
          kind: 'grok',
          bin: 'grok',
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
          },
        },
      }),
      buildMockAgentAdapter({
        id: 'zai',
        profile: {
          label: 'zai',
          kind: 'gateway',
          bin: 'claude',
          models: { opus: 'glm-4.6', haiku: 'glm-4.5' },
          spawnOptions: {
            model: {
              supported: true,
              values: null,
              examples: [
                { value: 'opus', resolvesTo: 'glm-4.6' },
                { value: 'haiku', resolvesTo: 'glm-4.5' },
              ],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
            effort: {
              supported: true,
              values: ['low', 'high'],
              examples: [],
              default: null,
              backendEffect: 'unverified',
              note: null,
            },
          },
        },
      }),
    ],
    () => true,
    false,
  );

  const advertised = agents.flatMap((agent) =>
    (['model', 'effort'] as const)
      .filter((name) => agent.spawnOptions[name].available)
      .flatMap((name) => {
        const option = agent.spawnOptions[name];

        return [...(option.values ?? []), ...option.examples.map((example) => example.value)].map(
          (value) => ({ agent, requested: { [name]: value } }),
        );
      }),
  );

  const parsed = advertised.map((entry) => parseSpawnOverrides(entry.agent, entry.requested));

  expect(parsed).toStrictEqual([
    { ok: true, overrides: { model: 'best' } },
    { ok: true, overrides: { model: 'opus' } },
    { ok: true, overrides: { model: 'opus[1m]' } },
    { ok: true, overrides: { effort: 'low' } },
    { ok: true, overrides: { effort: 'medium' } },
    { ok: true, overrides: { effort: 'high' } },
    { ok: true, overrides: { effort: 'xhigh' } },
    { ok: true, overrides: { effort: 'max' } },
    { ok: true, overrides: { model: 'opus' } },
    { ok: true, overrides: { model: 'haiku' } },
    { ok: true, overrides: { effort: 'low' } },
    { ok: true, overrides: { effort: 'high' } },
  ]);
});

test('it refuses as unsupported every option agents.list does not advertise as available', () => {
  const agents = buildAgentList(
    [
      buildMockAgentAdapter({
        id: 'grok',
        profile: {
          label: 'Grok',
          kind: 'grok',
          bin: 'grok',
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
          },
        },
      }),
      buildMockAgentAdapter({
        id: 'codex',
        profile: {
          label: 'Codex',
          kind: 'codex',
          bin: 'codex',
          models: null,
          spawnOptions: {
            model: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
          },
        },
      }),
    ],
    () => true,
    false,
  );

  const refused = agents.flatMap((agent) =>
    (['model', 'effort'] as const)
      .filter((name) => !agent.spawnOptions[name].available)
      .map((name) => ({ id: agent.id, parsed: parseSpawnOverrides(agent, { [name]: 'high' }) })),
  );

  expect(refused).toStrictEqual([
    {
      id: 'grok',
      parsed: { ok: false, code: 'unsupported', message: "agent 'grok' takes no model" },
    },
    {
      id: 'grok',
      parsed: { ok: false, code: 'unsupported', message: "agent 'grok' takes no effort" },
    },
    {
      id: 'codex',
      parsed: { ok: false, code: 'unsupported', message: "agent 'codex' takes no effort" },
    },
  ]);
});

test('it refuses a model for a registered agent that is not installed', () => {
  const [claude] = buildAgentList(
    [
      buildMockAgentAdapter({
        id: 'claude',
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'claude',
          models: null,
          spawnOptions: {
            model: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
            effort: {
              supported: true,
              values: ['low', 'medium', 'high', 'xhigh', 'max'],
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
        },
      }),
    ],
    () => false,
    false,
  );

  invariant(claude !== undefined, 'the agent list holds no claude entry');

  expect(parseSpawnOverrides(claude, { model: 'opus' })).toStrictEqual({
    ok: false,
    code: 'unsupported',
    message: "agent 'claude' is not installed on this host",
  });
});

test('it passes a full model name through as given', () => {
  const [claude] = buildAgentList(
    [
      buildMockAgentAdapter({
        id: 'claude',
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'claude',
          models: null,
          spawnOptions: {
            model: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
            effort: {
              supported: true,
              values: ['low', 'medium', 'high', 'xhigh', 'max'],
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
        },
      }),
    ],
    () => true,
    false,
  );

  invariant(claude !== undefined, 'the agent list holds no claude entry');

  expect(
    parseSpawnOverrides(claude, { model: 'claude-opus-4-5-20251101[1m]', effort: 'xhigh' }),
  ).toStrictEqual({
    ok: true,
    overrides: { model: 'claude-opus-4-5-20251101[1m]', effort: 'xhigh' },
  });
});

test.each([
  ['--dangerously-skip-permissions', "model must not start with '-' or hold control characters"],
  ['-m', "model must not start with '-' or hold control characters"],
  ['opus\nrm -rf', "model must not start with '-' or hold control characters"],
  ['opus\u001B[2J', "model must not start with '-' or hold control characters"],
  ['', 'model must be 1 to 200 characters'],
  ['m'.repeat(201), 'model must be 1 to 200 characters'],
])('it refuses the model %p as bad_args', (model, message) => {
  const [claude] = buildAgentList(
    [
      buildMockAgentAdapter({
        id: 'claude',
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'claude',
          models: null,
          spawnOptions: {
            model: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
            effort: {
              supported: true,
              values: ['low', 'medium', 'high', 'xhigh', 'max'],
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
        },
      }),
    ],
    () => true,
    false,
  );

  invariant(claude !== undefined, 'the agent list holds no claude entry');

  expect(parseSpawnOverrides(claude, { model })).toStrictEqual({
    ok: false,
    code: 'bad_args',
    message,
  });
});

test.each([
  ['ultra', "agent 'claude' takes effort low, medium, high, xhigh, max; got 'ultra'"],
  ['minimal', "agent 'claude' takes effort low, medium, high, xhigh, max; got 'minimal'"],
  ['HIGH', "agent 'claude' takes effort low, medium, high, xhigh, max; got 'HIGH'"],
  ['--max', "effort must not start with '-' or hold control characters"],
])('it refuses the effort %p outside the closed set the agent takes', (effort, message) => {
  const [claude] = buildAgentList(
    [
      buildMockAgentAdapter({
        id: 'claude',
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'claude',
          models: null,
          spawnOptions: {
            model: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
            effort: {
              supported: true,
              values: ['low', 'medium', 'high', 'xhigh', 'max'],
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
        },
      }),
    ],
    () => true,
    false,
  );

  invariant(claude !== undefined, 'the agent list holds no claude entry');

  expect(parseSpawnOverrides(claude, { effort })).toStrictEqual({
    ok: false,
    code: 'bad_args',
    message,
  });
});

test('it refuses an effort for an agent that takes none', () => {
  const [codex] = buildAgentList(
    [
      buildMockAgentAdapter({
        id: 'codex',
        profile: {
          label: 'Codex',
          kind: 'codex',
          bin: 'codex',
          models: null,
          spawnOptions: {
            model: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
          },
        },
      }),
    ],
    () => true,
    false,
  );

  invariant(codex !== undefined, 'the agent list holds no codex entry');

  expect(parseSpawnOverrides(codex, { effort: 'high' })).toStrictEqual({
    ok: false,
    code: 'unsupported',
    message: "agent 'codex' takes no effort",
  });
});

test('it accepts any model for an agent whose model option has no closed set', () => {
  const [codex] = buildAgentList(
    [
      buildMockAgentAdapter({
        id: 'codex',
        profile: {
          label: 'Codex',
          kind: 'codex',
          bin: 'codex',
          models: null,
          spawnOptions: {
            model: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
          },
        },
      }),
    ],
    () => true,
    false,
  );

  invariant(codex !== undefined, 'the agent list holds no codex entry');

  expect(parseSpawnOverrides(codex, { model: 'gpt-5.1-codex' })).toStrictEqual({
    ok: true,
    overrides: { model: 'gpt-5.1-codex' },
  });
});
