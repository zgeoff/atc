import { expect, test } from 'bun:test';
import { parseConfig } from '../shared/config';
import { getGatewayConfig } from './get-gateway-config';

test('it returns the gateway a config holds under an id', () => {
  const config = parseConfig({ gateways: { glm: { baseURL: 'https://gateway.example.com' } } });

  expect(getGatewayConfig(config, 'glm')).toMatchObject({
    id: 'glm',
    baseURL: 'https://gateway.example.com',
    bin: 'claude',
  });
});

test('it throws when the agent has no baseURL', () => {
  const config = parseConfig({});

  expect(() => getGatewayConfig(config, 'claude')).toThrowWithMessage(
    Error,
    "the agent 'claude' has no baseURL",
  );
});
