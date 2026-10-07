import { expect, test } from 'bun:test';
import { parseConfig } from '../shared/config';
import { getGatewayConfig } from './get-gateway-config';

test('it returns the gateway a config holds under an id', () => {
  const config = parseConfig({ gateways: { glm: { baseURL: 'https://gateway.example.com' } } });

  expect(getGatewayConfig(config, 'glm') as unknown).toStrictEqual({
    id: 'glm',
    kind: 'claude',
    label: 'glm',
    mark: 'g',
    bin: 'claude',
    args: [],
    env: {},
    baseURL: 'https://gateway.example.com',
  });
});

test('it throws when the agent has no baseURL', () => {
  const config = parseConfig({});

  expect(() => getGatewayConfig(config, 'claude')).toThrowWithMessage(
    Error,
    "the agent 'claude' has no baseURL",
  );
});

test('it throws naming the id when the config holds no such agent', () => {
  const config = parseConfig({});

  expect(() => getGatewayConfig(config, 'glm')).toThrowWithMessage(
    Error,
    "the config holds no agent 'glm'",
  );
});
