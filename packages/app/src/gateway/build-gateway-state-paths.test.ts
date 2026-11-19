import { expect, test } from 'bun:test';
import { buildGatewayStatePaths } from './build-gateway-state-paths';

test('it places the binding and authorization databases in the state directory', () => {
  expect(buildGatewayStatePaths('/srv/gateway/state')).toStrictEqual({
    bindingsDBFile: '/srv/gateway/state/gateway.db',
    mcpAuthDBFile: '/srv/gateway/state/mcp-auth.db',
  });
});
