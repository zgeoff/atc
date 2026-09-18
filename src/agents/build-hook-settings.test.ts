import { expect, test } from 'bun:test';
import { z } from 'zod';
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

test('it registers a configured hook on an event of its own', () => {
  const entry = { matcher: '.*', hooks: [{ type: 'command', command: 'classify-tool-call' }] };

  const settings = buildHookSettings(
    { id: 'zai', settings: { hooks: { PermissionRequest: [entry] } } },
    0,
  );

  expect(settings['hooks']).toMatchObject({ PermissionRequest: [entry] });
});

// The fleet stops tracking a session whose reporter was replaced, so a
// configured hook on an event atc uses runs beside it rather than instead.
test('it runs its own reporter before a configured hook on the same event', () => {
  const entry = { hooks: [{ type: 'command', command: 'say-hello' }] };
  const settings = buildHookSettings({ id: 'zai', settings: { hooks: { Stop: [entry] } } }, 0);
  const hooks = z.record(z.string(), z.array(z.unknown())).parse(settings['hooks']);

  expect(hooks['Stop']).toHaveLength(2);
  expect(JSON.stringify(hooks['Stop']?.[0])).toInclude('hook-report');
  expect(hooks['Stop']?.[1]).toStrictEqual(entry);
});

test('it keeps its own value for a key the configured settings also name', () => {
  const settings = buildHookSettings(
    {
      id: 'zai',
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
      settings: { env: { ANTHROPIC_BASE_URL: 'https://example.invalid' }, statusLine: 'mine' },
    },
    0,
  );

  expect(settings['env']).toStrictEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' });
  expect(settings['statusLine']).toMatchObject({ type: 'command' });
});

test('it passes through a configured key it sets nothing of its own for', () => {
  const settings = buildHookSettings(
    { id: 'zai', settings: { permissions: { allow: ['Bash(ls:*)'] } } },
    0,
  );

  expect(settings['permissions']).toStrictEqual({ allow: ['Bash(ls:*)'] });
});

// A hooks block that is not one costs its own entries and none of atc's.
test('it keeps its own hooks when the configured ones are malformed', () => {
  const settings = buildHookSettings({ id: 'zai', settings: { hooks: 'all of them' } }, 0);
  const hooks = z.record(z.string(), z.unknown()).parse(settings['hooks']);

  expect(Object.keys(hooks)).toStrictEqual([
    'SessionStart',
    'Notification',
    'Stop',
    'UserPromptSubmit',
    'SessionEnd',
  ]);
});
