import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PASSKEY_SCRIPT } from './passkey-script';

test('it allows exactly its own source by hash', () => {
  expect(PASSKEY_SCRIPT.policySource).toBe(
    `'sha256-${createHash('sha256').update(PASSKEY_SCRIPT.source).digest('base64')}'`,
  );
});

test('it parses as a script', () => {
  const transpiler = new Bun.Transpiler({ loader: 'js' });

  expect(() => transpiler.transformSync(PASSKEY_SCRIPT.source)).not.toThrow();
});
