import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { setupTempDir } from './setup-temp-dir';

interface TestCertificate {
  // PEM text of a self-signed certificate that names the host.
  readonly cert: string;
  readonly key: string;
}

// A certificate for a TLS server in a test, made with the openssl CLI, since
// neither Bun nor node:crypto writes an X.509 certificate.
export async function createTestCertificate(hostname: string): Promise<TestCertificate> {
  const temporaryDirectory = setupTempDir('atc-test-certificate-');
  const certPath = join(temporaryDirectory.path, 'cert.pem');
  const keyPath = join(temporaryDirectory.path, 'key.pem');

  await $`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj ${`/CN=${hostname}`} -addext ${`subjectAltName=DNS:${hostname}`} -keyout ${keyPath} -out ${certPath}`.quiet();

  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}
