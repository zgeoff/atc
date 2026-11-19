import { expect, test } from 'bun:test';
import { updateEnv } from '@atc/core/test-utils/update-env';
import { createVerifyRegistry } from './create-verify-registry.ts';

test('it uploads the evidence of the launch targets to the file host and keeps the prod evidence local', () => {
  const registry = createVerifyRegistry();

  expect(registry.targets.get('local')?.evidence).toBe('upload');
  expect(registry.targets.get('docker')?.evidence).toBe('upload');
  expect(registry.targets.get('prod')?.evidence).toBe('local');
});

test('it reads the file host and its token from the variables the verify skill tells agents to set', () => {
  updateEnv('VERIFY_UPLOAD_URL', 'https://files.example.test/api/files');
  updateEnv('VERIFY_UPLOAD_TOKEN', 'test-upload-token');

  const uploader = createVerifyRegistry().hooks.upload;

  expect(uploader?.linkHosts).toStrictEqual(['files.example.test']);

  expect(uploader?.readSecrets?.()).toStrictEqual([
    { name: 'VERIFY_UPLOAD_TOKEN', value: 'test-upload-token', origin: 'collected' },
  ]);
});
