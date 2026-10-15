import { expect, test } from 'bun:test';
import { collectAgents } from '@atc/config';
import { buildMockHostServices } from '@atc/test-utils';
import { GrokAdapter } from './grok-adapter';
import { GROK_PLUGIN } from './grok-plugin';

test('it loads a grok entry on the defaults of its kind', () => {
  expect(collectAgents({ grok: {} }, new Map(), [GROK_PLUGIN])).toStrictEqual({
    agents: [
      { id: 'grok', kind: 'grok', label: 'Grok', mark: 'g', bin: 'grok', args: [], env: {} },
    ],
    errors: [],
  });
});

test('it refuses auth as an unknown field when no other plugin owns it', () => {
  expect(collectAgents({ grok: { auth: {} } }, new Map(), [GROK_PLUGIN])).toStrictEqual({
    agents: [],
    errors: ['agents.grok: unknown field auth'],
  });
});

test('it creates a grok adapter for an entry', () => {
  const adapter = GROK_PLUGIN.create(
    {
      entry: {
        id: 'grok-b',
        kind: 'grok',
        label: 'Grok B',
        mark: 'b',
        bin: 'grok',
        args: [],
        env: {},
      },
      warnings: [],
    },
    buildMockHostServices(),
    { authProfiles: new Map() },
  );

  expect(adapter).toBeInstanceOf(GrokAdapter);
  expect(adapter.id).toBe('grok-b');
});
