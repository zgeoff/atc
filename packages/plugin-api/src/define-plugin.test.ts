import { expect, mock, test } from 'bun:test';
import { systemClock } from '@atc/core/system-clock';
import { z } from 'zod';
import { definePlugin } from './define-plugin';
import type { SourceProvider } from './types';

test('it returns the definition it checks unchanged', () => {
  const source: SourceProvider = {
    id: 'dirs',
    label: 'Directories',
    kind: 'path',
    list: mock(),
    interpret: mock(),
  };

  const definition = {
    kind: 'source' as const,
    id: 'dirs',
    configFields: ['roots'],
    configSchema: () => z.object({ roots: z.array(z.string()) }),
    create: () => source,
  };

  expect(definePlugin(definition)).toBe(definition);
});

test('it creates the contract from a slice parsed in its context, the host services, and the plugin context', () => {
  const source: SourceProvider = {
    id: 'dirs',
    label: 'Directories',
    kind: 'path',
    list: mock(),
    interpret: mock(),
  };

  const create = mock(() => source);

  const plugin = definePlugin({
    kind: 'source',
    id: 'dirs',
    configFields: ['roots'],
    configSchema: (context) =>
      z.object({ roots: z.array(z.string()) }).transform((slice) => ({
        ...slice,
        entryID: context.entryID,
      })),
    create,
  });

  const host = {
    atcArgv: ['/opt/atc/bin/atc'],
    version: '1.2.3',
    build: '1.2.3+42',
    runCommand: mock(),
    clock: systemClock,
    log: mock(),
  };

  const context = { authProfiles: new Map(), entryID: 'dirs', foreignFields: new Set<string>() };
  const config = plugin.configSchema(context).parse({ roots: ['/src', '/work'] });
  const created = plugin.create(config, host, context);

  expect(created).toBe(source);

  expect(create).toHaveBeenCalledExactlyOnceWith(
    { roots: ['/src', '/work'], entryID: 'dirs' },
    host,
    context,
  );
});
