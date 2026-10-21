import { expect, test } from 'bun:test';
import { LEGACY_BROKER_PLACEHOLDER } from '@atc/config';
import type { AuthProfile } from '@atc/plugin-api';
import { buildMockAuthProfile } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildAuthBinding } from './build-auth-binding';
import { buildStoredBindingHash } from './build-stored-binding-hash';

test('it hashes a stored binding of the older placeholder and github rules as the current binding of the same grants', () => {
  const planned = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['gh'], placeholderEnv: {} },
    },
    new Map([
      [
        'gh',
        buildMockAuthProfile({
          name: 'gh',
          secret: 'gh',
          kind: 'github',
          env: { GH_TOKEN: 'broker-placeholder' },
        }),
      ],
    ]),
  );

  invariant('binding' in planned);

  expect(
    buildStoredBindingHash(
      JSON.stringify({
        agent: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        profiles: ['gh'],
        secrets: [
          {
            secret: 'gh',
            kind: 'github',
            rules: [
              { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
              {
                host: 'github.com',
                header: 'authorization',
                scheme: 'basic',
                user: 'x-access-token',
              },
              { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
            ],
          },
        ],
        placeholderEnv: {},
        profileEnv: { GH_TOKEN: LEGACY_BROKER_PLACEHOLDER },
        hash: 'stale-hash',
      }),
    ),
  ).toBe(planned.binding.hash);
});

test('it hashes a stored binding of the current form as the binding that wrote it', () => {
  const planned = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['gh', 'glm'], placeholderEnv: {} },
    },
    new Map<string, AuthProfile>([
      [
        'gh',
        buildMockAuthProfile({
          name: 'gh',
          secret: 'gh',
          kind: 'github',
          env: { GH_TOKEN: 'broker-placeholder' },
        }),
      ],
      [
        'glm',
        buildMockAuthProfile({
          name: 'glm',
          secret: 'glm',
          host: 'api.z.ai',
          header: 'authorization',
        }),
      ],
    ]),
  );

  invariant('binding' in planned);

  expect(buildStoredBindingHash(JSON.stringify(planned.binding))).toBe(planned.binding.hash);
});

test('it hashes a stored github secret whose rules differ from the older set apart from the current binding', () => {
  const planned = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['gh'], placeholderEnv: {} },
    },
    new Map([['gh', buildMockAuthProfile({ name: 'gh', secret: 'gh', kind: 'github' })]]),
  );

  invariant('binding' in planned);

  expect(
    buildStoredBindingHash(
      JSON.stringify({
        secrets: [
          {
            secret: 'gh',
            kind: 'github',
            rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
          },
        ],
        profileEnv: {},
      }),
    ),
  ).not.toBe(planned.binding.hash);
});

test('it hashes a stored custom variable apart from the placeholder', () => {
  const planned = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['gh'], placeholderEnv: {} },
    },
    new Map([
      [
        'gh',
        buildMockAuthProfile({
          name: 'gh',
          secret: 'gh',
          kind: 'github',
          env: { GH_TOKEN: 'broker-placeholder' },
        }),
      ],
    ]),
  );

  invariant('binding' in planned);

  expect(
    buildStoredBindingHash(
      JSON.stringify({
        secrets: [{ secret: 'gh', kind: 'github', rules: [] }],
        profileEnv: { GH_TOKEN: 'other-placeholder' },
      }),
    ),
  ).not.toBe(planned.binding.hash);
});

test('it finds no hash for a stored binding without a list of secrets', () => {
  expect(buildStoredBindingHash(JSON.stringify({ profileEnv: {} }))).toBeNull();
});
