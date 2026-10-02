import { expect, test } from 'bun:test';
import { buildAuthorizationServerMetadata } from './build-authorization-server-metadata';
import { buildProtectedResourceMetadata } from './build-protected-resource-metadata';

test('it advertises the authorization server endpoints and requirements for an origin', () => {
  expect(buildAuthorizationServerMetadata('https://mcp.example.com')).toStrictEqual({
    issuer: 'https://mcp.example.com',
    authorization_endpoint: 'https://mcp.example.com/authorize',
    token_endpoint: 'https://mcp.example.com/token',
    registration_endpoint: 'https://mcp.example.com/register',
    scopes_supported: ['read', 'message', 'spawn', 'kill'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  });
});

test('it binds the protected resource to the mcp path under the origin', () => {
  expect(buildProtectedResourceMetadata('https://mcp.example.com')).toStrictEqual({
    resource: 'https://mcp.example.com/mcp',
    authorization_servers: ['https://mcp.example.com'],
    scopes_supported: ['read', 'message', 'spawn', 'kill'],
    bearer_methods_supported: ['header'],
  });
});
