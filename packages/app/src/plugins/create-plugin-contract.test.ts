import { expect, test } from 'bun:test';
import { definePlugin } from '@atc/plugin-api';
import { buildGitSource } from '@atc/source-git';
import { buildMockHostServices } from '@atc/test-utils';
import { z } from 'zod';
import { createPluginContract } from './create-plugin-contract';

test('it passes the parsed slice, the host, and the context to the factory', () => {
  const host = buildMockHostServices();
  const context = { authProfiles: new Map() };
  const seen: unknown[] = [];

  createPluginContract({
    plugin: definePlugin({
      kind: 'source',
      id: 'probe',
      configFields: ['count'],
      configSchema: () => z.object({ count: z.coerce.number() }),
      create: (config, created, given) => {
        seen.push(config, created, given);

        return buildGitSource();
      },
    }),
    raw: { count: '3' },
    entryID: 'probe',
    host,
    context,
  });

  expect(seen).toStrictEqual([{ count: 3 }, host, context]);
});

test('it throws for a slice the plugin schema refuses', () => {
  expect(() =>
    createPluginContract({
      plugin: definePlugin({
        kind: 'source',
        id: 'probe',
        configFields: [],
        configSchema: () => z.object({ count: z.number() }),
        create: () => buildGitSource(),
      }),
      raw: {},
      entryID: 'probe',
      host: buildMockHostServices(),
      context: { authProfiles: new Map() },
    }),
  ).toThrow();
});
