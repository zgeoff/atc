import { expect, test } from 'bun:test';
import { buildMockAgentProfile } from './build-mock-agent-profile';

test('it builds a default agent profile', () => {
  expect(buildMockAgentProfile()).toStrictEqual({
    label: expect.toBeString(),
    kind: 'claude',
    bin: expect.toStartWith('/'),
    models: null,
    spawnOptions: {
      model: {
        supported: false,
        values: null,
        examples: [],
        default: null,
        backendEffect: null,
        note: null,
      },
      effort: {
        supported: false,
        values: null,
        examples: [],
        default: null,
        backendEffect: null,
        note: null,
      },
    },
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockAgentProfile({
      label: 'Claude on the box',
      bin: 'sleep',
      spawnOptions: { effort: { supported: true } },
    }),
  ).toMatchObject({
    label: 'Claude on the box',
    kind: 'claude',
    bin: 'sleep',
    spawnOptions: {
      model: { supported: false },
      effort: { supported: true, values: null },
    },
  });
});
