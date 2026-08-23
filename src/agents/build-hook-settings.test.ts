import { expect, test } from 'bun:test';
import { buildHookSettings } from './build-hook-settings';

test('it never writes a credential into the settings a session is started with', () => {
  const settings = buildHookSettings(
    {
      id: 'zai',
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
      apiKeyHelper: '~/.local/bin/atc-zai-key',
    },
    0,
  );

  const serialized = JSON.stringify(settings);

  expect(serialized).not.toInclude('ANTHROPIC_AUTH_TOKEN');
  expect(serialized).not.toInclude('ANTHROPIC_API_KEY');
  expect(settings['apiKeyHelper']).toBe('~/.local/bin/atc-zai-key');
});

test('it carries the backend in an env block, which outranks a shell export', () => {
  expect(
    buildHookSettings(
      {
        id: 'zai',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
        },
      },
      0,
    )['env'],
  ).toStrictEqual({
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
  });
});

test('it leaves out the env block and the helper for an agent that needs neither', () => {
  const settings = buildHookSettings({ id: 'claude' }, 0);

  expect(settings['env']).toBeUndefined();
  expect(settings['apiKeyHelper']).toBeUndefined();
});

test('it leaves out an env block that was given with nothing in it', () => {
  expect(buildHookSettings({ id: 'zai', env: {} }, 0)['env']).toBeUndefined();
});

test('it reports every hook the fleet needs to track a session', () => {
  const settings = buildHookSettings({ id: 'claude' }, 0);
  const hooks = settings['hooks'];

  if (typeof hooks !== 'object' || hooks === null) {
    throw new TypeError('settings carry no hooks object');
  }

  expect(Object.keys(hooks)).toStrictEqual([
    'SessionStart',
    'Notification',
    'Stop',
    'UserPromptSubmit',
    'SessionEnd',
  ]);
});

test('it mirrors the padding of the statusline it chains', () => {
  expect(buildHookSettings({ id: 'claude' }, 3)['statusLine']).toMatchObject({ padding: 3 });
});
