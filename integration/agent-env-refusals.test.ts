import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';

test.each([
  ['claude', 'HTTPS_PROXY'],
  ['codex', 'HTTPS_PROXY'],
  ['claude', 'NODE_EXTRA_CA_CERTS'],
  ['codex', 'NODE_EXTRA_CA_CERTS'],
])('it leaves out a %s entry with auth whose env sets %s', (agent, variable) => {
  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    authProfiles: {
      claude: {
        secret: 'claude-subscription',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: { [agent]: { auth: { profiles: [agent] }, env: { [variable]: 'set-by-hand' } } },
  });

  expect({ agents: config.agents, problems: config.agentErrors }).toStrictEqual({
    agents: [],
    problems: [
      `agents.${agent}: env must not set ${variable}, which would override or route around the subscription sign-in`,
    ],
  });
});
