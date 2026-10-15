import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { CLAUDE_PLUGIN } from '../claude-plugin';
import { getGatewayConfig } from './get-gateway-config';

test('it returns the gateway a config holds under an id', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { glm: { kind: 'claude', baseURL: 'https://gateway.example.com' } },
  });

  expect(getGatewayConfig(config, 'glm')).toStrictEqual({
    id: 'glm',
    label: 'glm',
    mark: 'g',
    bin: 'claude',
    args: [],
    env: {},
    baseURL: 'https://gateway.example.com',
  });
});

test('it throws when the agent has no baseURL', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {});

  expect(() => getGatewayConfig(config, 'claude')).toThrowWithMessage(
    Error,
    "the agent 'claude' has no baseURL",
  );
});

test('it throws naming the id when the config holds no such agent', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {});

  expect(() => getGatewayConfig(config, 'glm')).toThrowWithMessage(
    Error,
    "the config holds no agent 'glm'",
  );
});
