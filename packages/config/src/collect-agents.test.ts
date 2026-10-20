import { expect, test } from 'bun:test';
import { buildStubHarnessPlugins } from '@atc/test-utils';
import { collectAgents } from './collect-agents';

test('it fills every default for the three ids that name a kind', () => {
  expect(
    collectAgents({ claude: {}, codex: {}, grok: {} }, new Map(), buildStubHarnessPlugins()),
  ).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
      { id: 'codex', kind: 'codex', label: 'Codex', mark: 'c', bin: 'codex', args: [], env: {} },
      { id: 'grok', kind: 'grok', label: 'Grok', mark: 'g', bin: 'grok', args: [], env: {} },
    ],
    errors: [],
  });
});

test('it defaults a custom id to its own label and first character', () => {
  expect(
    collectAgents({ '🚀fast': { kind: 'codex' } }, new Map(), buildStubHarnessPlugins()),
  ).toStrictEqual({
    agents: [
      { id: '🚀fast', kind: 'codex', label: '🚀fast', mark: '🚀', bin: 'codex', args: [], env: {} },
    ],
    errors: [],
  });
});

test('it takes the first code point of a configured mark', () => {
  expect(
    collectAgents({ claude: { mark: '🚀ab' } }, new Map(), buildStubHarnessPlugins()),
  ).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: '🚀',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: [],
  });
});

test('it keeps registry order and loads several entries of one kind', () => {
  const result = collectAgents(
    {
      'claude-b': { kind: 'claude', args: ['--b'] },
      claude: { args: ['--a'] },
    },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-b',
        kind: 'claude',
        label: 'claude-b',
        mark: 'c',
        bin: 'claude',
        args: ['--b'],
        env: {},
      },
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: ['--a'],
        env: {},
      },
    ],
    errors: [],
  });
});

test('it loads a claude entry with settings and env', () => {
  const result = collectAgents(
    { claude: { settings: { model: 'opus' }, env: { FOO: 'bar' } } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: { FOO: 'bar' },
        settings: { model: 'opus' },
      },
    ],
    errors: [],
  });
});

test('it loads a claude entry with a baseURL and a credential helper', () => {
  const result = collectAgents(
    {
      zai: {
        kind: 'claude',
        label: 'GLM',
        mark: 'z',
        baseURL: 'https://api.z.ai/api/anthropic',
        apiKeyHelper: 'op read x',
      },
    },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'zai',
        kind: 'claude',
        label: 'GLM',
        mark: 'z',
        bin: 'claude',
        args: [],
        env: {},
        baseURL: 'https://api.z.ai/api/anthropic',
        apiKeyHelper: 'op read x',
      },
    ],
    errors: [],
  });
});

test('it refuses auth on a grok entry', () => {
  const result = collectAgents(
    { grok: { auth: { profiles: ['codex'] } } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: ['agents.grok: auth is not valid for kind grok'],
  });
});

test('it refuses an entry with an unknown field and reports it alone', () => {
  const result = collectAgents(
    { claude: { colour: 'red' }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: unknown field colour'],
  });
});

test('it refuses an entry with a wrong-typed args and reports it alone', () => {
  const result = collectAgents(
    { claude: { args: 'x' }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: args must be an array of strings'],
  });
});

test('it refuses an entry with an empty bin and reports it alone', () => {
  const result = collectAgents(
    { claude: { bin: '' }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: bin must be a non-empty string'],
  });
});

test('it refuses an entry with a non-string env value and reports it alone', () => {
  const result = collectAgents(
    { claude: { env: { DEBUG: 1 } }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: env must be an object of strings'],
  });
});

test('it refuses an entry with an array for settings and reports it alone', () => {
  const result = collectAgents(
    { claude: { settings: ['model'] }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: settings must be an object'],
  });
});

test('it refuses an entry with a baseURL on codex and reports it alone', () => {
  const result = collectAgents(
    { codex: { baseURL: 'https://x.example.com' }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.codex: baseURL is not valid for kind codex'],
  });
});

test('it refuses an entry with env on grok and reports it alone', () => {
  const result = collectAgents(
    { grok: { env: { DEBUG: '1' } }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.grok: env is not valid for kind grok'],
  });
});

test('it refuses an entry with a kind that contradicts its id and reports it alone', () => {
  const result = collectAgents(
    { codex: { kind: 'claude' }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.codex: kind claude contradicts the id codex'],
  });
});

test('it refuses an entry with no kind on a custom id and reports it alone', () => {
  const result = collectAgents(
    { fast: {}, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.fast: kind is required for an id other than claude, codex, or grok'],
  });
});

test('it refuses an entry with an unknown kind and reports it alone', () => {
  const result = collectAgents(
    { fast: { kind: 'vim' }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.fast: kind must be claude, codex, or grok'],
  });
});

test('it lists two plugin ids without a comma in the kind problem', () => {
  const result = collectAgents(
    { fast: { kind: 'vim' } },
    new Map(),
    buildStubHarnessPlugins().filter((plugin) => plugin.id !== 'codex'),
  );

  expect(result).toStrictEqual({
    agents: [],
    errors: ['agents.fast: kind must be claude or grok'],
  });
});

test('it refuses an entry with a non-object entry and reports it alone', () => {
  const result = collectAgents(
    { claude: 7, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.claude: the entry must be an object'],
  });
});

test('it refuses an entry with an empty id and reports it alone', () => {
  const result = collectAgents(
    { '': { kind: 'claude' }, 'claude-ok': { kind: 'claude' } },
    new Map(),
    buildStubHarnessPlugins(),
  );

  expect(result).toStrictEqual({
    agents: [
      {
        id: 'claude-ok',
        kind: 'claude',
        label: 'claude-ok',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
    ],
    errors: ['agents.: the id cannot be used'],
  });
});

test('it refuses the __proto__ id', () => {
  const raw: unknown = JSON.parse('{ "__proto__": { "kind": "claude" } }');

  expect(collectAgents(raw, new Map(), buildStubHarnessPlugins())).toStrictEqual({
    agents: [],
    errors: ['agents.__proto__: the id cannot be used'],
  });
});

test('it leaves an empty registry and one error when agents is an array', () => {
  expect(collectAgents([], new Map(), buildStubHarnessPlugins())).toStrictEqual({
    agents: [],
    errors: ['agents must be an object of agent entries'],
  });
});

test('it leaves an empty registry and one error when agents is a string', () => {
  expect(collectAgents('claude', new Map(), buildStubHarnessPlugins())).toStrictEqual({
    agents: [],
    errors: ['agents must be an object of agent entries'],
  });
});

test('it leaves an empty registry and one error when agents is null', () => {
  expect(collectAgents(null, new Map(), buildStubHarnessPlugins())).toStrictEqual({
    agents: [],
    errors: ['agents must be an object of agent entries'],
  });
});
