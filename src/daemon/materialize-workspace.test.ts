import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSessionID } from '../shared/to-session-id';
import { materializeWorkspace } from './materialize-workspace';

test('it leaves no staging directory behind when the materialization row cannot be written', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'atc-materialize-'));
  const previous = process.env['TMPDIR'];

  // Every staging directory the call makes lands in a directory of its own.
  process.env['TMPDIR'] = scratch;

  onTestFinished(() => {
    const restored = previous === undefined ? {} : { TMPDIR: previous };

    delete process.env['TMPDIR'];
    Object.assign(process.env, restored);

    rmSync(scratch, { recursive: true, force: true });
  });

  const materialized = materializeWorkspace(
    {
      sessionID: toSessionID('s-1'),
      target: 'box',
      dir: join(scratch, 'ws'),
      source: { kind: 'git', url: 'https://example.com/repo.git', ref: 'main' },
      inPlace: false,
    },
    {
      requireProvider: () => {
        throw new Error('no provider call is expected');
      },
      store: {
        createMaterialization: () => Promise.reject(new Error('the store is unavailable')),
        updateMaterialization: () => Promise.resolve(),
      },
      log: () => {},
    },
  );

  expect(materialized).rejects.toThrow('the store is unavailable');

  await materialized.catch(() => null);

  expect(readdirSync(scratch)).toStrictEqual([]);
});
