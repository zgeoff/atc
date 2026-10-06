import { expect, test } from 'bun:test';
import { parseConfig } from '../src/shared/config';
import { getAgentEntry } from './get-agent-entry';

test('it returns the entry a config holds under an id', () => {
  const config = parseConfig({ grokBin: 'my-grok' });

  expect(getAgentEntry(config, 'grok')).toStrictEqual({
    id: 'grok',
    kind: 'grok',
    label: 'Grok',
    mark: 'g',
    bin: 'my-grok',
    args: [],
    env: {},
  });
});

test('it throws naming the id when the config holds no such agent', () => {
  const config = parseConfig({ agents: { claude: {} } });

  expect(() => getAgentEntry(config, 'codex')).toThrowWithMessage(
    Error,
    "the config holds no agent 'codex'",
  );
});
