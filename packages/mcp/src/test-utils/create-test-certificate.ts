import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { $ } from 'bun';

interface TestCertificate {
  readonly cert: string;
  readonly key: string;
}

// Shells out to openssl because neither Bun nor node:crypto can create an X.509 certificate.
export async function createTestCertificate(hostname: string): Promise<TestCertificate> {
  const temporaryDirectory = createTempDir('atc-test-certificate-');
  const certPath = join(temporaryDirectory.path, 'cert.pem');
  const keyPath = join(temporaryDirectory.path, 'key.pem');

  await $`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj ${`/CN=${hostname}`} -addext ${`subjectAltName=DNS:${hostname}`} -keyout ${keyPath} -out ${certPath}`.quiet();

  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}
