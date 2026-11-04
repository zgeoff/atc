import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATEWAY_VERSION } from './gateway-version';

test("it holds the version of the gateway package's own manifest", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
  );

  expect(manifest).toContainEntry(['version', GATEWAY_VERSION]);
});
