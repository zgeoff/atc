import type { AgentEntry } from '@atc/protocol';
import { faker } from '@faker-js/faker';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

type ListedAgentOverrides = MockOverrides<AgentEntry, keyof AgentEntry>;

/**
 * An agent as the `agents.list` answer shows it: a Claude agent that is not
 * installed, so it cannot start a session, with no models and no supported
 * spawn options. The id and label are arbitrary. Overrides merge into fresh
 * defaults at every depth.
 */
export function buildMockListedAgent(overrides: ListedAgentOverrides = {}): AgentEntry {
  return mergeDeep<AgentEntry, keyof AgentEntry>(
    {
      id: faker.string.alpha({ length: 8, casing: 'lower' }),
      label: faker.company.name(),
      kind: 'claude',
      installed: false,
      brokerAuth: false,
      brokerRequired: false,
      capabilities: {
        spawn: false,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: buildUnsupportedOption(),
        effort: buildUnsupportedOption(),
      },
    },
    overrides,
  );
}

function buildUnsupportedOption(): AgentEntry['spawnOptions']['model'] {
  return {
    supported: false,
    values: null,
    examples: [],
    default: null,
    backendEffect: null,
    note: null,
    available: false,
  };
}
