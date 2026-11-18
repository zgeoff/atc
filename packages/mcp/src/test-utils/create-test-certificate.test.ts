import { expect, test } from 'bun:test';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { createTestCertificate } from './create-test-certificate';

test('it makes a certificate that names the host and a key that matches it', async () => {
  const certificate = await createTestCertificate('hooks.example.test');

  const parsed = new X509Certificate(certificate.cert);

  expect(parsed.checkHost('hooks.example.test')).toBe('hooks.example.test');
  expect(parsed.checkHost('other.example.test')).toBeUndefined();
  expect(parsed.checkPrivateKey(createPrivateKey(certificate.key))).toBeTrue();
});
