import { expect, test } from 'bun:test';
import { buildMockListedAgent } from './build-mock-listed-agent';

test('it builds a default listed agent', () => {
  expect(buildMockListedAgent()).toStrictEqual({
    id: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    label: expect.toBeString(),
    kind: 'claude',
    installed: false,
    brokerAuth: false,
    brokerRequired: false,
    spawnTargets: [],
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
      model: {
        supported: false,
        values: null,
        examples: [],
        default: null,
        backendEffect: null,
        note: null,
        available: false,
      },
      effort: {
        supported: false,
        values: null,
        examples: [],
        default: null,
        backendEffect: null,
        note: null,
        available: false,
      },
    },
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockListedAgent({
      id: 'codex',
      kind: 'codex',
      installed: true,
      capabilities: { spawn: true },
      spawnOptions: { effort: { supported: true, available: true } },
    }),
  ).toMatchObject({
    id: 'codex',
    kind: 'codex',
    installed: true,
    capabilities: {
      spawn: true,
      readTranscript: false,
      message: false,
      attach: true,
      screen: true,
      input: true,
    },
    spawnOptions: {
      model: { supported: false, available: false },
      effort: { supported: true, available: true, values: null },
    },
  });
});
