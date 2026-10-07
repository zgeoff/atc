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
    ['/usr/local/bin/atc'],
  );

  expect(settings).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/usr/local/bin/atc" statusline --agent \'zai\'',
      padding: 0,
    },
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    apiKeyHelper: '~/.local/bin/atc-zai-key',
  });
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

  expect(settings).toContainAllKeys(['hooks', 'statusLine']);
});

test('it leaves out an env block that was given with nothing in it', () => {
  expect(buildHookSettings({ id: 'zai', env: {} }, 0)).not.toContainKey('env');
});

test('it reports every hook the fleet needs to track a session', () => {
  const settings = buildHookSettings({ id: 'claude' }, 0);

  expect(settings['hooks']).toContainAllKeys([
    'SessionStart',
    'Notification',
    'Stop',
    'UserPromptSubmit',
    'SessionEnd',
  ]);
});

test('it mirrors the padding of the statusline it chains', () => {
  expect(
    buildHookSettings({ id: 'claude' }, 3, ['/usr/local/bin/atc'])['statusLine'],
  ).toStrictEqual({
    type: 'command',
    command: '"/usr/local/bin/atc" statusline --agent \'claude\'',
    padding: 3,
  });
});

test('it registers a configured hook on an event of its own', () => {
  const entry = { matcher: '.*', hooks: [{ type: 'command', command: 'classify-tool-call' }] };

  const settings = buildHookSettings(
    { id: 'zai', settings: { hooks: { PermissionRequest: [entry] } } },
    0,
  );

  expect(settings['hooks']).toContainEntry(['PermissionRequest', [entry]]);
});

// The fleet stops tracking a session whose reporter was replaced, so a
// configured hook on an event atc uses runs beside it rather than instead.
test('it runs its own reporter before a configured hook on the same event', () => {
  const entry = { hooks: [{ type: 'command', command: 'say-hello' }] };

  const settings = buildHookSettings({ id: 'zai', settings: { hooks: { Stop: [entry] } } }, 0, [
    '/usr/local/bin/atc',
  ]);

  expect(settings['hooks']).toContainEntry([
    'Stop',
    [
      {
        hooks: [
          {
            type: 'command',
            command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
            timeout: 5,
          },
        ],
      },
      entry,
    ],
  ]);
});

test('it keeps its own value for a key the configured settings also name', () => {
  const settings = buildHookSettings(
    {
      id: 'zai',
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
      settings: { env: { ANTHROPIC_BASE_URL: 'https://example.invalid' }, statusLine: 'mine' },
    },
    0,
    ['/usr/local/bin/atc'],
  );

  expect({ env: settings['env'], statusLine: settings['statusLine'] }).toStrictEqual({
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    statusLine: {
      type: 'command',
      command: '"/usr/local/bin/atc" statusline --agent \'zai\'',
      padding: 0,
    },
  });
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

  expect(settings['hooks']).toContainAllKeys([
    'SessionStart',
    'Notification',
    'Stop',
    'UserPromptSubmit',
    'SessionEnd',
  ]);
});

test('it gives every command it registers the agent id of its session', () => {
  const settings = buildHookSettings({ id: 'zai' }, 0, ['/usr/local/bin/atc']);

  expect(settings).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/usr/local/bin/atc" hook-report --agent \'zai\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/usr/local/bin/atc" statusline --agent \'zai\'',
      padding: 0,
    },
  });
});
