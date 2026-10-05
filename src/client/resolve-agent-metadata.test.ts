import { expect, test } from 'bun:test';
import { parseConfig } from '../shared/config';
import { resolveAgentMetadata } from './resolve-agent-metadata';

// The config every test starts from: no gateways, so each case adds the one
// it is about.
function buildConfig(gateways: unknown): ReturnType<typeof parseConfig> {
  return parseConfig({ gateways });
}

test('it labels the built-in agents by name', () => {
  const meta = resolveAgentMetadata(buildConfig({}), {});

  expect(meta.labels['claude']).toBe('Claude');
  expect(meta.labels['grok']).toBe('Grok');
  expect(meta.labels['codex']).toBe('Codex');
});

test('it labels a configured gateway by its configured label', () => {
  const meta = resolveAgentMetadata(
    buildConfig({ zai: { label: 'GLM (z.ai)', baseURL: 'https://api.z.ai/api/anthropic' } }),
    {},
  );

  expect(meta.labels['zai']).toBe('GLM (z.ai)');
});

test('it labels a gateway without a label by its id', () => {
  const meta = resolveAgentMetadata(
    buildConfig({ kimi: { baseURL: 'https://example.invalid/api/anthropic' } }),
    {},
  );

  expect(meta.labels['kimi']).toBe('kimi');
});

test('it lets the agents.list answer win over the config label', () => {
  const meta = resolveAgentMetadata(
    buildConfig({ zai: { label: 'GLM (z.ai)', baseURL: 'https://api.z.ai/api/anthropic' } }),
    { agents: [{ id: 'zai', label: 'GLM staged' }] },
  );

  expect(meta.labels['zai']).toBe('GLM staged');
});

test('it keeps the config label when the answer entry carries none', () => {
  const meta = resolveAgentMetadata(
    buildConfig({ zai: { label: 'GLM (z.ai)', baseURL: 'https://api.z.ai/api/anthropic' } }),
    { agents: [{ id: 'zai' }] },
  );

  expect(meta.labels['zai']).toBe('GLM (z.ai)');
});

test('it reads an agents.list model alias map', () => {
  const meta = resolveAgentMetadata(buildConfig({}), {
    agents: [{ id: 'zai', models: { opus: 'glm-5.3' } }],
  });

  expect(meta.models['zai']).toStrictEqual({ opus: 'glm-5.3' });
});

test('it keeps the non-string values of an agents.list model map out', () => {
  const meta = resolveAgentMetadata(buildConfig({}), {
    agents: [{ id: 'zai', models: { opus: 7, sonnet: 'glm-5.2' } }],
  });

  expect(meta.models['zai']).toStrictEqual({ sonnet: 'glm-5.2' });
});

test('it reports no model map for an agent whose answer entry has none', () => {
  const meta = resolveAgentMetadata(buildConfig({}), { agents: [{ id: 'claude' }] });

  expect(meta.models['claude']).toBeUndefined();
});

test('it falls back to the config alone when the answer holds no agents array', () => {
  const meta = resolveAgentMetadata(
    buildConfig({ zai: { label: 'GLM (z.ai)', baseURL: 'https://api.z.ai/api/anthropic' } }),
    'not an answer',
  );

  expect(meta.labels['zai']).toBe('GLM (z.ai)');
  expect(meta.models['zai']).toBeUndefined();
});

test('it leaves a __proto__ agent id out instead of changing the prototype', () => {
  const meta = resolveAgentMetadata(buildConfig({}), {
    agents: [{ id: '__proto__', label: 'Sneaky', models: { opus: 'sneaky-model' } }],
  });

  expect(Object.getPrototypeOf(meta.labels)).toBe(Object.prototype);
  expect(Object.hasOwn(meta.labels, '__proto__')).toBe(false);
  expect(Object.hasOwn(meta.models, '__proto__')).toBe(false);
});

test('it leaves a __proto__ model alias out of the map', () => {
  const meta = resolveAgentMetadata(buildConfig({}), {
    agents: [{ id: 'zai', models: { __proto__: 'sneaky-model', opus: 'glm-5.3' } }],
  });

  expect(meta.models['zai']).toStrictEqual({ opus: 'glm-5.3' });
});

test('it reports no entries under constructor for a plain answer', () => {
  const meta = resolveAgentMetadata(buildConfig({}), { agents: [{ id: 'claude' }] });

  expect(Object.hasOwn(meta.labels, 'constructor')).toBe(false);
  expect(Object.hasOwn(meta.models, 'constructor')).toBe(false);
});
