import { expect, test } from 'bun:test';
import { parseConfig } from '../shared/config';
import { resolveAgentMetadata } from './resolve-agent-metadata';

test('it labels the built-in agents by name', () => {
  const meta = resolveAgentMetadata(parseConfig({ gateways: {} }), {});

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex' },
    models: {},
  });
});

test('it labels a configured gateway by its configured label', () => {
  const meta = resolveAgentMetadata(
    parseConfig({
      gateways: { zai: { label: 'GLM (z.ai)', baseURL: 'https://api.z.ai/api/anthropic' } },
    }),
    {},
  );

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex', zai: 'GLM (z.ai)' },
    models: {},
  });
});

test('it labels a gateway without a label by its id', () => {
  const meta = resolveAgentMetadata(
    parseConfig({ gateways: { kimi: { baseURL: 'https://example.invalid/api/anthropic' } } }),
    {},
  );

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex', kimi: 'kimi' },
    models: {},
  });
});

test('it lets the agents.list answer win over the config label', () => {
  const meta = resolveAgentMetadata(
    parseConfig({
      gateways: { zai: { label: 'GLM (z.ai)', baseURL: 'https://api.z.ai/api/anthropic' } },
    }),
    { agents: [{ id: 'zai', label: 'GLM staged' }] },
  );

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex', zai: 'GLM staged' },
    models: {},
  });
});

test('it keeps the config label when the answer entry carries none', () => {
  const meta = resolveAgentMetadata(
    parseConfig({
      gateways: { zai: { label: 'GLM (z.ai)', baseURL: 'https://api.z.ai/api/anthropic' } },
    }),
    { agents: [{ id: 'zai' }] },
  );

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex', zai: 'GLM (z.ai)' },
    models: {},
  });
});

test('it reads an agents.list model alias map', () => {
  const meta = resolveAgentMetadata(parseConfig({ gateways: {} }), {
    agents: [{ id: 'zai', models: { opus: 'glm-5.3' } }],
  });

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex' },
    models: { zai: { opus: 'glm-5.3' } },
  });
});

test('it keeps the non-string values of an agents.list model map out', () => {
  const meta = resolveAgentMetadata(parseConfig({ gateways: {} }), {
    agents: [{ id: 'zai', models: { opus: 7, sonnet: 'glm-5.2' } }],
  });

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex' },
    models: { zai: { sonnet: 'glm-5.2' } },
  });
});

test('it reports no model map for an agent whose answer entry has none', () => {
  const meta = resolveAgentMetadata(parseConfig({ gateways: {} }), { agents: [{ id: 'claude' }] });

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex' },
    models: {},
  });
});

test('it falls back to the config alone when the answer holds no agents array', () => {
  const meta = resolveAgentMetadata(
    parseConfig({
      gateways: { zai: { label: 'GLM (z.ai)', baseURL: 'https://api.z.ai/api/anthropic' } },
    }),
    'not an answer',
  );

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex', zai: 'GLM (z.ai)' },
    models: {},
  });
});

test('it leaves a __proto__ agent id out instead of changing the prototype', () => {
  const meta = resolveAgentMetadata(parseConfig({ gateways: {} }), {
    agents: [{ id: '__proto__', label: 'Sneaky', models: { opus: 'sneaky-model' } }],
  });

  expect(Object.getPrototypeOf(meta.labels)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(meta.models)).toBe(Object.prototype);

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex' },
    models: {},
  });
});

test('it leaves a __proto__ model alias out of the map', () => {
  const models: unknown = JSON.parse('{"opus":"glm-5.3","__proto__":"sneaky-model"}');

  const meta = resolveAgentMetadata(parseConfig({ gateways: {} }), {
    agents: [{ id: 'zai', models }],
  });

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex' },
    models: { zai: { opus: 'glm-5.3' } },
  });
});

test('it reports no entries under constructor for a plain answer', () => {
  const meta = resolveAgentMetadata(parseConfig({ gateways: {} }), { agents: [{ id: 'claude' }] });

  expect(meta).toStrictEqual({
    labels: { claude: 'Claude', grok: 'Grok', codex: 'Codex' },
    models: {},
  });
});
