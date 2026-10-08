import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildMigratedConfig } from './build-migrated-config';
import { parseConfig } from './shared/config';
import { getRecord } from './shared/get-record';

test('it replaces the old keys with agents at the position of the first one', () => {
  const result = buildMigratedConfig({
    leader: 'ctrl-a',
    claudeBin: '/opt/claude',
    dirs: { roots: ['/w'] },
    grokArgs: ['--yolo'],
  });

  expect(result).toStrictEqual({
    kind: 'migrated',
    text: `${JSON.stringify(
      {
        leader: 'ctrl-a',
        agents: {
          claude: { bin: '/opt/claude' },
          grok: { args: ['--yolo'] },
          codex: {},
        },
        dirs: { roots: ['/w'] },
      },
      null,
      2,
    )}\n`,
    notes: [],
  });
});

test('it appends agents when the file sets no old key', () => {
  expect(buildMigratedConfig({ leader: 'ctrl-a' })).toStrictEqual({
    kind: 'migrated',
    text: `${JSON.stringify({ leader: 'ctrl-a', agents: { claude: {}, grok: {}, codex: {} } }, null, 2)}\n`,
    notes: [],
  });
});

test('it writes a gateway that inherited the claude bin and args with them', () => {
  const result = buildMigratedConfig({
    claudeBin: '/opt/claude',
    claudeArgs: ['--verbose'],
    gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic', label: 'GLM', mark: 'x' } },
  });

  invariant(result.kind === 'migrated', 'expected a migrated config');

  const migrated: unknown = JSON.parse(result.text);

  expect(getRecord(getRecord({ migrated }, 'migrated'), 'agents')['zai']).toStrictEqual({
    kind: 'claude',
    label: 'GLM',
    mark: 'x',
    bin: '/opt/claude',
    args: ['--verbose'],
    baseURL: 'https://api.z.ai/api/anthropic',
  });
});

test('it leaves out a dropped gateway and notes the reason without a value', () => {
  const result = buildMigratedConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'raw' },
    },
    gateways: {
      noURL: { label: 'x' },
      claude: { baseURL: 'https://one.example.com' },
      '': { baseURL: 'https://two.example.com' },
      glm: { baseURL: 'https://api.z.ai/api/anthropic', auth: { profiles: ['glm'] } },
      kept: { baseURL: 'https://kept.example.com', env: { TOKEN: 'sk-secret-value' } },
    },
  });

  invariant(result.kind === 'migrated', 'expected a migrated config');

  expect(result.notes).toStrictEqual([
    'atc config migrate: gateways.noURL is left out: it has no baseURL',
    'atc config migrate: gateways.claude is left out: its id is the built-in agent claude',
    'atc config migrate: gateways. is left out: its id is empty',
    'atc config migrate: gateways.glm is left out: profile glm is selected, but authProfiles has no usable profile by that name',
  ]);

  const migrated: unknown = JSON.parse(result.text);
  const agents = getRecord(getRecord({ migrated }, 'migrated'), 'agents');

  expect(Object.keys(agents)).toStrictEqual(['claude', 'grok', 'codex', 'kept']);
});

test('it parses the migrated config into the entries the old keys gave', () => {
  const legacy = {
    claudeBin: '/opt/claude',
    claudeArgs: ['--verbose'],
    claudeAuth: { profiles: ['claude'] },
    grokBin: 'my-grok',
    codexArgs: ['--search'],
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    gateways: {
      inherits: { baseURL: 'https://one.example.com' },
      own: {
        baseURL: 'https://two.example.com',
        bin: '/opt/other',
        args: ['--x'],
        label: 'Two',
        mark: 'T',
        env: { A: 'b' },
        settings: { model: 'opus' },
        apiKeyHelper: 'op read x',
      },
      glm: {
        baseURL: 'https://api.z.ai/api/anthropic',
        apiKeyHelper: 'op read glm',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
          args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode'],
        },
      },
    },
  };

  const result = buildMigratedConfig(legacy);

  invariant(result.kind === 'migrated', 'expected a migrated config');

  const written: unknown = JSON.parse(result.text);
  const migrated = parseConfig(written);

  expect({ agents: migrated.agents, errors: migrated.agentErrors }).toStrictEqual({
    agents: parseConfig(legacy).agents,
    errors: [],
  });
});

test("it carries claudeAuth's MCP servers into the migrated claude entry", () => {
  const legacy = {
    claudeAuth: {
      profiles: ['claude', 'linear'],
      mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', profile: 'linear' } },
    },
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      linear: {
        secret: 'linear-imp-agents',
        host: 'mcp.linear.app',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
  };

  const result = buildMigratedConfig(legacy);

  invariant(result.kind === 'migrated', 'expected a migrated config');

  const written: unknown = JSON.parse(result.text);
  const claude = getRecord(getRecord({ written }, 'written'), 'agents')['claude'];

  expect(claude).toStrictEqual({
    auth: {
      profiles: ['claude', 'linear'],
      mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', profile: 'linear' } },
    },
  });

  expect(parseConfig(written).agents).toStrictEqual(parseConfig(legacy).agents);
});

test('it reports a file that already uses agents as current', () => {
  expect(buildMigratedConfig({ agents: { claude: {} } })).toStrictEqual({ kind: 'current' });
});

test('it refuses a mixed file with the keys it found', () => {
  expect(buildMigratedConfig({ agents: {}, codexBin: 'x', gateways: {} })).toStrictEqual({
    kind: 'unusable',
    detail:
      "codexBin and gateways cannot be set together with agents; move them into agents or run 'atc config migrate'",
  });
});

test('it refuses a root that is not an object', () => {
  expect(buildMigratedConfig([])).toStrictEqual({
    kind: 'unusable',
    detail: 'the root is an array, not an object',
  });
});

test('it drops a removed key from a file that already uses agents and notes it', () => {
  const result = buildMigratedConfig({
    agents: { claude: {} },
    resumeInterruptedTurns: true,
    leader: 'ctrl-a',
  });

  expect(result).toStrictEqual({
    kind: 'migrated',
    text: `${JSON.stringify({ agents: { claude: {} }, leader: 'ctrl-a' }, null, 2)}\n`,
    notes: ['atc config migrate: resumeInterruptedTurns is dropped: atc no longer reads it'],
  });
});

test('it drops a removed key while it moves the old agent keys into agents', () => {
  const result = buildMigratedConfig({ claudeBin: '/opt/claude', resumeInterruptedTurns: false });

  expect(result).toStrictEqual({
    kind: 'migrated',
    text: `${JSON.stringify({ agents: { claude: { bin: '/opt/claude' }, grok: {}, codex: {} } }, null, 2)}\n`,
    notes: ['atc config migrate: resumeInterruptedTurns is dropped: atc no longer reads it'],
  });
});
