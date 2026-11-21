import { expect, test } from 'bun:test';
import { buildMockExecutionHostServices } from '@atc/plugin-api/test-utils/build-mock-execution-host-services';
import { DOCKER_PLUGIN } from './docker-plugin';

test('it lists the target as unavailable when the daemon runs from source', () => {
  expect(() =>
    DOCKER_PLUGIN.create(
      { id: 'box', options: { image: 'example/agents:1' }, env: {} },
      buildMockExecutionHostServices(),
      { authProfiles: new Map() },
    ),
  ).toThrow(
    expect.objectContaining({ problem: expect.stringContaining('compiled_binary_required') }),
  );
});

test('it lists the target as unavailable when its config gives no image', () => {
  expect(() =>
    DOCKER_PLUGIN.create({ id: 'box', options: {}, env: {} }, buildMockExecutionHostServices(), {
      authProfiles: new Map(),
    }),
  ).toThrow(expect.objectContaining({ problem: expect.stringContaining('image') }));
});

test.each([
  ['tcp://Docker.Example.dev:2375/', 'tcp://docker.example.dev:2375'],
  ['ssh://deploy@rack.example.dev', 'ssh://deploy@rack.example.dev'],
])('it places the remote socket %s in a shared place', (socket, normalized) => {
  expect(DOCKER_PLUGIN.place?.({ image: 'example/agents:1', socket })).toStrictEqual({
    scope: 'shared',
    version: 'place-v1',
    parts: { socket: normalized },
  });
});

test.each([[{ socket: '/var/run/docker.sock' }], [{}]])(
  'it places a docker target with options %p in a daemon place',
  (options) => {
    expect(DOCKER_PLUGIN.place?.({ image: 'example/agents:1', ...options })).toStrictEqual({
      scope: 'daemon',
    });
  },
);

test('it declares the identity version and the one option that never selects a host', () => {
  expect(DOCKER_PLUGIN.identity).toStrictEqual({
    version: 'docker-v1',
    ignoredOptions: ['image'],
  });
});

test('it reports the config problem of a target in full through its schema', () => {
  const schema = DOCKER_PLUGIN.configSchema({
    authProfiles: new Map(),
    entryID: 'box',
    foreignFields: new Set(),
  });

  const parsed = schema.safeParse({ id: 'box', options: { image: 'a', socket: 'x' }, env: {} });

  expect(parsed.error?.issues.map((issue) => issue.message)).toStrictEqual([
    'target "box" must give socket as an absolute path',
  ]);
});
