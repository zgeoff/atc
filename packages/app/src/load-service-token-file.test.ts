import { expect, test } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_TOKEN_FILE_ACCESS } from '@atc/config/token-file';
import { setupTempDir } from '@atc/test-utils';
import { loadServiceTokenFile } from './load-service-token-file';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-service-token-file-');

  return { directory: temporaryDirectory.path };
}

test('it loads a file only its owner can open', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'service-tokens.json');

  const file = {
    resource: 'https://atc.example.com/mcp',
    clients: { ci: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`] } },
  };

  writeFileSync(path, JSON.stringify(file), { mode: 0o600 });

  expect(loadServiceTokenFile(path, NODE_TOKEN_FILE_ACCESS)).toStrictEqual({
    ok: true,
    file: {
      resource: 'https://atc.example.com/mcp',
      clients: [{ name: 'ci', scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`] }],
    },
  });
});

test('it refuses a file that other users can open', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'service-tokens.json');

  writeFileSync(path, '{}');
  chmodSync(path, 0o644);

  expect(loadServiceTokenFile(path, NODE_TOKEN_FILE_ACCESS)).toStrictEqual({
    ok: false,
    reason: `other users can open ${path} (mode 644); run chmod 600 ${path}`,
  });
});

test('it refuses a file that belongs to another user', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'service-tokens.json');

  writeFileSync(path, '{}', { mode: 0o600 });

  const loaded = loadServiceTokenFile(path, {
    ...NODE_TOKEN_FILE_ACCESS,
    readUserID: () => NODE_TOKEN_FILE_ACCESS.readUserID() + 1,
  });

  expect(loaded).toStrictEqual({
    ok: false,
    reason: `${path} belongs to another user; give it to this user, then run chmod 600 ${path}`,
  });
});

test('it refuses a file that does not exist', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'missing.json');

  expect(loadServiceTokenFile(path, NODE_TOKEN_FILE_ACCESS)).toStrictEqual({
    ok: false,
    reason: expect.toStartWith(`cannot read ${path}:`),
  });
});

test('it names the file and the fault when the content is wrong, without quoting a token', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'service-tokens.json');

  writeFileSync(path, `atcs_${'a'.repeat(32)} is not json`, { mode: 0o600 });

  expect(loadServiceTokenFile(path, NODE_TOKEN_FILE_ACCESS)).toStrictEqual({
    ok: false,
    reason: `${path}: the file is not valid JSON`,
  });
});
