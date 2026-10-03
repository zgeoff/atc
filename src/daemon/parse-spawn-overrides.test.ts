import { expect, test } from 'bun:test';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { CodexAdapter } from '../agents/codex-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { GrokAdapter } from '../agents/grok-adapter';
import { parseConfig } from '../shared/config';
import { buildAgentList } from './build-agent-list';
import { parseSpawnOverrides } from './parse-spawn-overrides';

test('it accepts every model and effort value agents.list advertises as available', () => {
  const config = parseConfig({
    gateways: {
      zai: {
        baseURL: 'https://api.z.ai/api/anthropic',
        env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5' },
      },
    },
  });

  const agents = buildAgentList(
    [
      new ClaudeAdapter(config),
      new GrokAdapter(config),
      new CodexAdapter(config),
      ...config.gateways.map((gateway) => new GatewayAdapter(gateway, config)),
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

  expect(advertised).toHaveLength(20);
  expect(parsed.map((result) => result.ok)).toSatisfyAll((ok) => ok === true);
});

test('it refuses as unsupported every option agents.list does not advertise as available', () => {
  const config = parseConfig({});

  const agents = buildAgentList(
    [new ClaudeAdapter(config), new GrokAdapter(config), new CodexAdapter(config)],
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
  const [claude] = buildAgentList([new ClaudeAdapter(parseConfig({}))], () => false, false);

  if (claude === undefined) {
    throw new Error('the agent list holds no claude entry');
  }

  expect(parseSpawnOverrides(claude, { model: 'opus' })).toStrictEqual({
    ok: false,
    code: 'unsupported',
    message: "agent 'claude' is not installed on this host",
  });
});

test('it passes a full model name through as given', () => {
  const [claude] = buildAgentList([new ClaudeAdapter(parseConfig({}))], () => true, false);

  if (claude === undefined) {
    throw new Error('the agent list holds no claude entry');
  }

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
  const [claude] = buildAgentList([new ClaudeAdapter(parseConfig({}))], () => true, false);

  if (claude === undefined) {
    throw new Error('the agent list holds no claude entry');
  }

  expect(parseSpawnOverrides(claude, { model })).toStrictEqual({
    ok: false,
    code: 'bad_args',
    message,
  });
});

test.each(['ultra', 'minimal', 'HIGH', '--max'])(
  'it refuses the effort %p that Claude Code does not accept',
  (effort) => {
    const [claude] = buildAgentList([new ClaudeAdapter(parseConfig({}))], () => true, false);

    if (claude === undefined) {
      throw new Error('the agent list holds no claude entry');
    }

    expect(parseSpawnOverrides(claude, { effort })).toMatchObject({
      ok: false,
      code: 'bad_args',
    });
  },
);

test("it accepts a gateway effort and marks the provider's response to it unverified", () => {
  const config = parseConfig({ gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic' } } });

  const [zai] = buildAgentList(
    config.gateways.map((gateway) => new GatewayAdapter(gateway, config)),
    () => true,
    false,
  );

  if (zai === undefined) {
    throw new Error('the agent list holds no gateway entry');
  }

  expect(zai.spawnOptions.effort.backendEffect).toBe('unverified');

  expect(parseSpawnOverrides(zai, { effort: 'high' })).toStrictEqual({
    ok: true,
    overrides: { effort: 'high' },
  });
});

test('it refuses a gateway effort outside the levels Claude Code accepts', () => {
  const config = parseConfig({ gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic' } } });

  const [zai] = buildAgentList(
    config.gateways.map((gateway) => new GatewayAdapter(gateway, config)),
    () => true,
    false,
  );

  if (zai === undefined) {
    throw new Error('the agent list holds no gateway entry');
  }

  expect(parseSpawnOverrides(zai, { effort: 'ultra' })).toStrictEqual({
    ok: false,
    code: 'bad_args',
    message: "agent 'zai' takes effort low, medium, high, xhigh, max; got 'ultra'",
  });
});

test('it refuses a codex effort and accepts a codex model', () => {
  const [codex] = buildAgentList([new CodexAdapter(parseConfig({}))], () => true, false);

  if (codex === undefined) {
    throw new Error('the agent list holds no codex entry');
  }

  expect([
    parseSpawnOverrides(codex, { effort: 'high' }),
    parseSpawnOverrides(codex, { model: 'gpt-5.1-codex' }),
  ]).toStrictEqual([
    { ok: false, code: 'unsupported', message: "agent 'codex' takes no effort" },
    { ok: true, overrides: { model: 'gpt-5.1-codex' } },
  ]);
});
