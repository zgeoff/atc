import { expect, test } from 'bun:test';
import { createVerifyRegistry } from './create-verify-registry.ts';

test('it uploads the evidence of the launch targets to the file host and keeps the prod evidence local', () => {
  const registry = createVerifyRegistry();

  expect(registry.targets.get('local')?.evidence).toBe('upload');
  expect(registry.targets.get('docker')?.evidence).toBe('upload');
  expect(registry.targets.get('prod')?.evidence).toBe('local');
  expect(registry.hooks.upload).toBeDefined();
});
