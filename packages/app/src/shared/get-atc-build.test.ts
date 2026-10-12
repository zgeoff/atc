import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBuild } from '@atc/config/get-build';
import pkg from '../../package.json';
import { getATCBuild } from './get-atc-build';

test('it stamps the app version with every workspace package src tree of the checkout', () => {
  const manifest = fileURLToPath(import.meta.resolve('../../package.json'));
  const packagesDir = dirname(dirname(manifest));
  const roots = readdirSync(packagesDir).map((name) => join(packagesDir, name, 'src'));

  expect(getATCBuild()).toBe(getBuild({ version: pkg.version, roots }));
});
