import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { CodexAdapter } from '../agents/codex-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { GrokAdapter } from '../agents/grok-adapter';
import { parseConfig } from '../shared/config';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { getGatewayConfig } from '../test-utils/get-gateway-config';
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

  const agents = buildAgentList(buildAgentAdapters(config), () => true, false);

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
    { ok: true, overrides: { model: 'fable' } },
    { ok: true, overrides: { model: 'opus' } },
    { ok: true, overrides: { model: 'sonnet' } },
    { ok: true, overrides: { model: 'haiku' } },
    { ok: true, overrides: { model: 'opus[1m]' } },
    { ok: true, overrides: { model: 'sonnet[1m]' } },
    { ok: true, overrides: { model: 'opusplan' } },
    { ok: true, overrides: { effort: 'low' } },
    { ok: true, overrides: { effort: 'medium' } },
    { ok: true, overrides: { effort: 'high' } },
    { ok: true, overrides: { effort: 'xhigh' } },
    { ok: true, overrides: { effort: 'max' } },
    { ok: true, overrides: { model: 'opus' } },
    { ok: true, overrides: { model: 'haiku' } },
    { ok: true, overrides: { effort: 'low' } },
    { ok: true, overrides: { effort: 'medium' } },
    { ok: true, overrides: { effort: 'high' } },
    { ok: true, overrides: { effort: 'xhigh' } },
    { ok: true, overrides: { effort: 'max' } },
  ]);
});

test('it refuses as unsupported every option agents.list does not advertise as available', () => {
  const config = parseConfig({});

  const agents = buildAgentList(
    [
      new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
      new GrokAdapter(getAgentEntry(config, 'grok')),
      new CodexAdapter(getAgentEntry(config, 'codex')),
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
    buildAgentAdapters(parseConfig({ agents: { claude: {} } })),
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
    buildAgentAdapters(parseConfig({ agents: { claude: {} } })),
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
    buildAgentAdapters(parseConfig({ agents: { claude: {} } })),
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
])('it refuses the effort %p that Claude Code does not accept', (effort, message) => {
  const [claude] = buildAgentList(
    buildAgentAdapters(parseConfig({ agents: { claude: {} } })),
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

test('it accepts a gateway effort', () => {
  const config = parseConfig({ gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic' } } });

  const [zai] = buildAgentList(
    [new GatewayAdapter(getGatewayConfig(config, 'zai'), config)],
    () => true,
    false,
  );

  invariant(zai !== undefined, 'the agent list holds no gateway entry');

  expect(parseSpawnOverrides(zai, { effort: 'high' })).toStrictEqual({
    ok: true,
    overrides: { effort: 'high' },
  });
});

test('it refuses a gateway effort outside the levels Claude Code accepts', () => {
  const config = parseConfig({ gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic' } } });

  const [zai] = buildAgentList(
    [new GatewayAdapter(getGatewayConfig(config, 'zai'), config)],
    () => true,
    false,
  );

  invariant(zai !== undefined, 'the agent list holds no gateway entry');

  expect(parseSpawnOverrides(zai, { effort: 'ultra' })).toStrictEqual({
    ok: false,
    code: 'bad_args',
    message: "agent 'zai' takes effort low, medium, high, xhigh, max; got 'ultra'",
  });
});

test('it refuses a codex effort', () => {
  const [codex] = buildAgentList(
    buildAgentAdapters(parseConfig({ agents: { codex: {} } })),
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

test('it accepts a codex model', () => {
  const [codex] = buildAgentList(
    buildAgentAdapters(parseConfig({ agents: { codex: {} } })),
    () => true,
    false,
  );

  invariant(codex !== undefined, 'the agent list holds no codex entry');

  expect(parseSpawnOverrides(codex, { model: 'gpt-5.1-codex' })).toStrictEqual({
    ok: true,
    overrides: { model: 'gpt-5.1-codex' },
  });
});
