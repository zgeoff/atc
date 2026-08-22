import { expect, test } from 'bun:test';
import { collectGateways } from './collect-gateways';

test('it reads an entry into a gateway that names its own binary and menu row', () => {
  expect(
    collectGateways(
      {
        zai: {
          label: 'GLM (z.ai)',
          mark: 'z',
          baseURL: 'https://api.z.ai/api/anthropic',
          apiKeyHelper: '~/.local/bin/atc-zai-key',
          env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
        },
      },
      'claude',
      ['--verbose'],
    ),
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'GLM (z.ai)',
      mark: 'z',
      bin: 'claude',
      args: ['--verbose'],
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: '~/.local/bin/atc-zai-key',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
    },
  ]);
});

test('it falls back to the id for a label and a mark that were not given', () => {
  expect(
    collectGateways({ kimi: { baseURL: 'https://api.moonshot.ai/anthropic' } }, 'claude', []),
  ).toStrictEqual([
    {
      id: 'kimi',
      label: 'kimi',
      mark: 'k',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.moonshot.ai/anthropic',
      env: {},
    },
  ]);
});

test('it takes one character of a longer mark, so the overlay column stays one wide', () => {
  expect(
    collectGateways(
      { zai: { mark: 'zai', baseURL: 'https://api.z.ai/api/anthropic' } },
      'claude',
      [],
    ),
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
  ]);
});

test('it keeps a gateway that names its own binary instead of the Claude one', () => {
  expect(
    collectGateways(
      {
        zai: {
          bin: '/opt/claude-beta',
          args: ['--foo'],
          baseURL: 'https://api.z.ai/api/anthropic',
        },
      },
      'claude',
      ['--verbose'],
    ),
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: '/opt/claude-beta',
      args: ['--foo'],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
  ]);
});

test('it drops an environment value that is not a string, since a child takes strings', () => {
  expect(
    collectGateways(
      {
        zai: {
          baseURL: 'https://api.z.ai/api/anthropic',
          env: { API_TIMEOUT_MS: 3_000_000, ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
        },
      },
      'claude',
      [],
    ),
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
    },
  ]);
});

test('it leaves out an entry with no base URL, which could not be spawned', () => {
  expect(collectGateways({ zai: { label: 'GLM (z.ai)' } }, 'claude', [])).toStrictEqual([]);
});

test('it leaves out an entry under an id a built-in agent already answers to', () => {
  expect(
    collectGateways(
      {
        claude: { baseURL: 'https://example.test/anthropic' },
        grok: { baseURL: 'https://example.test/anthropic' },
        codex: { baseURL: 'https://example.test/anthropic' },
      },
      'claude',
      [],
    ),
  ).toStrictEqual([]);
});

test.each([[undefined], [null], ['zai'], [42], [[]]])(
  'it reads %p as no gateways at all',
  (raw) => {
    expect(collectGateways(raw, 'claude', [])).toStrictEqual([]);
  },
);

test.each([
  [null],
  ['https://api.z.ai/api/anthropic'],
  [42],
  [[]],
  [{}],
  [{ baseURL: 42 }],
  [{ baseURL: '' }],
])('it leaves out %p as a malformed gateway entry', (entry) => {
  expect(collectGateways({ zai: entry }, 'claude', [])).toStrictEqual([]);
});

test('it falls back to every default when an entry has a valid base URL but every other field is wrong-typed', () => {
  expect(
    collectGateways(
      {
        zai: {
          baseURL: 'https://api.z.ai/api/anthropic',
          label: 7,
          mark: 7,
          bin: 42,
          args: 'not-an-array',
          apiKeyHelper: 42,
          env: 'nope',
        },
      },
      'claude',
      ['--verbose'],
    ),
  ).toStrictEqual([
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: 'claude',
      args: ['--verbose'],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
  ]);
});
