import { expect, mock, test } from 'bun:test';
import { createTestCertificate } from './create-test-certificate';
import { makeTrustingTransport } from './make-trusting-transport';
import { registerTestCleanup } from './register-test-cleanup';

test('it reaches a server whose self-signed certificate it trusts', async () => {
  const certificate = await createTestCertificate('localhost');

  const answerRequest = mock(() => new Response('trusted'));

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: certificate.cert, key: certificate.key },
    fetch: answerRequest,
  });

  registerTestCleanup(() => server.stop(true));

  const response = await makeTrustingTransport(certificate.cert)(
    `https://localhost:${server.port}/`,
    { tls: { serverName: 'localhost' } },
  );

  const text = await response.text();

  expect(text).toBe('trusted');
});

test('it keeps the TLS checks the request sets', async () => {
  const certificate = await createTestCertificate('localhost');

  const answerRequest = mock(() => new Response('trusted'));

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: certificate.cert, key: certificate.key },
    fetch: answerRequest,
  });

  registerTestCleanup(() => server.stop(true));

  const answered = makeTrustingTransport(certificate.cert)(`https://localhost:${server.port}/`, {
    tls: {
      checkServerIdentity: () => new Error('the request refuses every certificate'),
    },
  });

  expect(answered).rejects.toThrow();
});
