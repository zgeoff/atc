import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockExecutionHostServices } from '@atc/plugin-api/test-utils/build-mock-execution-host-services';
import { SPRITES_PLUGIN } from './sprites-plugin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'atc-sprites-plugin-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directory,
    create: (options: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
      SPRITES_PLUGIN.create({ id: 'box', options, env }, buildMockExecutionHostServices(), {
        authProfiles: new Map(),
      }),
  };
}

test('it lists the target as unavailable when the daemon runs from source', () => {
  const ctx = setupTest();

  expect(() =>
    ctx.create({ tokenEnv: 'SPRITES_TOKEN' }, { SPRITES_TOKEN: 'org/id/secret' }),
  ).toThrow(
    expect.objectContaining({ problem: expect.stringContaining('compiled_binary_required') }),
  );
});

test('it lists the target as unavailable, naming the variable, when the token variable is unset', () => {
  const ctx = setupTest();

  expect(() => ctx.create({ tokenEnv: 'SPRITES_TOKEN' })).toThrow(
    expect.objectContaining({ problem: expect.stringContaining('SPRITES_TOKEN') }),
  );
});

test('it lists the target as unavailable, naming the variable, when the token variable is empty', () => {
  const ctx = setupTest();

  expect(() => ctx.create({ tokenEnv: 'SPRITES_TOKEN' }, { SPRITES_TOKEN: '' })).toThrow(
    expect.objectContaining({ problem: expect.stringContaining('SPRITES_TOKEN') }),
  );
});

test('it lists the target as unavailable, naming the file, when the token file cannot be read', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'missing.token');

  expect(() => ctx.create({ tokenFile: path })).toThrow(
    expect.objectContaining({ problem: expect.stringContaining(path) }),
  );
});

test('it lists the target as unavailable, naming the file, when the token file is empty', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'empty.token');

  writeFileSync(path, '\n');

  expect(() => ctx.create({ tokenFile: path })).toThrow(
    expect.objectContaining({ problem: expect.stringContaining(path) }),
  );
});

test('it never puts the token in the problem of an unavailable target', () => {
  const ctx = setupTest();

  expect(() =>
    ctx.create({ tokenEnv: 'SPRITES_TOKEN' }, { SPRITES_TOKEN: 'org/id/secret' }),
  ).toThrow(expect.objectContaining({ problem: expect.not.stringContaining('org/id/secret') }));
});

test('it lists the target as unavailable when both token keys are set', () => {
  const ctx = setupTest();

  expect(() => ctx.create({ tokenEnv: 'A', tokenFile: '/a' })).toThrow(
    expect.objectContaining({ problem: expect.stringContaining('exactly one of tokenEnv') }),
  );
});

test('it reports a config with neither token key in full through its schema', () => {
  const schema = SPRITES_PLUGIN.configSchema({
    authProfiles: new Map(),
    entryID: 'box',
    foreignFields: new Set(),
  });

  const parsed = schema.safeParse({ id: 'box', options: {}, env: {} });

  expect(parsed.error?.issues.map((issue) => issue.message)).toStrictEqual([
    'target "box" must give exactly one of tokenEnv and tokenFile',
  ]);
});

test('it takes the five keys of a sprites target', () => {
  expect(SPRITES_PLUGIN.configFields).toStrictEqual([
    'tokenEnv',
    'tokenFile',
    'spritePrefix',
    'apiURL',
    'guestDir',
  ]);
});
