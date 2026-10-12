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
    configSchema: z.object({ roots: z.array(z.string()) }),
    create: () => source,
  };

  expect(definePlugin(definition)).toBe(definition);
});

test('it creates the contract from a parsed config slice and the host services', () => {
  const source: SourceProvider = {
    id: 'dirs',
    label: 'Directories',
    kind: 'path',
    list: mock(),
    interpret: mock(),
  };

  const create = mock(() => source);
  const configSchema = z.object({ roots: z.array(z.string()) });
  const plugin = definePlugin({ kind: 'source', id: 'dirs', configSchema, create });

  const host = {
    atcArgv: ['/opt/atc/bin/atc'],
    version: '1.2.3',
    build: '1.2.3+42',
    runCommand: mock(),
    clock: systemClock,
    log: mock(),
  };

  const config = plugin.configSchema.parse({ roots: ['/src', '/work'] });
  const created = plugin.create(config, host);

  expect(created).toBe(source);
  expect(create).toHaveBeenCalledExactlyOnceWith({ roots: ['/src', '/work'] }, host);
});
